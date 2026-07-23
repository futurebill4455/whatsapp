/**
 * Randomized reply variations — never spam the exact same static string.
 * Placeholders: {{name}}, {{business_name}}, {{form_link}}, {{phone}}, etc.
 */
const Settings = (() => {
  try {
    return require('../models').Settings;
  } catch (_) {
    return { get: (_k, fb) => fb };
  }
})();

function randPick(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function render(template, vars = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

/** Built-in pools (settings can append via JSON arrays). */
const BUILTIN = {
  form_welcome: [
    'Welcome to *{{business_name}}*!\n\nPlease fill your insurance details here:\n\n{{form_link}}',
    'Hi there — thanks for messaging *{{business_name}}*.\n\nUse this secure link to share your details:\n\n{{form_link}}',
    'Hello! *{{business_name}}* here.\n\nKindly complete the short form below and we will assist you:\n\n{{form_link}}',
    'Thanks for reaching out to *{{business_name}}*.\n\nPlease submit your enquiry using this link:\n\n{{form_link}}',
    'Good to hear from you.\n\n*{{business_name}}* — fill in your details here to continue:\n\n{{form_link}}',
  ],
  access_granted: [
    'Welcome *{{name}}*. Access granted. Send *Hi* to receive your form link.',
    'Hi *{{name}}* — you are verified. Reply *Hi* whenever you are ready for the form.',
    'Thanks *{{name}}*. Your access code worked. Send *Hi* to continue.',
    '*{{name}}*, you are all set. Message *Hi* to get your insurance form link.',
  ],
  access_denied: [
    'Please send your unique access code to continue.',
    'This chat is invite-only. Reply with your assigned access code to proceed.',
    'Hi *{{name}}*. Send your unique access code first, then we can continue.',
    'Almost there — please share your access code to unlock the form.',
  ],
  access_wrong_code: [
    'That access code is not valid for this number. Please check and try again.',
    'The code you sent does not match this phone. Double-check and resend.',
    'Incorrect access code for your number. Please try the code assigned to you.',
  ],
  already_pending: [
    'You already have a pending request. Please complete the form or reply *Yes* / *No* to your confirmation message.',
    'There is already an open request on your number. Finish the form, or reply *Yes* / *No* to the confirmation.',
    'Looks like a request is still pending. Complete the form or confirm with *Yes* / *No*.',
  ],
  chat_close: [
    'Thank you! Your conversation has been ended. Have a good day!',
    'Chat closed. Feel free to message again when you need assistance.',
    'All set — this conversation is now closed. Take care!',
  ],
  after_hours: [
    'Thanks for your message. Our team is available from {{hours_start}}:00 to {{hours_end}}:00. We will assist you during working hours.',
    'We are currently offline (working hours {{hours_start}}:00–{{hours_end}}:00). Please try again during those hours.',
  ],
};

function poolFromSettings(key) {
  const raw = Settings.get(`${key}_variations`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((s) => String(s)).filter(Boolean);
    }
  } catch (_) {
    // allow newline-separated
    return String(raw)
      .split(/\n---\n|\n\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Pick a varied template for a logical reply type.
 * Prefers built-in + settings pools; optionally blends a primary settings template.
 */
function pickTemplate(kind, primarySettingKey = null) {
  const builtin = BUILTIN[kind] || [];
  const fromSettings = poolFromSettings(kind);
  const primary =
    primarySettingKey != null ? Settings.get(primarySettingKey) : null;

  const pool = [...fromSettings, ...builtin];
  if (primary && String(primary).trim()) {
    // Include the admin template so custom wording still appears ~sometimes
    pool.push(String(primary).trim());
  }
  return randPick(pool) || primary || builtin[0] || '';
}

function pick(kind, vars = {}, primarySettingKey = null) {
  return render(pickTemplate(kind, primarySettingKey), {
    hours_start: Settings.get('anti_ban_hours_start', '9'),
    hours_end: Settings.get('anti_ban_hours_end', '21'),
    business_name: Settings.get('business_name', 'Insurance Bot'),
    ...vars,
  });
}

module.exports = {
  pick,
  pickTemplate,
  render,
  BUILTIN,
};
