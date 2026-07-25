/**
 * Natural bilingual (English + Malayalam) form-share openers.
 * Text and form link are always split into two WhatsApp messages.
 * Avoids repeating recent lines / key phrases; never injects "Future".
 */

const NATURAL_TEXT_OPENERS = [
  // English
  { lang: 'en', t: 'Done! Here is your form{{name_bit}}:' },
  { lang: 'en', t: 'Will share the link here, check this out{{name_bit}}:' },
  { lang: 'en', t: 'Okay, please fill this{{name_bit}}:' },
  { lang: 'en', t: 'Got it{{name_bit}} — please fill this form:' },
  { lang: 'en', t: 'Sure{{name_bit}}, here you go:' },
  { lang: 'en', t: 'Alright{{name_bit}}, open this and fill it in:' },
  { lang: 'en', t: 'Sharing the form now{{name_bit}}:' },
  { lang: 'en', t: 'Please complete this{{name_bit}}:' },
  { lang: 'en', t: 'One sec{{name_bit}}, sending the form:' },
  { lang: 'en', t: 'Cool{{name_bit}}, fill this when you can:' },
  { lang: 'en', t: 'Perfect{{name_bit}}, use this link:' },
  { lang: 'en', t: 'Noted{{name_bit}}. Form is below:' },
  { lang: 'en', t: 'Thanks{{name_bit}}, kindly fill the form:' },
  { lang: 'en', t: 'All set{{name_bit}}. Please open this:' },
  // Malayalam
  { lang: 'ml', t: 'ശരി{{name_bit}}, ഈ ഫോം ഫിൽ ചെയ്യൂ:' },
  { lang: 'ml', t: 'ഒന്ന് നോക്ക്{{name_bit}}, ലിങ്ക് ഇ അയയ്ക്കാം:' },
  { lang: 'ml', t: 'മനസ്സിലായി{{name_bit}}. ഈ ഫോം പൂരിപ്പിക്കൂ:' },
  { lang: 'ml', t: 'ഇത് ഫിൽ ചെയ്താൽ മതി{{name_bit}}:' },
  { lang: 'ml', t: 'ലിങ്ക് തരട്ടെ{{name_bit}} — താഴെ നോക്കൂ:' },
  { lang: 'ml', t: 'സൂപ്പർ{{name_bit}}, ഫോം ഇ അയയ്ക്കുന്നു:' },
  { lang: 'ml', t: 'കുറച്ച് സമയം എടുത്ത് ഇ പൂരിപ്പിക്കൂ{{name_bit}}:' },
  { lang: 'ml', t: 'നന്ദി{{name_bit}}, ഫോം പൂരിപ്പിച്ച് തരൂ:' },
  { lang: 'ml', t: 'ശരിയായി{{name_bit}}. ലിങ്ക് താഴെ അയയ്ക്കുന്നു:' },
  // Mixed EN + ML in one line
  { lang: 'mix', t: 'Okay{{name_bit}}, ഫോം ഇ തരാം:' },
  { lang: 'mix', t: 'ശരി{{name_bit}}, please fill this:' },
  { lang: 'mix', t: 'Done{{name_bit}} — ഫോം താഴെ:' },
  { lang: 'mix', t: 'Got it{{name_bit}}. ഫോം check ചെയ്യൂ:' },
  { lang: 'mix', t: 'Sure{{name_bit}}, ലിങ്ക് അയയ്ക്കാം:' },
  { lang: 'mix', t: 'Alright{{name_bit}}, ഇ complete ചെയ്യൂ:' },
];

const FORBIDDEN_WORDS = ['future'];

const _recentTemplates = [];
const _recentTokenHistory = [];
const _recentLangs = [];
const RECENT_TEMPLATE_MAX = 8;

