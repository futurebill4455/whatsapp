/**
 * Natural, human-sounding form-share openers (anti-bot phrasing).
 * Text and form link are always split into two WhatsApp messages.
 */

const NATURAL_TEXT_OPENERS = [
  'Done! Here is your form{{name_bit}}:',
  'Will share the link here, check this out{{name_bit}}:',
  'Okay, please fill this{{name_bit}}:',
  'Got it{{name_bit}} — please fill this form:',
  'Sure{{name_bit}}, here you go:',
  'Alright{{name_bit}}, open this and fill it in:',
  'Sharing the form now{{name_bit}}:',
  'Please complete this{{name_bit}}:',
  'One sec{{name_bit}}, sending the form:',
  'Cool{{name_bit}}, fill this when you can:',
];

function firstName(profileName) {
  const raw = String(profileName || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  const token = raw.split(/\s+/)[0] || '';
  return token.replace(/[^\p{L}\p{N}._'-]/gu, '').slice(0, 40);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  return a + Math.floor(Math.random() * (Math.max(b, a) - a + 1));
}

/** Randomized human gap between typing/sends (default 2–5s). */
function humanActionDelayMs(minMs = 2000, maxMs = 5000) {
  return randInt(minMs, maxMs);
}

function applyName(template, short) {
  const name_bit = short ? `, ${short}` : '';
  return String(template || '')
    .replace(/\{\{\s*form_link\s*\}\}/gi, '')
    .replace(/\{\{\s*name_bit\s*\}\}/gi, name_bit)
    .replace(/\{\{\s*name\s*\}\}/gi, short)
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[:：]\s*$/, ':');
}

/**
 * Split reply into natural text + bare URL (two messages).
 * @returns {{ text: string, link: string }}
 */
function buildNaturalFormParts({ name, formLink, customTemplate } = {}) {
  const link = String(formLink || '').trim();
  const short = firstName(name);
  const custom = String(customTemplate || '').trim();

  let text;
  if (
    custom &&
    custom !== '{{form_link}}' &&
    !/^access verified/i.test(custom)
  ) {
    // Custom copy without embedding the URL (link goes in message 2)
    text = applyName(custom, short);
    // If custom was only a link placeholder, fall back to random opener
    if (!text || text === link) {
      text = applyName(pick(NATURAL_TEXT_OPENERS), short);
    }
  } else {
    text = applyName(pick(NATURAL_TEXT_OPENERS), short);
  }

  if (!text) text = 'Okay, please fill this:';
  return { text, link };
}

/** @deprecated use buildNaturalFormParts — kept for any callers expecting a single string */
function buildNaturalFormReply(opts = {}) {
  const { text, link } = buildNaturalFormParts(opts);
  if (!link) return text;
  return `${text}\n${link}`.trim();
}

module.exports = {
  NATURAL_TEXT_OPENERS,
  firstName,
  humanActionDelayMs,
  buildNaturalFormParts,
  buildNaturalFormReply,
};
