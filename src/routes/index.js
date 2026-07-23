const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin, guestOnly } = require('../middleware/auth');
const {
  Admins,
  Settings,
  InsuranceTypes,
  Companies,
  InternalNumbers,
  ChatFlow,
  FormFields,
  Submissions,
  MessageLog,
  Workflows,
  ChatSessions,
  AccessUsers,
} = require('../models');
const whatsapp = require('../services/whatsapp');
const { NODE_META, buildDefaultWorkflowGraph } = require('../services/workflowDefaults');

const router = express.Router();

function layoutLocals(req, extra = {}) {
  return {
    businessName: Settings.get('business_name', 'Insurance Bot'),
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

// ——— Customer form ———
router.get('/form/:token', (req, res) => {
  const submission = Submissions.getByToken(req.params.token);
  if (!submission) {
    return res.status(404).render('error', layoutLocals(req, {
      title: 'Not Found',
      message: 'This form link is invalid or has expired.',
    }));
  }

  if (['confirmed', 'forwarded', 'cancelled'].includes(submission.status)) {
    return res.render('form-done', layoutLocals(req, {
      title: 'Already Submitted',
      submission,
      message: submission.status === 'cancelled'
        ? 'This request was cancelled. Message us on WhatsApp with Hi to start again.'
        : 'Your details were already submitted. Check WhatsApp for confirmation.',
    }));
  }

  if (submission.status === 'awaiting_confirmation') {
    return res.render('form-done', layoutLocals(req, {
      title: 'Awaiting Confirmation',
      submission,
      message: 'Please reply Yes on WhatsApp to confirm your details.',
    }));
  }

  const types = InsuranceTypes.list(true);
  const companies = Companies.list(true);
  const healthCompanies = companies.filter((c) => !c.insurance_type_name || c.insurance_type_name === 'Health');
  const vehicleCompanies = companies.filter((c) => !c.insurance_type_name || c.insurance_type_name === 'Vehicle');
  const fields = FormFields.list(true);

  const coverageOptions = (Settings.get('coverage_options') || '₹2 Lakh\n₹3 Lakh\n₹5 Lakh\n₹10 Lakh\n₹25 Lakh\n₹50 Lakh\n₹1 Crore')
    .split('\n').map((s) => s.trim()).filter(Boolean);

  res.render('form', layoutLocals(req, {
    title: 'Insurance Details',
    submission,
    types,
    companies,
    healthCompanies,
    vehicleCompanies,
    fields,
    coverageOptions,
    formIntro: Settings.get('form_intro') ||
      'Select Health or Vehicle insurance — the form will show the right fields automatically.',
  }));
});

router.post('/form/:token', async (req, res) => {
  const submission = Submissions.getByToken(req.params.token);
  if (!submission || submission.status !== 'awaiting_form') {
    return res.status(400).render('error', layoutLocals(req, {
      title: 'Invalid',
      message: 'This form can no longer be submitted.',
    }));
  }

  const customer_name = String(req.body.customer_name || '').trim();
  const insurance_type = String(req.body.insurance_type || '').trim();
  const company = String(req.body.company || req.body.company_health || req.body.company_vehicle || '').trim();

  if (!customer_name || !insurance_type || !company) {
    req.session.flash = { type: 'error', message: 'Please fill in name, insurance type, and company.' };
    return res.redirect(`/form/${req.params.token}`);
  }

  const extra_data = {};
  if (insurance_type === 'Health') {
    const memberCount = Math.min(5, Math.max(1, parseInt(req.body.member_count) || 1));
    extra_data.member_count = memberCount;
    extra_data.coverage_amount = String(req.body.coverage_amount || '').trim() || 'Not specified';
    const policyDuration = String(req.body.policy_duration || '').trim();
    if (policyDuration && !['2 Years', '3 Years'].includes(policyDuration)) {
      req.session.flash = { type: 'error', message: 'Please select a valid policy duration (2 Years or 3 Years).' };
      return res.redirect(`/form/${req.params.token}`);
    }
    if (policyDuration) extra_data.policy_duration = policyDuration;
    const members = [];
    for (let i = 1; i <= memberCount; i++) {
      const ageRaw = String(req.body[`member_age_${i}`] || req.body[`member_dob_${i}`] || '').trim();
      const ageNum = parseInt(ageRaw, 10);
      members.push({
        name: String(req.body[`member_name_${i}`] || '').trim(),
        age: Number.isFinite(ageNum) ? ageNum : ageRaw,
        gender: String(req.body[`member_gender_${i}`] || '').trim(),
      });
    }
    extra_data.members = members;
    const missingMember = members.find(
      (m) => !m.name || m.age === '' || m.age == null || !m.gender || (typeof m.age === 'number' && (m.age < 1 || m.age > 120))
    );
    if (missingMember) {
      req.session.flash = { type: 'error', message: 'Please fill in all member details (name, age, gender).' };
      return res.redirect(`/form/${req.params.token}`);
    }
  } else if (insurance_type === 'Vehicle') {
    extra_data.vehicle_model = String(req.body.vehicle_model || '').trim();
    extra_data.manufacturing_year = String(req.body.manufacturing_year || '').trim();
    extra_data.policy_type = String(req.body.policy_type || '').trim();
    if (!extra_data.vehicle_model || !extra_data.manufacturing_year || !extra_data.policy_type) {
      req.session.flash = { type: 'error', message: 'Please complete all vehicle fields.' };
      return res.redirect(`/form/${req.params.token}`);
    }
  }

  const updated = Submissions.submitForm(req.params.token, {
    customer_name,
    insurance_type,
    company,
    extra_data,
  });

  try {
    await whatsapp.sendFormConfirmation(updated);
  } catch (err) {
    console.error('Failed to send confirmation WhatsApp:', err.message);
  }

  res.render('form-done', layoutLocals(req, {
    title: 'Submitted',
    submission: updated,
    message: 'Thanks! Please check WhatsApp and reply Yes to confirm your details.',
  }));
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
    stats: Submissions.stats(),
    activeChats: ChatSessions.countActive(),
    waStatus: whatsapp.getPublicStatus(),
    recent: Submissions.list({ limit: 10 }),
    messages: MessageLog.recent(15),
  }));
});

