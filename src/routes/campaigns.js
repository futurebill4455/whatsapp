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
} = require('../models');
const { ensureMediaDir } = require('../models/campaigns');
const {
  parsePastedText,
  parseCsvBuffer,
  parseExcelBuffer,
  contactsToCsv,
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
      skipLimiter: false,
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
  res.render(
    'admin/campaign-detail',
    layoutLocals(req, {
      title: campaign.name,
      campaign,
      stats,
      recipients,
      waReady: !!(whatsapp.ready && whatsapp.client),
    })
  );
});

router.post(
  '/admin/campaigns',
  requireAdmin,
  (req, res, next) => {
    imageUpload.single('image')(req, res, (err) => {
      if (err) {
        req.session.flash = { type: 'error', message: err.message };
        return res.redirect('/admin/campaigns/new');
      }
      next();
    });
  },
  (req, res) => {
    try {
      const name = String(req.body.name || '').trim() || 'Untitled campaign';
      const body_text = String(req.body.body_text || '').trim();
      if (!body_text) {
        req.session.flash = { type: 'error', message: 'Message text required.' };
        return res.redirect('/admin/campaigns/new');
      }

      const content_type =
        req.body.content_type === 'image_text' ? 'image_text' : 'text';
      if (content_type === 'image_text' && !req.file) {
        req.session.flash = {
          type: 'error',
          message: 'Image required for Image + Text campaigns.',
        };
        return res.redirect('/admin/campaigns/new');
      }

      const delayMinMin = Number(req.body.delay_min_minutes);
      const delayMaxMin = Number(req.body.delay_max_minutes);
      const delay_min_ms = Math.round(
        (Number.isFinite(delayMinMin) ? delayMinMin : 1) * 60 * 1000
      );
      const delay_max_ms = Math.round(
        (Number.isFinite(delayMaxMin) ? delayMaxMin : 5) * 60 * 1000
      );
      const batch_size = Number(req.body.batch_size) || 10;
      const batch_window_min = Number(req.body.batch_window_minutes) || 5;

      const camp = Campaigns.create({
        name,
        body_text,
        content_type,
        image_path: req.file ? req.file.path : null,
        image_mimetype: req.file ? req.file.mimetype : null,
        image_filename: req.file ? req.file.originalname : null,
        use_quick_replies: req.body.use_quick_replies === '1',
        delay_min_ms: Math.min(delay_min_ms, delay_max_ms),
        delay_max_ms: Math.max(delay_min_ms, delay_max_ms),
        batch_size,
        batch_window_ms: Math.round(batch_window_min * 60 * 1000),
        status: 'draft',
      });

      const contacts = CampaignContacts.listAllPhones();
      const added = CampaignRecipients.addMany(camp.id, contacts);
      req.session.flash = {
        type: 'success',
        message: `Campaign created with ${added} recipients.`,
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
  Campaigns.setStatus(id, 'running', {
    started_at:
      camp.started_at ||
      new Date().toISOString().replace('T', ' ').slice(0, 19),
    next_send_at: null,
    completed_at: null,
  });
  getCampaignRunner(whatsapp).emitStatus(id);
  req.session.flash = {
    type: 'success',
    message: 'Campaign running in background (survives browser close).',
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
