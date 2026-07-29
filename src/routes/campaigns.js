/**
 * Admin routes: Web Chat + Bulk Campaigns
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAdmin } = require('../middleware/auth');
const {
  Settings,
  MessageLog,
  CampaignContacts,
  Campaigns,
  CampaignRecipients,
  CampaignSteps,
} = require('../models');
const { ensureMediaDir } = require('../models/campaigns');
const {
  parsePastedText,
  parseCsvBuffer,
  parseExcelBuffer,
  contactsToCsv,
  applyCountryCodeToRows,
} = require('../utils/contactImport');
const whatsapp = require('../services/whatsapp');
const { getCampaignRunner } = require('../services/campaignRunner');

const router = express.Router();

function layoutLocals(req, extra = {}) {
  const flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  return {
    businessName: Settings.get('business_name', 'SecureLife Insurance'),
    admin: req.session.adminUsername || null,
    flash,
    reqPath: req.originalUrl ? String(req.originalUrl).split('?')[0] : req.path || '',
    ...extra,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, ensureMediaDir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '.jpg';
      cb(null, `camp-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image uploads allowed'));
  },
});

// ——— Web Chat ———

router.get('/admin/web-chat', requireAdmin, (req, res) => {
  const conversations = MessageLog.conversations(100);
  const phone = String(req.query.phone || '').replace(/\D/g, '');
  const thread = phone ? MessageLog.thread(phone, 250) : [];
  res.render(
    'admin/web-chat',
    layoutLocals(req, {
      title: 'Web Chat',
      conversations,
      activePhone: phone || null,
      thread,
      waReady: !!(whatsapp.ready && whatsapp.client),
    })
  );
});

router.get('/api/web-chat/conversations', requireAdmin, (req, res) => {
  res.json({ ok: true, conversations: MessageLog.conversations(100) });
});

router.get('/api/web-chat/thread/:phone', requireAdmin, (req, res) => {
  const phone = String(req.params.phone || '').replace(/\D/g, '');
  res.json({ ok: true, phone, messages: MessageLog.thread(phone, 250) });
});

router.post('/api/web-chat/send', requireAdmin, async (req, res) => {
  try {
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    const text = String(req.body.text || '').trim();
    if (!phone || phone.length < 8) {
      return res.status(400).json({ ok: false, message: 'Invalid phone' });
    }
    if (!text) {
      return res.status(400).json({ ok: false, message: 'Message required' });
    }
    if (!whatsapp.ready) {
      return res
        .status(503)
        .json({ ok: false, message: 'WhatsApp not connected' });
    }
    await whatsapp.sendMessage(phone, text, {
      skipPacing: false,
      lane: 'bulk',
      priority: 'low',
    });
    // sendMessage already writes MessageLog — emit for live UI only
    whatsapp.emit('webchat:message', {
      phone,
      direction: 'out',
      body: text,
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WebChat] send failed:', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ——— Contacts ———

router.get('/admin/campaigns/contacts', requireAdmin, (req, res) => {
  const q = String(req.query.q || '');
  const contacts = CampaignContacts.list({ q, limit: 500 });
  res.render(
    'admin/campaign-contacts',
    layoutLocals(req, {
      title: 'Campaign Contacts',
      contacts,
      q,
      total: CampaignContacts.count(q),
    })
  );
});

router.post(
  '/admin/campaigns/contacts/import',
  requireAdmin,
  upload.single('file'),
  (req, res) => {
    try {
      let rows = [];
      if (req.file?.buffer) {
        const name = String(req.file.originalname || '').toLowerCase();
        if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
          rows = parseExcelBuffer(req.file.buffer);
        } else {
          rows = parseCsvBuffer(req.file.buffer);
        }
      } else if (req.body.paste) {
        rows = parsePastedText(req.body.paste);
      }
      if (!rows.length) {
        req.session.flash = {
          type: 'error',
          message: 'No valid contacts found in import.',
        };
        return res.redirect('/admin/campaigns/contacts');
      }
      const stats = CampaignContacts.upsertMany(rows, 'import');
      req.session.flash = {
        type: 'success',
        message: `Imported: ${stats.inserted} new, ${stats.updated} updated, ${stats.skipped} skipped.`,
      };
    } catch (err) {
      req.session.flash = { type: 'error', message: err.message };
    }
    res.redirect('/admin/campaigns/contacts');
  }
);

router.post('/admin/campaigns/contacts/add', requireAdmin, (req, res) => {
  try {
    CampaignContacts.upsert({
      name: req.body.name,
      phone: req.body.phone,
      tags: req.body.tags,
      source: 'manual',
    });
    req.session.flash = { type: 'success', message: 'Contact saved.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/campaigns/contacts');
});

router.post(
  '/admin/campaigns/contacts/:id/delete',
  requireAdmin,
  (req, res) => {
    CampaignContacts.remove(Number(req.params.id));
    req.session.flash = { type: 'success', message: 'Contact deleted.' };
    res.redirect('/admin/campaigns/contacts');
  }
);

router.get('/admin/campaigns/contacts/export.csv', requireAdmin, (req, res) => {
  const contacts = CampaignContacts.list({ limit: 10000 });
  const csv = contactsToCsv(contacts);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="campaign-contacts.csv"'
  );
  res.send(csv);
});

// ——— Campaigns ———

router.get('/admin/campaigns', requireAdmin, (req, res) => {
  const campaigns = Campaigns.list(50);
  res.render(
    'admin/campaigns',
    layoutLocals(req, {
      title: 'Bulk Campaigns',
      campaigns,
      contactCount: CampaignContacts.count(),
      waReady: !!(whatsapp.ready && whatsapp.client),
    })
  );
});

router.get('/admin/campaigns/new', requireAdmin, (req, res) => {
  res.render(
    'admin/campaign-edit',
    layoutLocals(req, {
      title: 'New Campaign',
      campaign: null,
      contactCount: CampaignContacts.count(),
      libraryContacts: CampaignContacts.list({ limit: 2000 }),
      waReady: !!(whatsapp.ready && whatsapp.client),
    })
  );
});

router.get('/admin/campaigns/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const campaign = Campaigns.get(id);
  if (!campaign) {
    req.session.flash = { type: 'error', message: 'Campaign not found.' };
    return res.redirect('/admin/campaigns');
  }
  const stats = Campaigns.stats(id);
  const recipients = CampaignRecipients.listByCampaign(id, { limit: 200 });
  const steps = CampaignSteps.listByCampaign(id);
  res.render(
    'admin/campaign-detail',
    layoutLocals(req, {
      title: campaign.name,
      campaign,
      stats,
      recipients,
      steps,
      waReady: !!(whatsapp.ready && whatsapp.client),
    })
  );
});

router.post(
  '/admin/campaigns',
  requireAdmin,
  (req, res, next) => {
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'contacts_file', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'error', message: err.message };
        return res.redirect('/admin/campaigns/new');
      }
      next();
    });
  },
  (req, res) => {
    try {
      const body_text = String(req.body.body_text || '').trim();
      if (!body_text) {
        req.session.flash = { type: 'error', message: 'Message text required.' };
        return res.redirect('/admin/campaigns/new');
      }

      const content_type =
        req.body.content_type === 'image_text' ? 'image_text' : 'text';
      const imageFile = req.files?.image?.[0] || null;
      if (content_type === 'image_text' && !imageFile) {
        req.session.flash = {
          type: 'error',
          message: 'Image required for Text with Image campaigns.',
        };
        return res.redirect('/admin/campaigns/new');
      }

      const {
        pacingFromMsgsPerMinute,
        hourlyCapFromLimit,
      } = require('../services/campaignRunner');

      const msgsPerWindow = Number(req.body.msgs_per_window || req.body.msgs_per_minute);
      const windowMinutes = Number(req.body.speed_window_minutes) || 1;
      const pacing = pacingFromMsgsPerMinute(msgsPerWindow, windowMinutes);
      const hourlyRaw =
        Number(req.body.hourly_limit) ||
        Math.ceil(pacing.msgs_per_minute * 60);
      const cap = hourlyCapFromLimit(hourlyRaw);

      const qrLabels = []
        .concat(req.body.qr_label || [])
        .map((l) => String(l || '').trim())
        .filter(Boolean);
      const useQuickReplies = req.body.use_quick_replies === '1';
      const countryCode = String(req.body.country_code || '91').trim();

      // Persist image from memory upload
      let image_path = null;
      let image_mimetype = null;
      let image_filename = null;
      if (imageFile?.buffer) {
        if (!/^image\//i.test(String(imageFile.mimetype || ''))) {
          req.session.flash = {
            type: 'error',
            message: 'Only image uploads allowed for Text with Image.',
          };
          return res.redirect('/admin/campaigns/new');
        }
        const dir = ensureMediaDir();
        const ext =
          path.extname(imageFile.originalname || '') ||
          (String(imageFile.mimetype || '').includes('png') ? '.png' : '.jpg');
        image_filename = imageFile.originalname || `image${ext}`;
        image_mimetype = imageFile.mimetype || 'image/jpeg';
        image_path = path.join(dir, `camp-${Date.now()}${ext}`);
        fs.writeFileSync(image_path, imageFile.buffer);
      }

      // Prefer live preview JSON (already country-coded); else file + paste
      let importRows = [];
      const contactsJson = String(req.body.contacts_json || '').trim();
      if (contactsJson) {
        try {
          const parsed = JSON.parse(contactsJson);
          if (Array.isArray(parsed)) {
            importRows = parsed
              .map((r) => ({
                name: r.name || null,
                phone: String(r.phone || '').replace(/\D/g, ''),
              }))
              .filter((r) => r.phone && r.phone.length >= 8);
          }
        } catch (_) {}
      }

      if (!importRows.length) {
        const contactsFile = req.files?.contacts_file?.[0] || null;
        if (contactsFile?.buffer) {
          const name = String(contactsFile.originalname || '').toLowerCase();
          if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
            importRows = importRows.concat(parseExcelBuffer(contactsFile.buffer));
          } else {
            importRows = importRows.concat(parseCsvBuffer(contactsFile.buffer));
          }
        }
        const paste = String(req.body.paste_phones || '').trim();
        if (paste) {
          importRows = importRows.concat(parsePastedText(paste));
        }
        importRows = applyCountryCodeToRows(importRows, countryCode);
      }

      let importStats = { inserted: 0, updated: 0, skipped: 0 };
      if (importRows.length) {
        importStats = CampaignContacts.upsertMany(importRows, 'campaign');
      }

      // Recipients: preview/import rows, else all library contacts with country code
      let recipientSource;
      if (importRows.length) {
        const seen = new Set();
        recipientSource = [];
        for (const row of importRows) {
          const phone = String(row.phone || '').replace(/\D/g, '');
          if (!phone || phone.length < 8 || seen.has(phone)) continue;
          seen.add(phone);
          recipientSource.push({
            id: CampaignContacts.findByPhone(phone)?.id || null,
            name: row.name || null,
            phone,
          });
        }
      } else {
        recipientSource = applyCountryCodeToRows(
          CampaignContacts.listAllPhones(),
          countryCode
        ).map((c) => ({
          id: CampaignContacts.findByPhone(c.phone)?.id || c.id || null,
          name: c.name || null,
          phone: c.phone,
        }));
      }

      if (!recipientSource.length) {
        req.session.flash = {
          type: 'error',
          message:
            'No contacts found. Upload Excel/CSV, paste numbers, or add contacts first.',
        };
        return res.redirect('/admin/campaigns/new');
      }

      const wantStart = String(req.body.action || '') === 'start';
      if (wantStart && !whatsapp.ready) {
        req.session.flash = {
          type: 'error',
          message: 'WhatsApp must be connected before starting a campaign.',
        };
        return res.redirect('/admin/campaigns/new');
      }

      const stamp = new Date()
        .toISOString()
        .replace('T', ' ')
        .slice(0, 16);
      const autoName = `Campaign ${stamp}`;

      const camp = Campaigns.create({
        name: autoName,
        body_text,
        content_type,
        image_path,
        image_mimetype,
        image_filename,
        use_quick_replies: useQuickReplies,
        quick_reply_buttons: useQuickReplies
          ? JSON.stringify(
              qrLabels.length ? qrLabels : ['Interested', 'Not Interested']
            )
          : null,
        delay_min_ms: pacing.delay_min_ms,
        delay_max_ms: pacing.delay_max_ms,
        msgs_per_minute: pacing.msgs_per_minute,
        hourly_limit: cap.hourly_limit,
        batch_size: cap.batch_size,
        batch_window_ms: cap.batch_window_ms,
        status: 'draft',
      });

      const added = CampaignRecipients.addMany(camp.id, recipientSource);

      if (wantStart) {
        Campaigns.setStatus(camp.id, 'running', {
          started_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          next_send_at: null,
          completed_at: null,
        });
        getCampaignRunner(whatsapp).emitStatus(camp.id);
        setImmediate(() => {
          try {
            getCampaignRunner(whatsapp).tick().catch(() => {});
          } catch (_) {}
        });
      }

      const importNote = importRows.length
        ? ` Import: ${importStats.inserted} new, ${importStats.updated} updated.`
        : '';
      req.session.flash = {
        type: 'success',
        message: wantStart
          ? `Campaign started with ${added} recipients (~${pacing.msgs_per_minute}/min). Runs in background even if you close this page.${importNote}`
          : `Draft saved with ${added} recipients.${importNote}`,
      };
      res.redirect(`/admin/campaigns/${camp.id}`);
    } catch (err) {
      console.error('[Campaigns] create failed:', err.message);
      req.session.flash = { type: 'error', message: err.message };
      res.redirect('/admin/campaigns/new');
    }
  }
);

router.post('/admin/campaigns/:id/start', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const camp = Campaigns.get(id);
  if (!camp) {
    req.session.flash = { type: 'error', message: 'Not found.' };
    return res.redirect('/admin/campaigns');
  }
  if (!whatsapp.ready) {
    req.session.flash = {
      type: 'error',
      message: 'WhatsApp must be connected before starting a campaign.',
    };
    return res.redirect(`/admin/campaigns/${id}`);
  }

  if (camp.schedule_at) {
    const when = Date.parse(String(camp.schedule_at).replace(' ', 'T'));
    if (Number.isFinite(when) && when > Date.now()) {
      Campaigns.setStatus(id, 'scheduled', {
        next_send_at: null,
        completed_at: null,
      });
      req.session.flash = {
        type: 'success',
        message: `Campaign scheduled for ${camp.schedule_at}.`,
      };
      return res.redirect(`/admin/campaigns/${id}`);
    }
  }

  Campaigns.setStatus(id, 'running', {
    started_at:
      camp.started_at ||
      new Date().toISOString().replace('T', ' ').slice(0, 19),
    next_send_at: null,
    completed_at: null,
  });
  getCampaignRunner(whatsapp).emitStatus(id);
  setImmediate(() => {
    try {
      getCampaignRunner(whatsapp).tick().catch(() => {});
    } catch (_) {}
  });
  req.session.flash = {
    type: 'success',
    message:
      'Campaign running in background (survives browser close / PM2 restart keeps queue).',
  };
  res.redirect(`/admin/campaigns/${id}`);
});

router.post('/admin/campaigns/:id/pause', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  Campaigns.setStatus(id, 'paused');
  req.session.flash = { type: 'success', message: 'Campaign paused.' };
  res.redirect(`/admin/campaigns/${id}`);
});

router.post('/admin/campaigns/:id/cancel', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  Campaigns.setStatus(id, 'cancelled', {
    completed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  req.session.flash = { type: 'success', message: 'Campaign cancelled.' };
  res.redirect(`/admin/campaigns/${id}`);
});

router.post('/admin/campaigns/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  Campaigns.remove(id);
  req.session.flash = { type: 'success', message: 'Campaign deleted.' };
  res.redirect('/admin/campaigns');
});

router.get('/api/campaigns/:id/stats', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  res.json({
    ok: true,
    campaign: Campaigns.get(id),
    stats: Campaigns.stats(id),
  });
});

module.exports = router;
