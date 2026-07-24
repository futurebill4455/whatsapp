require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const {
  Admins,
  Settings,
  AccessUsers,
  InsuranceTypes,
  Companies,
  PremiumOptions,
  DurationOptions,
  FormFields,
  Workflows,
} = require('../models');
const { buildDefaultWorkflowGraph } = require('../services/workflowDefaults');
const { DEFAULT_FORWARD_TEMPLATE } = require('./leadSummary');

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
    forward_template: DEFAULT_FORWARD_TEMPLATE,
    anti_ban_jitter_min_ms: '4000',
    anti_ban_jitter_max_ms: '30000',
    anti_ban_min_gap_ms: '4000',
    anti_ban_hours_enabled: '1',
    anti_ban_hours_start: '9',
    anti_ban_hours_end: '21',
    anti_ban_timezone: 'Asia/Kolkata',
    close_keywords: 'close,cls',
    form_intro:
      'Select Health or Vehicle insurance. The form guides you step-by-step.',
    success_message:
      'Thank you! Your details have been forwarded to our team.\n\nYou can now chat with the insurance desk. Send *close* (or *cls*) anytime to end the chat.',
    chat_close_message: 'Thank you! Your conversation has been ended. Have a good day!',
    company_close_notify_message:
      'Customer ended the chat [#{{session_code}}] ({{customer_phone}}).\nSession closed.',
    access_denied_message:
      'This number is not authorized. Please contact your advisor for an access code.',
    access_wrong_code_message:
      'That access code does not match. Please check with your advisor and try again.',
    access_granted_message: 'Access verified. Sending your form link…',
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (Settings.get(key) === null) {
      Settings.set(key, value);
    }
  }

  // Keep close keywords normalized to close,cls when empty/missing
  const closeKw = Settings.get('close_keywords');
  if (closeKw == null || String(closeKw).trim() === '') {
    Settings.set('close_keywords', 'close,cls');
  }

  if (InsuranceTypes.list().length === 0) {
    const health = InsuranceTypes.create({ name: 'Health', sort_order: 1 });
    const vehicle = InsuranceTypes.create({ name: 'Vehicle', sort_order: 2 });

    Companies.create({
      name: 'Star Health',
      insurance_type_id: health.id,
      desk_phone: '919888888888',
      sort_order: 1,
    });
    Companies.create({
      name: 'HDFC Ergo Health',
      insurance_type_id: health.id,
      desk_phone: '919888888888',
      sort_order: 2,
    });
    Companies.create({
      name: 'Niva Bupa',
      insurance_type_id: health.id,
      desk_phone: '919888888888',
      sort_order: 3,
    });
    Companies.create({
      name: 'ICICI Lombard',
      insurance_type_id: vehicle.id,
      desk_phone: '919777777777',
      sort_order: 1,
    });
    Companies.create({
      name: 'Bajaj Allianz',
      insurance_type_id: vehicle.id,
      desk_phone: '919777777777',
      sort_order: 2,
    });
    Companies.create({
      name: 'Go Digit',
      insurance_type_id: vehicle.id,
      desk_phone: '919777777777',
      sort_order: 3,
    });
  }

  if (PremiumOptions.list().length === 0) {
    const premiums = [
      { label: '₹5 Lakh', value: '5L', sort_order: 1 },
      { label: '₹10 Lakh', value: '10L', sort_order: 2 },
      { label: '₹15 Lakh', value: '15L', sort_order: 3 },
      { label: '₹20 Lakh', value: '20L', sort_order: 4 },
      { label: '₹25 Lakh', value: '25L', sort_order: 5 },
      { label: '₹30 Lakh', value: '30L', sort_order: 6 },
      { label: '₹40 Lakh', value: '40L', sort_order: 7 },
    ];
    for (const p of premiums) PremiumOptions.create(p);
  }

  if (DurationOptions.list().length === 0) {
    DurationOptions.create({ label: '1 Year', value: '1', sort_order: 1 });
    DurationOptions.create({ label: '2 Year', value: '2', sort_order: 2 });
    DurationOptions.create({ label: '3 Year', value: '3', sort_order: 3 });
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
      field_key: 'advisor_name',
      label: 'Advisor Name',
      field_type: 'text',
      is_required: 0,
      sort_order: 2,
    });
    FormFields.create({
      field_key: 'insurance_type',
      label: 'Insurance Type',
      field_type: 'select_insurance_type',
      is_required: 1,
      sort_order: 3,
    });
    FormFields.create({
      field_key: 'company',
      label: 'Insurance Company',
      field_type: 'select_company',
      is_required: 1,
      sort_order: 4,
    });
    FormFields.create({
      field_key: 'premium_amount',
      label: 'Sum Insured / Premium',
      field_type: 'select_premium',
      is_required: 1,
      sort_order: 5,
    });
    FormFields.create({
      field_key: 'policy_duration',
      label: 'Policy Duration',
      field_type: 'select_duration',
      is_required: 1,
      sort_order: 6,
    });
    FormFields.create({
      field_key: 'member_count',
      label: 'Number of Members',
      field_type: 'number',
      is_required: 0,
      sort_order: 7,
    });
  }

  if (AccessUsers.list().length === 0) {
    AccessUsers.create({
      name: 'Demo User',
      phone: '919999999999',
      access_code: 'INSU2026',
    });
    console.log('Seeded demo access user: Demo User / 919999999999 / INSU2026');
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
    const active = Workflows.getActive();
    if (!active) {
      const first = Workflows.list()[0];
      if (first) {
        Workflows.setActive(first.id);
        console.log(`Activated workflow #${first.id}`);
      }
    }
  }

  console.log('Database seeded successfully.');
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
