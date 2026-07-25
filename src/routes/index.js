const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { requireAdmin, guestOnly } = require('../middleware/auth');
const {
  Admins,
  Settings,
  InsuranceTypes,
  Companies,
  PremiumOptions,
  DurationOptions,
  FormFields,
  Submissions,
  MessageLog,
  Workflows,
  ChatSessions,
} = require('../models');
const whatsapp = require('../services/whatsapp');
const {
  NODE_META,
  buildDefaultWorkflowGraph,
} = require('../services/workflowDefaults');

function layoutLocals(req, extra = {}) {
  const flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  return {
    businessName: Settings.get('business_name', 'SecureLife Insurance'),
    admin: req.session.adminUsername || null,
    flash,
    reqPath: req.path || '',
    ...extra,
  };
}

function parseMembers(body) {
  const count = Math.max(0, Math.min(20, Number(body.member_count) || 0));
  if (!count) return [];
  const members = [];
  for (let i = 1; i <= count; i++) {
    const name = String(body[`member_${i}_name`] || '').trim();
    const dob = String(body[`member_${i}_dob`] || '').trim();
    const gender = String(body[`member_${i}_gender`] || '').trim();
    if (name || dob || gender) {
      members.push({ name, dob, gender });
    }
  }
  return members;
}

function catalogPayload() {
  return {
    insuranceTypes: InsuranceTypes.list(true),
    companies: Companies.list(true),
    premiums: PremiumOptions.list(true),
    durations: DurationOptions.list(true),
    fields: FormFields.list(true),
  };
}

// ——— Public ———

router.get('/', (req, res) => {
  res.render(
    'home',
    layoutLocals(req, {
      title: 'Connect WhatsApp',
      waStatus: whatsapp.getPublicStatus(),
      qrDataUrl: whatsapp.qrDataUrl || null,
    })
  );
});

router.get('/api/whatsapp/status', (req, res) => {
  res.json({
    ...whatsapp.getPublicStatus(),
    qr: whatsapp.qrDataUrl || null,
  });
});

router.get('/form/:token', (req, res) => {
  const submission = Submissions.getByToken(req.params.token);
  if (!submission) {
    return res.status(404).render(
      'error',
      layoutLocals(req, {
        title: 'Form not found',
        message: 'This form link is invalid or has expired.',
      })
    );
  }

  if (['submitted', 'confirmed', 'forwarded'].includes(submission.status)) {
    return res.render(
      'form-done',
      layoutLocals(req, {
        title: 'Submitted',
        submission,
        successMessage:
          Settings.get('success_message') ||
          'Thank you! Your details have been received.',
      })
    );
  }

  const catalog = catalogPayload();
  res.render(
    'form',
    layoutLocals(req, {
      title: 'Insurance enquiry',
      submission,
      formIntro:
        Settings.get('form_intro') ||
        'Select Health or Vehicle insurance. The form guides you step-by-step.',
      ...catalog,
    })
  );
});

