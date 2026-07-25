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
} = require('../models');

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
    form_intro: 'Please fill out your insurance details using the secure form below.',
    confirmation_template:
      'Hi {{name}}, please confirm your details:\n\n• Name: {{name}}\n• Insurance Type: {{insurance_type}}\n• Company: {{company}}\n\nReply *Yes* to confirm or *No* to cancel.',
    forward_template:
      '📋 *New Insurance Lead*\n\n• Name: {{name}}\n• Phone: {{phone}}\n• Insurance Type: {{insurance_type}}\n• Company: {{company}}\n• Submitted: {{submitted_at}}',
    success_message: 'Thank you! Your details have been confirmed and forwarded to our team. We will contact you shortly.',
    cancel_message: 'Your request has been cancelled. Send *Hi* anytime to start again.',
    already_pending_message: 'You already have a pending request. Please complete the form or reply *Yes* / *No* to your confirmation message.',
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (Settings.get(key) === null) {
      Settings.set(key, value);
    }
  }

  if (InsuranceTypes.list().length === 0) {
    const health = InsuranceTypes.create({ name: 'Health', sort_order: 1 });
    const vehicle = InsuranceTypes.create({ name: 'Vehicle', sort_order: 2 });

    Companies.create({ name: 'Star Health', insurance_type_id: health.id, sort_order: 1 });
    Companies.create({ name: 'HDFC Ergo Health', insurance_type_id: health.id, sort_order: 2 });
    Companies.create({ name: 'Niva Bupa', insurance_type_id: health.id, sort_order: 3 });
    Companies.create({ name: 'ICICI Lombard', insurance_type_id: vehicle.id, sort_order: 1 });
    Companies.create({ name: 'Bajaj Allianz', insurance_type_id: vehicle.id, sort_order: 2 });
    Companies.create({ name: 'Go Digit', insurance_type_id: vehicle.id, sort_order: 3 });

    InternalNumbers.create({
      label: 'Default Desk',
      phone: '919999999999',
      is_default: 1,
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
  }

  if (ChatFlow.list().length === 0) {
    ChatFlow.create({
      trigger_keyword: 'hi,hello,hey,start',
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

  console.log('Database seeded successfully.');
  console.log(`Database path: ${db.name}`);
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
