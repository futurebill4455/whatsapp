const express = require('express');
const crypto = require('crypto');
const { requireAdmin, guestOnly } = require('../middleware/auth');
const { config } = require('../config/runtime');
const store = require('../store/memory');
const whatsapp = require('../services/whatsapp');

const router = express.Router();

function layoutLocals(req, extra = {}) {
  return {
    businessName: config.businessName,
    admin: req.session.adminUsername || null,
    flash: req.session.flash || null,
    ...extra,
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
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

// ——— Customer form (in-memory token) ———
router.get('/form/:token', (req, res) => {
  const pending = store.getPendingByToken(req.params.token);
  if (!pending) {
    return res.status(404).render('error', layoutLocals(req, {
      title: 'Not Found',
      message: 'This form link is invalid or has expired. Message us on WhatsApp with Hi for a new link.',
    }));
  }

  if (pending.status === 'awaiting_confirmation') {
    return res.render('form-done', layoutLocals(req, {
      title: 'Awaiting Confirmation',
      message: 'Please reply Yes on WhatsApp to confirm your details.',
    }));
  }

  if (pending.status !== 'awaiting_form') {
    return res.render('form-done', layoutLocals(req, {
      title: 'Already Submitted',
      message: 'This form was already used. Message Hi on WhatsApp to start again.',
    }));
  }

  res.render('form', layoutLocals(req, {
    title: 'Your details',
    token: pending.token,
    formIntro: config.formIntro,
    customerPhone: pending.customerPhone,
  }));
});

router.post('/form/:token', async (req, res) => {
  const pending = store.getPendingByToken(req.params.token);
  if (!pending || pending.status !== 'awaiting_form') {
    return res.status(400).render('error', layoutLocals(req, {
      title: 'Invalid',
      message: 'This form can no longer be submitted.',
    }));
  }

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const details = String(req.body.details || '').trim();
  const phone = String(req.body.phone || pending.customerPhone || '').trim();

  if (!name || !details) {
    req.session.flash = { type: 'error', message: 'Name and details are required.' };
    return res.redirect(`/form/${req.params.token}`);
  }

  store.submitForm(req.params.token, { name, phone, email, details });

  try {
    await whatsapp.notifyFormSubmitted(req.params.token);
  } catch (err) {
    console.error('Failed to send confirmation WhatsApp:', err.message);
  }

  res.render('form-done', layoutLocals(req, {
    title: 'Submitted',
    message: 'Thanks! Check WhatsApp and reply Yes to confirm — we will connect you with the company.',
  }));
});

// ——— Admin auth (env credentials only) ———
router.get('/admin/login', guestOnly, (req, res) => {
  res.render('admin/login', layoutLocals(req, { title: 'Admin Login' }));
});

router.post('/admin/login', guestOnly, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const userOk = safeEqual(username, config.adminUsername);
  const passOk = safeEqual(password, config.adminPassword);
  if (!userOk || !passOk) {
    return res.render('admin/login', layoutLocals(req, {
      title: 'Admin Login',
      error: 'Invalid username or password',
    }));
  }
  req.session.adminId = 1;
  req.session.adminUsername = username;
  res.redirect('/admin');
});

router.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.get('/admin', requireAdmin, (req, res) => {
  res.render('admin/dashboard', layoutLocals(req, {
    title: 'Dashboard',
    waStatus: whatsapp.getPublicStatus(),
    memory: store.stats(),
    bridges: store.listActiveBridges(),
    companyPhone: config.companyPhone,
  }));
});

router.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', layoutLocals(req, {
    title: 'Settings',
    settings: {
      business_name: config.businessName,
      company_phone: config.companyPhone,
      base_url: config.baseUrl,
      triggers: config.triggers.join(', '),
      link_message: config.linkMessage,
      form_intro: config.formIntro,
    },
  }));
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
      message: 'WhatsApp auth session wiped. Wait for a fresh QR on the home page.',
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