router.post('/form/:token', async (req, res) => {
  const token = req.params.token;
  const submission = Submissions.getByToken(token);
  if (!submission) {
    return res.status(404).render(
      'error',
      layoutLocals(req, {
        title: 'Form not found',
        message: 'This form link is invalid or has expired.',
      })
    );
  }

  if (['submitted', 'confirmed', 'forwarded'].includes(submission.status)) {
    return res.redirect(`/form/${token}`);
  }

  const catalog = catalogPayload();
  const customer_name = String(req.body.customer_name || '').trim();
  const advisor_name = String(req.body.advisor_name || '').trim() || null;
  const insurance_type = String(req.body.insurance_type || '').trim();
  const company = String(req.body.company || '').trim();
  const premium_amount = String(req.body.premium_amount || '').trim();
  const policy_duration = String(req.body.policy_duration || '').trim();
  const member_count = Number(req.body.member_count) || null;
  const members = parseMembers(req.body);

  const errors = [];
  if (!customer_name) errors.push('Full name is required.');
  if (!insurance_type) errors.push('Insurance type is required.');
  if (!company) errors.push('Company is required.');
  if (!premium_amount) errors.push('Premium / sum insured is required.');
  if (!policy_duration) errors.push('Policy duration is required.');

  const typeRow = catalog.insuranceTypes.find(
    (t) => t.name.toLowerCase() === insurance_type.toLowerCase()
  );
  if (insurance_type && !typeRow) {
    errors.push('Invalid insurance type.');
  }

  const companyRow = catalog.companies.find(
    (c) => c.name.toLowerCase() === company.toLowerCase()
  );
  if (company && !companyRow) {
    errors.push('Invalid company.');
  }

  if (
    typeRow &&
    companyRow &&
    companyRow.insurance_type_id &&
    Number(companyRow.insurance_type_id) !== Number(typeRow.id)
  ) {
    errors.push('Selected company does not match insurance type.');
  }

  if (
    premium_amount &&
    !catalog.premiums.some(
      (p) =>
        p.value === premium_amount ||
        p.label === premium_amount ||
        String(p.id) === premium_amount
    )
  ) {
    // allow free-text fallback if catalog empty; otherwise soft-check labels/values
    if (catalog.premiums.length) {
      const ok = catalog.premiums.some(
        (p) =>
          p.value === premium_amount ||
          p.label === premium_amount
      );
      if (!ok) errors.push('Invalid premium option.');
    }
  }

  if (
    policy_duration &&
    catalog.durations.length &&
    !catalog.durations.some(
      (d) => d.value === policy_duration || d.label === policy_duration
    )
  ) {
    errors.push('Invalid policy duration.');
  }

  const isHealth =
    typeRow && String(typeRow.name).toLowerCase().includes('health');
  if (isHealth && member_count && members.length < member_count) {
    errors.push('Please fill details for each member.');
  }

  if (errors.length) {
    req.session.flash = { type: 'error', message: errors.join(' ') };
    return res.redirect(`/form/${token}`);
  }

  const premiumLabel =
    catalog.premiums.find(
      (p) => p.value === premium_amount || p.label === premium_amount
    )?.label || premium_amount;
  const durationLabel =
    catalog.durations.find(
      (d) => d.value === policy_duration || d.label === policy_duration
    )?.label || policy_duration;

  const updated = Submissions.submitForm(token, {
    customer_name,
    advisor_name,
    insurance_type: typeRow ? typeRow.name : insurance_type,
    company: companyRow ? companyRow.name : company,
    premium_amount: premiumLabel,
    policy_duration: durationLabel,
    member_count: isHealth ? member_count || members.length || null : null,
    members: isHealth && members.length ? members : null,
    extra: {
      insurance_type_id: typeRow?.id || null,
      company_id: companyRow?.id || null,
    },
  });

  try {
    await whatsapp.notifyFormSubmitted(updated);
  } catch (err) {
    console.error('[Form] notifyFormSubmitted failed:', err.message);
  }

  return res.render(
    'form-done',
    layoutLocals(req, {
      title: 'Submitted',
      submission: updated,
      successMessage:
        Settings.get('success_message') ||
        'Thank you! Your details have been received.',
    })
  );
});

// ——— Admin auth ———

router.get('/admin/login', guestOnly, (req, res) => {
  res.render(
    'admin/login',
    layoutLocals(req, { title: 'Admin Login' })
  );
});

router.post('/admin/login', guestOnly, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const admin = Admins.findByUsername(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    req.session.flash = { type: 'error', message: 'Invalid username or password.' };
    return res.redirect('/admin/login');
  }
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  req.session.flash = { type: 'success', message: 'Welcome back.' };
  return res.redirect('/admin');
});