router.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', layoutLocals(req, {
    title: 'Settings',
    settings: Settings.getAll(),
  }));
});

router.post('/admin/settings', requireAdmin, (req, res) => {
  const allowed = [
    'business_name',
    'form_intro',
    'confirmation_template',
    'forward_template',
    'success_message',
    'chat_close_message',
    'cancel_message',
    'already_pending_message',
    'trigger_keywords',
    'close_keywords',
    'relay_delay_ms',
  ];
  const payload = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) payload[key] = req.body[key];
  }
  Settings.setMany(payload);
  req.session.flash = { type: 'success', message: 'Settings saved.' };
  res.redirect('/admin/settings');
});

router.get('/admin/flow', requireAdmin, (req, res) => {
  res.render('admin/flow', layoutLocals(req, {
    title: 'Keyword Replies',
    flows: ChatFlow.list(),
  }));
});

router.get('/admin/access', requireAdmin, (req, res) => {
  res.render('admin/access', layoutLocals(req, {
    title: 'Authorized Users',
    settings: Settings.getAll(),
    users: AccessUsers.list(),
  }));
});

router.post('/admin/access/settings', requireAdmin, (req, res) => {
  Settings.set('access_control_enabled', req.body.access_control_enabled === '1' ? '1' : '0');
  for (const key of [
    'access_denied_message',
    'access_granted_message',
    'access_wrong_code_message',
  ]) {
    if (req.body[key] !== undefined) Settings.set(key, req.body[key]);
  }
  req.session.flash = { type: 'success', message: 'Access settings saved.' };
  res.redirect('/admin/access');
});

router.post('/admin/access/users', requireAdmin, (req, res) => {
  try {
    AccessUsers.create({
      name: req.body.name,
      phone: req.body.phone,
      access_code: req.body.access_code,
    });
    req.session.flash = { type: 'success', message: 'Authorized user added.' };
  } catch (err) {
    req.session.flash = {
      type: 'error',
      message: err.message || 'Could not add user (phone/code must be unique).',
    };
  }
  res.redirect('/admin/access');
});

router.post('/admin/access/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    AccessUsers.remove(id);
    req.session.flash = { type: 'success', message: 'User removed.' };
  } else if (req.body._action === 'lock') {
    const user = AccessUsers.get(id);
    if (user) {
      AccessUsers.lock(user.phone);
      req.session.flash = { type: 'success', message: `${user.name} locked — must send code again.` };
    }
  }
  res.redirect('/admin/access');
});

