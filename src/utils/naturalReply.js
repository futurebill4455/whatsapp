/**
 * Natural, human-sounding form-share openers (anti-bot phrasing).
 * Uses WhatsApp profile name when available.
 */

const NATURAL_FORM_OPENERS = [
  'Done! Here is your form{{name_bit}}:\n{{form_link}}',
  'Will share the link here, check this out{{name_bit}}:\n{{form_link}}',
  'Okay, please fill this{{name_bit}}:\n{{form_link}}',
  'Got it{{name_bit}} — please fill this form:\n{{form_link}}',
  'Sure{{name_bit}}, here you go:\n{{form_link}}',
  'Alright{{name_bit}}, open this and fill it in:\n{{form_link}}',
  'Sharing the form now{{name_bit}}:\n{{form_link}}',
  'Please complete this{{name_bit}}:\n{{form_link}}',
];

/** Robotic phrases we never send as a separate first reply. */
const ROBOTIC_GRANTED_PATTERNS = [
  /^access verified/i,
  /^access granted/i,
  /sending your form link/i,
  /^verified\.?\s*$/i,
];

function isRoboticGrantedMessage(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return ROBOTIC_GRANTED_PATTERNS.some((re) => re.test(t));
}

function firstName(profileName) {
  const raw = String(profileName || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  // Take first token; strip emoji-heavy wrappers lightly
  const token = raw.split(/\s+/)[0] || '';
  return token.replace(/[^\p{L}\p{N}._'-]/gu, '').slice(0, 40);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Build one natural WhatsApp message that includes the form link.
 * @param {{ name?: string, formLink: string, customTemplate?: string }} opts
 */
function buildNaturalFormReply({ name, formLink, customTemplate } = {}) {
  const link = String(formLink || '').trim();
  if (!link) return '';

  const short = firstName(name);
  const name_bit = short ? `, ${short}` : '';
  const vars = {
    name: short,
    name_bit,
    form_link: link,
  };

  const custom = String(customTemplate || '').trim();
  // Bare {{form_link}} or empty → use randomized natural openers
  const useCustom =
    custom &&
    custom !== '{{form_link}}' &&
    !/^access verified/i.test(custom);

  const template = useCustom ? custom : pick(NATURAL_FORM_OPENERS);

  let out = template;
  out = out.replace(/\{\{\s*form_link\s*\}\}/gi, link);
  out = out.replace(/\{\{\s*name_bit\s*\}\}/gi, name_bit);
  out = out.replace(/\{\{\s*name\s*\}\}/gi, short);
  // If custom forgot the link, append it
  if (!out.includes(link)) {
    out = `${out.trim()}\n${link}`;
  }
  return out.trim();
}

module.exports = {
  NATURAL_FORM_OPENERS,
  isRoboticGrantedMessage,
  firstName,
  buildNaturalFormReply,
};