function firstName(profileName) {
  const raw = String(profileName || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  const token = raw.split(/\s+/)[0] || '';
  const cleaned = token.replace(/[^\p{L}\p{N}._'-]/gu, '').slice(0, 40);
  if (!cleaned || FORBIDDEN_WORDS.includes(cleaned.toLowerCase())) return '';
  return cleaned;
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

function scrubForbidden(text) {
  let out = String(text || '');
  for (const w of FORBIDDEN_WORDS) {
    const re = new RegExp(`\\b${w}\\b`, 'gi');
    out = out.replace(re, '');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

const STOP_WORDS = new Set([
  'please',
  'form',
  'this',
  'here',
  'fill',
  'link',
  'okay',
  'done',
  'sure',
  'your',
  'with',
  'when',
  'that',
  'from',
  'have',
  'will',
  'share',
  'check',
  'open',
  'now',
  'below',
  'sending',
  'complete',
  'kindly',
  'thanks',
  'noted',
  'cool',
  'perfect',
  'alright',
  'got',
]);

function significantTokens(text) {
  return scrubForbidden(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function applyName(template, short) {
  const name_bit = short ? `, ${short}` : '';
  let out = String(template || '')
    .replace(/\{\{\s*form_link\s*\}\}/gi, '')
    .replace(/\{\{\s*name_bit\s*\}\}/gi, name_bit)
    .replace(/\{\{\s*name\s*\}\}/gi, short)
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[:：]\s*$/, ':');
  return scrubForbidden(out);
}

function recentTokenBag() {
  const bag = new Set();
  for (const toks of _recentTokenHistory) {
    for (const t of toks) bag.add(t);
  }
  return bag;
}

function scoreOverlap(template, short) {
  const rendered = applyName(template, short).toLowerCase();
  const tokens = significantTokens(rendered);
  const bag = recentTokenBag();
  let hits = 0;
  for (const t of tokens) {
    if (bag.has(t)) hits += 1;
  }
  return hits;
}

function rememberChoice(entry, short) {
  const tpl = entry.t;
  _recentTemplates.push(tpl);
  while (_recentTemplates.length > RECENT_TEMPLATE_MAX) _recentTemplates.shift();

  _recentLangs.push(entry.lang);
  while (_recentLangs.length > RECENT_TEMPLATE_MAX) _recentLangs.shift();

  _recentTokenHistory.push(significantTokens(applyName(tpl, short)));
  while (_recentTokenHistory.length > RECENT_TEMPLATE_MAX) _recentTokenHistory.shift();
}

function pickFreshOpener(short) {
  const lastLang = _recentLangs[_recentLangs.length - 1] || null;

  const ranked = NATURAL_TEXT_OPENERS.map((entry) => {
    const sameLang = lastLang && entry.lang === lastLang ? 1 : 0;
    return {
      entry,
      recent: _recentTemplates.includes(entry.t) ? 1 : 0,
      overlap: scoreOverlap(entry.t, short),
      sameLang,
    };
  }).sort(
    (a, b) =>
      a.recent - b.recent ||
      a.overlap - b.overlap ||
      a.sameLang - b.sameLang ||
      Math.random() - 0.5
  );

  const chosen = ranked[0]?.entry || NATURAL_TEXT_OPENERS[0];
  rememberChoice(chosen, short);
  return chosen.t;
}

/**
 * Split reply into natural text + bare URL (two messages).
 * @returns {{ text: string, link: string }}
 */
function buildNaturalFormParts({ name, formLink, customTemplate } = {}) {
  const link = scrubForbidden(String(formLink || '').trim());
  const short = firstName(name);
  const custom = scrubForbidden(String(customTemplate || '').trim());

  let text;
  if (custom && custom !== '{{form_link}}' && !/^access verified/i.test(custom)) {
    text = applyName(custom, short);
    if (!text || text === link) {
      text = applyName(pickFreshOpener(short), short);
    }
  } else {
    text = applyName(pickFreshOpener(short), short);
  }

  if (!text) text = 'Okay, please fill this:';
  text = scrubForbidden(text);
  return { text, link };
}

function buildNaturalFormReply(opts = {}) {
  const { text, link } = buildNaturalFormParts(opts);
  if (!link) return text;
  return scrubForbidden(`${text}\n${link}`);
}

module.exports = {
  NATURAL_TEXT_OPENERS: NATURAL_TEXT_OPENERS.map((e) => e.t),
  firstName,
  humanActionDelayMs,
  buildNaturalFormParts,
  buildNaturalFormReply,
  scrubForbidden,
};