router.get('/admin/workflow', requireAdmin, (req, res) => {
  let workflow = Workflows.getActive() || Workflows.list()[0];
  if (!workflow) {
    workflow = Workflows.create({
      name: 'Insurance Lead Intake',
      description: 'Default visual workflow',
      graph: buildDefaultWorkflowGraph(),
      is_active: 1,
    });
  } else {
    workflow = Workflows.get(workflow.id);
  }

  res.render('admin/workflow', layoutLocals(req, {
    title: 'Workflow Builder',
    workflow,
    workflows: Workflows.list(),
    nodeMeta: NODE_META,
  }));
});

router.get('/api/admin/workflows/:id', requireAdmin, (req, res) => {
  const wf = Workflows.get(Number(req.params.id));
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json(wf);
});

router.put('/api/admin/workflows/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { name, description, graph, is_active } = req.body || {};
  if (graph) {
    Workflows.saveGraph(id, graph);
  }
  const updated = Workflows.update(id, { name, description, is_active });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, workflow: updated });
});

router.post('/api/admin/workflows/:id/activate', requireAdmin, (req, res) => {
  const updated = Workflows.setActive(Number(req.params.id));
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, workflow: updated });
});

router.post('/api/admin/workflows', requireAdmin, (req, res) => {
  const name = (req.body?.name || 'New Workflow').trim();
  const wf = Workflows.create({
    name,
    description: req.body?.description || '',
    graph: req.body?.graph || buildDefaultWorkflowGraph(),
    is_active: 0,
  });
  res.status(201).json({ ok: true, workflow: wf });
});

router.post('/api/admin/workflows/:id/reset-default', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const updated = Workflows.saveGraph(id, buildDefaultWorkflowGraph());
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, workflow: updated });
});

router.post('/admin/flow', requireAdmin, (req, res) => {
  const { trigger_keyword, response_template, sort_order } = req.body;
  if (!trigger_keyword || !response_template) {
    req.session.flash = { type: 'error', message: 'Keyword and response are required.' };
    return res.redirect('/admin/flow');
  }
  ChatFlow.create({
    trigger_keyword,
    response_template,
    sort_order: Number(sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Chat flow added.' };
  res.redirect('/admin/flow');
});

router.post('/admin/flow/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    ChatFlow.remove(id);
    req.session.flash = { type: 'success', message: 'Chat flow deleted.' };
  } else {
    ChatFlow.update(id, {
      trigger_keyword: req.body.trigger_keyword,
      response_template: req.body.response_template,
      is_active: req.body.is_active === '1' ? 1 : 0,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Chat flow updated.' };
  }
  res.redirect('/admin/flow');
});

router.get('/admin/catalog', requireAdmin, (req, res) => {
  res.render('admin/catalog', layoutLocals(req, {
    title: 'Insurance Catalog',
    types: InsuranceTypes.list(),
    companies: Companies.list(),
    numbers: InternalNumbers.list(),
  }));
});

router.post('/admin/types', requireAdmin, (req, res) => {
  if (!req.body.name) {
    req.session.flash = { type: 'error', message: 'Type name required.' };
    return res.redirect('/admin/catalog');
  }
  InsuranceTypes.create({ name: req.body.name, sort_order: Number(req.body.sort_order) || 0 });
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
      is_active: req.body.is_active === '1' ? 1 : 0,
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
      desk_phone: req.body.desk_phone !== undefined ? req.body.desk_phone : undefined,
      is_active: req.body.is_active === '1' ? 1 : 0,
      sort_order: Number(req.body.sort_order) || 0,
    });
    req.session.flash = { type: 'success', message: 'Company updated.' };
  }
  res.redirect('/admin/catalog');
});

router.post('/admin/numbers', requireAdmin, (req, res) => {
  if (!req.body.label || !req.body.phone) {
    req.session.flash = { type: 'error', message: 'Label and phone required.' };
    return res.redirect('/admin/catalog');
  }
  InternalNumbers.create({
    label: req.body.label,
    phone: String(req.body.phone).replace(/\D/g, ''),
    insurance_type_id: req.body.insurance_type_id || null,
    is_default: req.body.is_default === '1' ? 1 : 0,
  });
  req.session.flash = { type: 'success', message: 'Internal number added.' };
  res.redirect('/admin/catalog');
});

