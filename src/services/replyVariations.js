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
    '{{form_link}}',
  ],
  access_granted: [
    '{{form_link}}',
  ],
  access_denied: [
    'Please send your unique access code to continue.',
  ],
  access_wrong_code: [
    'That access code is not valid for this number. Please check and try again.',
  ],
  already_pending: [
    'You already have a pending request.',
  ],
  chat_close: [
    '',
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
