require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const {
  Admins,
  Settings,
  InsuranceTypes,
  Companies,
  InternalNumbers,
  ChatFlow,
  FormFields,
  Workflows,
} = require('../models');
const { buildDefaultWorkflowGraph } = require('../services/workflowDefaults');

function seed() {
  if (Admins.count() === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    Admins.create({
      username,
      password_hash: bcrypt.hashSync(password, 10),
    });
    console.log(`Admin created: ${username}`);
  }

  const defaults = {
    business_name: 'SecureLife Insurance',
    greeting_enabled: '1',
    form_intro: 'Select Health or Vehicle insurance. The form guides you step-by-step — for Health you can add up to 5 members.',
    coverage_options: '₹2 Lakh\n₹3 Lakh\n₹5 Lakh\n₹10 Lakh\n₹25 Lakh\n₹50 Lakh\n₹1 Crore',
    confirmation_template:
      'Hi {{name}}, please confirm your details:\n\n• Name: {{name}}\n• Insurance Type: {{insurance_type}}\n• Company: {{company}}\n{{details}}\n\n*Is this correct?* Reply *Yes* or *No*.',
    forward_template:
      '📋 *New Insurance Lead*\n\n• Name: {{name}}\n• Phone: {{phone}}\n• Insurance Type: {{insurance_type}}\n• Company: {{company}}\n{{details}}\n• Submitted: {{submitted_at}}',
    success_message:
      'Thank you! Your details have been confirmed and forwarded to our team.\n\nYou can now chat with the insurance desk in this conversation. Send *close* (or *ക്ലോസ്*) anytime to end the chat.',
    chat_close_message: 'Thank you! Your conversation has been ended. Have a good day!',
    company_close_notify_message:
      'Customer ended the chat [#{{session_code}}] ({{customer_phone}}).\nSession closed.',
    cancel_message: 'Your request has been cancelled. Send *Hi* anytime to start again.',
    already_pending_message: 'You already have a pending request. Please complete the form or reply *Yes* / *No* to your confirmation message.',
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (Settings.get(key) === null) {
      Settings.set(key, value);
    }
  }

  // Keep success message mentioning live chat + close
  const success = Settings.get('success_message') || '';
  if (!success.toLowerCase().includes('close')) {
    Settings.set('success_message', defaults.success_message);
  }
  if (Settings.get('chat_close_message') === null) {
    Settings.set('chat_close_message', defaults.chat_close_message);
  }

  // Ensure confirmation/forward templates include {{details}} for dynamic form fields
  const conf = Settings.get('confirmation_template') || '';
  if (!conf.includes('{{details}}') || !conf.toLowerCase().includes('is this correct')) {
    Settings.set('confirmation_template', defaults.confirmation_template);
  }
  const fwd = Settings.get('forward_template') || '';
  if (!fwd.includes('{{details}}')) {
    Settings.set('forward_template', defaults.forward_template);
  }
  Settings.set('form_intro', defaults.form_intro);
  if (Settings.get('coverage_options') === null) {
    Settings.set('coverage_options', defaults.coverage_options);
  }

  if (InsuranceTypes.list().length === 0) {
    const health = InsuranceTypes.create({ name: 'Health', sort_order: 1 });
    const vehicle = InsuranceTypes.create({ name: 'Vehicle', sort_order: 2 });

    Companies.create({ name: 'Star Health', insurance_type_id: health.id, desk_phone: '919888888888', sort_order: 1 });
    Companies.create({ name: 'HDFC Ergo Health', insurance_type_id: health.id, desk_phone: '919888888888', sort_order: 2 });
    Companies.create({ name: 'Niva Bupa', insurance_type_id: health.id, desk_phone: '919888888888', sort_order: 3 });
    Companies.create({ name: 'ICICI Lombard', insurance_type_id: vehicle.id, desk_phone: '919777777777', sort_order: 1 });
    Companies.create({ name: 'Bajaj Allianz', insurance_type_id: vehicle.id, desk_phone: '919777777777', sort_order: 2 });
    Companies.create({ name: 'Go Digit', insurance_type_id: vehicle.id, desk_phone: '919777777777', sort_order: 3 });

    InternalNumbers.create({
      label: 'Default Desk',
      phone: '919999999999',
      is_default: 1,
    });
    InternalNumbers.create({
      label: 'Star Health',
      phone: '919888888888',
      insurance_type_id: health.id,
    });
    InternalNumbers.create({
      label: 'Health Desk',
      phone: '919888888888',
      insurance_type_id: health.id,
    });
    InternalNumbers.create({
      label: 'Vehicle Desk',
      phone: '919777777777',
      insurance_type_id: vehicle.id,
    });
  } else {
    // Ensure existing companies can store desk phones (no-op if already set)
    const healthDesk = InternalNumbers.list(true).find((n) =>
      /health|star/i.test(n.label)
    );
    const vehicleDesk = InternalNumbers.list(true).find((n) =>
      /vehicle|motor/i.test(n.label)
    );
    for (const c of Companies.list()) {
      if (!c.desk_phone) {
        const phone =
          /health|star|niva|hdfc|bupa/i.test(c.name)
            ? healthDesk?.phone
            : /vehicle|lombard|bajaj|digit/i.test(c.name)
              ? vehicleDesk?.phone
              : null;
        if (phone) Companies.update(c.id, { desk_phone: phone });
      }
    }
  }

  if (ChatFlow.list().length === 0) {
    ChatFlow.create({
      trigger_keyword: 'brochure,pamphlet',
      response_template:
        'Thanks for your interest. Please send your assigned ACCESS_CODE to receive the insurance form link.',
      sort_order: 10,
    });
  }

  if (FormFields.list().length === 0) {
    FormFields.create({
      field_key: 'customer_name',
      label: 'Full Name',
      field_type: 'text',
      is_required: 1,
      sort_order: 1,
    });
    FormFields.create({
      field_key: 'insurance_type',
      label: 'Insurance Type',
      field_type: 'select_insurance_type',
      is_required: 1,
      sort_order: 2,
    });
    FormFields.create({
      field_key: 'company',
      label: 'Insurance Company',
      field_type: 'select_company',
      is_required: 1,
      sort_order: 3,
    });
  }

  if (Workflows.count() === 0) {
    const wf = Workflows.create({
      name: 'Insurance Lead Intake',
      description: 'Unique ACCESS_CODE → bare form → company desk',
      graph: buildDefaultWorkflowGraph(),
      is_active: 1,
    });
    console.log(`Default visual workflow created (#${wf.id})`);
  } else {
    // Migrate triggers: drop hi/hello/* catch-alls → unique ACCESS_CODE mode
    let migrated = 0;
    for (const row of Workflows.list()) {
      const wf = Workflows.get(row.id);
      const data = wf?.graph?.drawflow?.Home?.data;
      if (!data) continue;
      let changed = false;
      for (const node of Object.values(data)) {
        if (node.name !== 'trigger_message' || !node.data) continue;
        const kw = String(node.data.keywords || '').toLowerCase();
        const mode = String(node.data.trigger_mode || node.data.mode || '').toLowerCase();
        const looksGeneric =
          !mode ||
          mode === 'keywords' ||
          /hi|hello|hey|start|\*|any|all|ഹായ്/.test(kw) ||
          kw.includes('*,any');
        if (looksGeneric || mode !== 'access_code') {
          node.data.trigger_mode = 'access_code';
          node.data.mode = 'access_code';
          node.data.keywords = '';
          node.data.label = 'When unique access code received';
          changed = true;
        }
      }
      if (changed) {
        Workflows.saveGraph(wf.id, wf.graph);
        migrated += 1;
      }
    }
    if (migrated) {
      console.log(`Migrated ${migrated} workflow(s) to ACCESS_CODE-only triggers`);
    }

    const active = Workflows.getActive();
    if (!active) {
      const first = Workflows.list()[0];
      if (first) {
        Workflows.setActive(first.id);
        console.log(`Activated workflow #${first.id}`);
      }
    }
  }

  // Greeting keywords must not start the workflow (access code only)
  const tk = String(Settings.get('trigger_keywords') || '');
  if (/hi|hello|hey|start/i.test(tk)) {
    Settings.set('trigger_keywords', '');
    console.log('Cleared generic trigger_keywords (workflow uses ACCESS_CODE only)');
  }

  console.log('Database seeded successfully.');
  console.log(`Database path: ${db.name}`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