router.post('/admin/numbers/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (req.body._action === 'delete') {
    InternalNumbers.remove(id);
    req.session.flash = { type: 'success', message: 'Number deleted.' };
  } else {
    InternalNumbers.update(id, {
      label: req.body.label,
      phone: req.body.phone ? String(req.body.phone).replace(/\D/g, '') : undefined,
      insurance_type_id: req.body.insurance_type_id || null,
      is_default: req.body.is_default === '1' ? 1 : 0,
      is_active: req.body.is_active === '1' ? 1 : 0,
    });
    req.session.flash = { type: 'success', message: 'Number updated.' };
  }
  res.redirect('/admin/catalog');
});

// ——— Admin Form Builder ———
router.get('/admin/form-builder', requireAdmin, (req, res) => {
  res.render('admin/form-builder', layoutLocals(req, {
    title: 'Form Builder',
    fields: FormFields.list(),
    coverageOptions: (Settings.get('coverage_options') || '').split('\n').map((s) => s.trim()).filter(Boolean),
    healthCompanies: Companies.list(true).filter((c) => !c.insurance_type_name || c.insurance_type_name === 'Health'),
    vehicleCompanies: Companies.list(true).filter((c) => !c.insurance_type_name || c.insurance_type_name === 'Vehicle'),
  }));
});

router.post('/admin/form-builder/coverage', requireAdmin, (req, res) => {
  Settings.set('coverage_options', String(req.body.coverage_options || '').trim());
  req.session.flash = { type: 'success', message: 'Coverage options saved.' };
  res.redirect('/admin/form-builder');
});

router.post('/admin/form-builder/fields', requireAdmin, (req, res) => {
  const { field_key, label, field_type, options, is_required, sort_order } = req.body;
  if (!field_key || !label) {
    req.session.flash = { type: 'error', message: 'Key and label are required.' };
    return res.redirect('/admin/form-builder');
  }
  FormFields.create({
    field_key: String(field_key).trim().toLowerCase().replace(/\s+/g, '_'),
    label: String(label).trim(),
    field_type: field_type || 'text',
    options: options ? options.split('\n').map((s) => s.trim()).filter(Boolean) : null,
    is_required: is_required === '1' ? 1 : 0,
    sort_order: parseInt(sort_order) || 0,
  });
  req.session.flash = { type: 'success', message: 'Field added.' };
  res.redirect('/admin/form-builder');
});

router.post('/admin/form-builder/fields/:id', requireAdmin, (req, res) => {
  const { _method, label, field_type, options, is_required, is_active, sort_order } = req.body;
  if (_method === 'DELETE') {
    FormFields.remove(req.params.id);
    req.session.flash = { type: 'success', message: 'Field deleted.' };
  } else {
    FormFields.update(req.params.id, {
      label: label ? String(label).trim() : undefined,
      field_type: field_type || undefined,
      options: options !== undefined ? (options ? options.split('\n').map((s) => s.trim()).filter(Boolean) : null) : undefined,
      is_required: is_required !== undefined ? (is_required === '1' ? 1 : 0) : undefined,
      is_active: is_active !== undefined ? (is_active === '1' ? 1 : 0) : undefined,
      sort_order: sort_order !== undefined ? parseInt(sort_order) : undefined,
    });
    req.session.flash = { type: 'success', message: 'Field updated.' };
  }
  res.redirect('/admin/form-builder');
});

router.get('/admin/submissions', requireAdmin, (req, res) => {
  res.render('admin/submissions', layoutLocals(req, {
    title: 'Submissions',
    submissions: Submissions.list({ limit: 200 }),
    filter: req.query.status || '',
  }));
});

router.post('/admin/whatsapp/logout', requireAdmin, async (req, res) => {
  await whatsapp.logout();
  req.session.flash = { type: 'success', message: 'WhatsApp session logged out. Scan a new QR code.' };
  res.redirect('/admin');
});

router.post('/admin/whatsapp/reset-session', requireAdmin, async (req, res) => {
  try {
    await whatsapp.resetSession({ reason: 'admin reset-session' });
    req.session.flash = {
      type: 'success',
      message: 'WhatsApp session wiped (.wwebjs_auth / .wwebjs_cache). Wait for a fresh QR on the home page.',
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Reset failed: ${err.message}` };
  }
  res.redirect('/');
});

/** Convenience reset from the QR page (no admin login) for local linking recovery */
router.post('/whatsapp/reset-session', async (req, res) => {
  try {
    await whatsapp.resetSession({ reason: 'qr-page reset' });
    req.session.flash = {
      type: 'success',
      message: 'Session cleared. A new QR will appear shortly — scan it within ~20 seconds of it showing.',
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Reset failed: ${err.message}` };
  }
  res.redirect('/');
});

module.exports = router;
