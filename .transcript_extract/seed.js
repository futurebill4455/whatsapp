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
      trigger_keyword: 'hi,hello,hey,start,ഹായ്',
      response_template:
        'Welcome to *{{business_name}}*! 👋\n\nTo get started with your insurance enquiry, please fill out this short form:\n{{form_link}}\n\nOur team will assist you once you submit and confirm your details.',
      sort_order: 1,
    });
    ChatFlow.create({
      trigger_keyword: 'help',
      response_template:
        'Need help? Send *Hi* to receive your insurance form link, or contact our office during business hours.',
      sort_order: 2,
    });
  } else {
    // Ensure at least one active greeting trigger includes hi / ഹായ്
    const flows = ChatFlow.list(true);
    const hasHi = flows.some((f) =>
      String(f.trigger_keyword || '')
        .toLowerCase()
        .split(',')
        .map((k) => k.trim())
        .includes('hi')
    );
    if (!hasHi) {
      ChatFlow.create({
        trigger_keyword: 'hi,hello,hey,start,ഹായ്',
        response_template:
          'Welcome to *{{business_name}}*! 👋\n\nTo get started with your insurance enquiry, please fill out this short form:\n{{form_link}}\n\nOur team will assist you once you submit and confirm your details.',
        sort_order: 0,
      });
      console.log('Seeded missing greeting chat-flow trigger (hi / ഹായ്)');
    }
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
      description: 'Hi → form link → form submit → Yes/No → forward to desk',
      graph: buildDefaultWorkflowGraph(),
      is_active: 1,
    });
    console.log(`Default visual workflow created (#${wf.id})`);
  } else {
    // Keep form_submit confirmation text in sync with dynamic fields
    // and ensure trigger keywords always include greeting words
    const active = Workflows.getActive() || Workflows.list()[0];
    if (active?.graph?.drawflow?.Home?.data) {
      const data = active.graph.drawflow.Home.data;
      let changed = false;
      for (const node of Object.values(data)) {
        if (node.name === 'form_submit' && node.data) {
          const msg = node.data.confirmation_message || '';
          if (!msg.includes('{{details}}')) {
            node.data.confirmation_message =
              'Hi {{name}}, please confirm your details:\n\n• Name: {{name}}\n• Type: {{insurance_type}}\n• Company: {{company}}\n{{details}}\n\nReply *Yes* to confirm or *No* to cancel.';
            changed = true;
          }
        }
        if (node.name === 'send_form_link' && node.data) {
          node.data.message =
            node.data.message ||
            'Welcome to *{{business_name}}*! 👋\n\nPlease fill out your insurance details:\n{{form_link}}';
        }
        if (node.name === 'trigger_message' && node.data) {
          const kw = String(node.data.keywords || '').toLowerCase();
          const needed = ['hi', 'hello', 'hey', 'start', 'ഹായ്'];
          const missing = needed.filter((k) => !kw.split(',').map((x) => x.trim()).includes(k));
          if (missing.length || !kw.trim()) {
            const existing = String(node.data.keywords || '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            const merged = [...new Set([...needed, ...existing])];
            node.data.keywords = merged.join(',');
            changed = true;
            console.log(`Repaired workflow trigger keywords → ${node.data.keywords}`);
          }
        }
      }
      if (changed) {
        Workflows.saveGraph(active.id, active.graph);
        if (!active.is_active) Workflows.setActive(active.id);
        console.log('Updated active workflow graph defaults');
      }
    }
  }

  console.log('Database seeded successfully.');
  console.log(`Database path: ${db.name}`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