router.post('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ——— Dashboard ———

router.get('/admin', requireAdmin, (req, res) => {
  const stats = Submissions.stats();
  const waStatus = whatsapp.getPublicStatus();
  const recentLeads = Submissions.list({ limit: 12 });
  const recentMessages = MessageLog.recent(20);
  const activeChatList = ChatSessions.listActive(20);
  const activeChats = ChatSessions.countActive();
  const commonAccessCode = Settings.get('common_access_code', 'INSU2026');

  res.render(
    'admin/dashboard',
    layoutLocals(req, {
      title: 'Dashboard',
      stats,
      waStatus,
      recentLeads,
      recentMessages,
      activeChatList,
      activeChats,
      commonAccessCode,
    })
  );
});

// ——— Settings ———

router.get('/admin/settings', requireAdmin, (req, res) => {
  res.render(
    'admin/settings',
    layoutLocals(req, {
      title: 'Settings',
      settings: Settings.getAll(),
    })
  );
});

router.post('/admin/settings', requireAdmin, (req, res) => {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const jitterMin = clamp(Number(req.body.anti_ban_jitter_min_ms) || 4000, 2000, 30000);
  let jitterMax = clamp(Number(req.body.anti_ban_jitter_max_ms) || 30000, 2000, 30000);
  if (jitterMax < jitterMin) jitterMax = jitterMin;

  Settings.setMany({
    business_name: String(req.body.business_name || '').trim() || 'SecureLife Insurance',
    close_keywords: String(req.body.close_keywords || 'close,cls').trim(),
    anti_ban_jitter_min_ms: String(jitterMin),
    anti_ban_jitter_max_ms: String(jitterMax),
    anti_ban_min_gap_ms: String(
      clamp(Number(req.body.anti_ban_min_gap_ms) || 4000, 0, 60000)
    ),
    anti_ban_hours_enabled: req.body.anti_ban_hours_enabled ? '1' : '0',
    anti_ban_hours_start: String(
      clamp(Number(req.body.anti_ban_hours_start) || 9, 0, 23)
    ),
    anti_ban_hours_end: String(
      clamp(Number(req.body.anti_ban_hours_end) || 21, 0, 23)
    ),
    anti_ban_timezone: String(req.body.anti_ban_timezone || 'Asia/Kolkata').trim(),
  });

  req.session.flash = { type: 'success', message: 'Settings saved.' };
  res.redirect('/admin/settings');
});

// ——— Chat flow (common access code + bot messages) ———

router.get('/admin/chat-flow', requireAdmin, (req, res) => {
  res.render(
    'admin/chat-flow',
    layoutLocals(req, {
      title: 'Chat Flow',
      settings: Settings.getAll(),
    })
  );
});

router.post('/admin/chat-flow', requireAdmin, (req, res) => {
  const code =
    String(req.body.common_access_code || 'INSU2026')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '') || 'INSU2026';

  Settings.setMany({
    common_access_code: code,
    access_granted_message: String(req.body.access_granted_message || ''),
    flow_welcome_message: String(req.body.flow_welcome_message || ''),
    form_link_message: String(req.body.form_link_message || '{{form_link}}').trim() || '{{form_link}}',
    access_wrong_code_message: String(req.body.access_wrong_code_message || ''),
    form_intro: String(req.body.form_intro || ''),
    success_message: String(req.body.success_message || ''),
    chat_close_message: String(req.body.chat_close_message || ''),
    company_close_notify_message: String(req.body.company_close_notify_message || ''),
    forward_template: String(req.body.forward_template || ''),
  });

  req.session.flash = {
    type: 'success',
    message: `Chat flow saved. Common access code is now ${code}.`,
  };
  res.redirect('/admin/chat-flow');
});

// Legacy Users / per-phone access pages removed
router.get('/admin/access', requireAdmin, (_req, res) => {
  res.redirect(301, '/admin/chat-flow');
});
router.post('/admin/access', requireAdmin, (_req, res) => {
  res.redirect(301, '/admin/chat-flow');
});
router.post('/admin/access/:id', requireAdmin, (_req, res) => {
  res.redirect(301, '/admin/chat-flow');
});

// ——— Catalog ———

router.get('/admin/catalog', requireAdmin, (req, res) => {
  res.render(
    'admin/catalog',
    layoutLocals(req, {
      title: 'Catalog',
      types: InsuranceTypes.list(),
      companies: Companies.list(),
      premiums: PremiumOptions.list(),
      durations: DurationOptions.list(),
    })
  );
});

