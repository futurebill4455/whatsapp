const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin, guestOnly } = require('../middleware/auth');
const { Admins, Settings, MessageLog } = require('../models');
const whatsapp = require('../services/whatsapp');

const router = express.Router();

function layoutLocals(req, extra = {}) {
  return {
    businessName: Settings.get('business_name', 'WhatsApp Bot'),
    admin: req.session.adminUsername || null,
    flash: req.session.flash || null,
    ...extra,
  };
}

router.use((req, res, next) => {
  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }
  next();
});

// ——— Public ———
router.get('/', (req, res) => {
  res.render('qr', layoutLocals(req, {
    title: 'WhatsApp Connection',
    status: whatsapp.getPublicStatus(),
  }));
});

router.get('/api/whatsapp/status', (req, res) => {
  res.json(whatsapp.getPublicStatus());
});

// ——— Admin auth ———
router.get('/admin/login', guestOnly, (req, res) => {
  res.render('admin/login', layoutLocals(req, { title: 'Admin Login' }));
});

router.post('/admin/login', guestOnly, (req, res) => {
  const { username, password } = req.body;
  const admin = Admins.findByUsername(String(username || '').trim());
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.render('admin/login', layoutLocals(req, {
      title: 'Admin Login',
      error: 'Invalid username or password',
    }));
  }
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.redirect('/admin');
});

router.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ——— Admin pages ———
router.get('/admin', requireAdmin, (req, res) => {
  res.render('admin/dashboard', layoutLocals(req, {
    title: 'Dashboard',
    messageCount: MessageLog.count(),
    waStatus: whatsapp.getPublicStatus(),
    messages: MessageLog.recent(30),
  }));
});

router.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', layoutLocals(req, {
    title: 'Settings',
    settings: Settings.getAll(),
  }));
});

router.post('/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['business_name', 'welcome_message', 'default_reply'];
  const payload = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) payload[key] = req.body[key];
  }
  Settings.setMany(payload);
  req.session.flash = { type: 'success', message: 'Settings saved.' };
  res.redirect('/admin/settings');
});

router.post('/admin/whatsapp/logout', requireAdmin, async (req, res) => {
  await whatsapp.logout();
  req.session.flash = {
    type: 'success',
    message: 'WhatsApp session logged out. Scan a new QR code.',
  };
  res.redirect('/admin');
});

router.post('/admin/whatsapp/reset-session', requireAdmin, async (req, res) => {
  try {
    await whatsapp.resetSession({ reason: 'admin reset-session' });
    req.session.flash = {
      type: 'success',
      message: 'WhatsApp session wiped. Wait for a fresh QR on the home page.',
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Reset failed: ${err.message}` };
  }
  res.redirect('/');
});

router.post('/whatsapp/reset-session', async (req, res) => {
  try {
    await whatsapp.resetSession({ reason: 'qr-page reset' });
    req.session.flash = {
      type: 'success',
      message: 'Session cleared. A new QR will appear shortly — scan it within ~20 seconds.',
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Reset failed: ${err.message}` };
  }
  res.redirect('/');
});

module.exports = router;