router.post('/admin/types', requireAdmin, (req, res) => {
  if (!req.body.name) {
    req.session.flash = { type: 'error', message: 'Type name required.' };
    return res.redirect('/admin/catalog');
  }
  InsuranceTypes.create({
    name: req.body.name,
    sort_order: Number(req.body.sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Insurance type added.' };
  res.redirect('/admin/catalog');
});

router.post('/admin/types/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    InsuranceTypes.remove(id);
    req.session.flash = { type: 'success', message: 'Type deleted.' };
  } else {
    InsuranceTypes.update(id, {
      name: req.body.name,
      is_active: req.body.is_active === '0' ? 0 : 1,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Type updated.' };
  }
  res.redirect('/admin/catalog');
});

router.post('/admin/companies', requireAdmin, (req, res) => {
  if (!req.body.name) {
    req.session.flash = { type: 'error', message: 'Company name required.' };
    return res.redirect('/admin/catalog');
  }
  Companies.create({
    name: req.body.name,
    insurance_type_id: req.body.insurance_type_id || null,
    desk_phone: req.body.desk_phone || null,
    sort_order: Number(req.body.sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Company added.' };
  res.redirect('/admin/catalog');
});

router.post('/admin/companies/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    Companies.remove(id);
    req.session.flash = { type: 'success', message: 'Company deleted.' };
  } else {
    Companies.update(id, {
      name: req.body.name,
      insurance_type_id: req.body.insurance_type_id || null,
      desk_phone: req.body.desk_phone,
      is_active: req.body.is_active === '0' ? 0 : 1,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Company updated.' };
  }
  res.redirect('/admin/catalog');
});

router.post('/admin/premiums', requireAdmin, (req, res) => {
  if (!req.body.label || !req.body.value) {
    req.session.flash = { type: 'error', message: 'Premium label and value required.' };
    return res.redirect('/admin/catalog');
  }
  PremiumOptions.create({
    label: req.body.label,
    value: req.body.value,
    sort_order: Number(req.body.sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Premium option added.' };
  res.redirect('/admin/catalog');
});

router.post('/admin/premiums/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    PremiumOptions.remove(id);
    req.session.flash = { type: 'success', message: 'Premium deleted.' };
  } else {
    PremiumOptions.update(id, {
      label: req.body.label,
      value: req.body.value,
      is_active: req.body.is_active === '0' ? 0 : 1,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Premium updated.' };
  }
  res.redirect('/admin/catalog');
});

router.post('/admin/durations', requireAdmin, (req, res) => {
  if (!req.body.label || !req.body.value) {
    req.session.flash = { type: 'error', message: 'Duration label and value required.' };
    return res.redirect('/admin/catalog');
  }
  DurationOptions.create({
    label: req.body.label,
    value: req.body.value,
    sort_order: Number(req.body.sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Duration option added.' };
  res.redirect('/admin/catalog');
});

router.post('/admin/durations/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    DurationOptions.remove(id);
    req.session.flash = { type: 'success', message: 'Duration deleted.' };
  } else {
    DurationOptions.update(id, {
      label: req.body.label,
      value: req.body.value,
      is_active: req.body.is_active === '0' ? 0 : 1,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Duration updated.' };
  }
  res.redirect('/admin/catalog');
});

// ——— Form builder ———

router.get('/admin/form-builder', requireAdmin, (req, res) => {
  res.render(
    'admin/form-builder',
    layoutLocals(req, {
      title: 'Form Builder',
      fields: FormFields.list(),
    })
  );
});

router.post('/admin/form-builder/fields', requireAdmin, (req, res) => {
  const field_key = String(req.body.field_key || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!field_key || !req.body.label) {
    req.session.flash = { type: 'error', message: 'Field key and label required.' };
    return res.redirect('/admin/form-builder');
  }
  let options = null;
  if (req.body.options) {
    options = String(req.body.options)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  FormFields.create({
    field_key,
    label: req.body.label,
    field_type: req.body.field_type || 'text',
    options,
    is_required: req.body.is_required ? 1 : 0,
    sort_order: Number(req.body.sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Field added.' };
  res.redirect('/admin/form-builder');
});

router.post('/admin/form-builder/fields/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    FormFields.remove(id);
    req.session.flash = { type: 'success', message: 'Field deleted.' };
  } else {
    let options;
    if (req.body.options !== undefined) {
      options = String(req.body.options || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!options.length) options = null;
    }
    FormFields.update(id, {
      label: req.body.label,
      field_type: req.body.field_type,
      options,
      is_required: req.body.is_required ? 1 : 0,
      is_active: req.body.is_active === '0' ? 0 : 1,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Field updated.' };
  }
  res.redirect('/admin/form-builder');
});

// ——— Workflow ———

router.get('/admin/workflow', requireAdmin, (req, res) => {
  let workflow = Workflows.getActive();
  if (!workflow) {
    const list = Workflows.list();
    if (list.length) workflow = Workflows.get(list[0].id);
  }
  if (!workflow) {
    workflow = Workflows.create({
      name: 'Insurance Lead Intake',
      description: 'Default workflow',
      graph: buildDefaultWorkflowGraph(),
      is_active: 1,
    });
  }

  res.render(
    'admin/workflow',
    layoutLocals(req, {
      title: 'Workflow Builder',
      workflows: Workflows.list(),
      workflow,
      workflowJson: JSON.stringify(workflow.graph || buildDefaultWorkflowGraph()),
      nodeMeta: JSON.stringify(NODE_META),
    })
  );
});

router.get('/api/workflows', requireAdmin, (req, res) => {
  res.json({ ok: true, workflows: Workflows.list() });
});

router.get('/api/workflows/:id', requireAdmin, (req, res) => {
  const wf = Workflows.get(Number(req.params.id));
  if (!wf) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, workflow: wf });
});

router.post('/api/workflows', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim() || 'Untitled workflow';
  const wf = Workflows.create({
    name,
    description: String(req.body.description || ''),
    graph: req.body.graph || buildDefaultWorkflowGraph(),
    is_active: req.body.is_active ? 1 : 0,
  });
  res.json({ ok: true, workflow: wf });
});

router.put('/api/workflows/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const wf = Workflows.update(id, {
    name: req.body.name,
    description: req.body.description,
    graph: req.body.graph,
    is_active: req.body.is_active,
  });
  if (!wf) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, workflow: wf });
});

router.post('/api/workflows/:id/save', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!req.body.graph) {
    return res.status(400).json({ ok: false, error: 'graph required' });
  }
  const wf = Workflows.saveGraph(id, req.body.graph);
  if (req.body.name || req.body.description !== undefined) {
    Workflows.update(id, {
      name: req.body.name,
      description: req.body.description,
    });
  }
  res.json({ ok: true, workflow: Workflows.get(id) || wf });
});

router.post('/api/workflows/:id/activate', requireAdmin, (req, res) => {
  const wf = Workflows.setActive(Number(req.params.id));
  if (!wf) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, workflow: wf });
});

router.post('/api/workflows/reset-default', requireAdmin, (req, res) => {
  const active = Workflows.getActive();
  const graph = buildDefaultWorkflowGraph();
  let wf;
  if (active) {
    wf = Workflows.saveGraph(active.id, graph);
    Workflows.update(active.id, {
      name: active.name || 'Insurance Lead Intake',
      description: 'Reset to default graph',
    });
  } else {
    wf = Workflows.create({
      name: 'Insurance Lead Intake',
      description: 'Default workflow',
      graph,
      is_active: 1,
    });
  }
  res.json({ ok: true, workflow: Workflows.get(wf.id) });
});

router.post('/admin/workflow/reset-default', requireAdmin, (req, res) => {
  const active = Workflows.getActive();
  const graph = buildDefaultWorkflowGraph();
  if (active) {
    Workflows.saveGraph(active.id, graph);
  } else {
    Workflows.create({
      name: 'Insurance Lead Intake',
      description: 'Default workflow',
      graph,
      is_active: 1,
    });
  }
  req.session.flash = { type: 'success', message: 'Workflow reset to default.' };
  res.redirect('/admin/workflow');
});

// ——— Submissions / Leads ———

router.get('/admin/submissions', requireAdmin, (req, res) => {
  const status = req.query.status || null;
  res.render(
    'admin/submissions',
    layoutLocals(req, {
      title: 'Leads',
      leads: Submissions.list({ status, limit: 200 }),
      filterStatus: status,
    })
  );
});

// ——— WhatsApp controls ———

router.post('/admin/whatsapp/logout', requireAdmin, async (req, res) => {
  try {
    await whatsapp.logout();
    req.session.flash = { type: 'success', message: 'WhatsApp logged out.' };
  } catch (err) {
    req.session.flash = {
      type: 'error',
      message: err.message || 'Logout failed.',
    };
  }
  res.redirect('/admin');
});

router.post('/admin/whatsapp/reset-session', requireAdmin, async (req, res) => {
  try {
    await whatsapp.resetSession();
    req.session.flash = {
      type: 'success',
      message: 'Session reset. Scan a new QR on the home page.',
    };
  } catch (err) {
    req.session.flash = {
      type: 'error',
      message: err.message || 'Reset failed.',
    };
  }
  res.redirect('/admin');
});

module.exports = router;
