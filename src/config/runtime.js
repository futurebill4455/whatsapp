/**
 * Env-only runtime config — no database.
 */
function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function listFromEnv(key, fallback) {
  const raw = process.env[key];
  if (!raw || !String(raw).trim()) return fallback;
  return String(raw)
    .split(/[,|\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const config = {
  get businessName() {
    return process.env.BUSINESS_NAME || 'WhatsApp Bot';
  },
  get baseUrl() {
    const u = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(
      /\/$/,
      ''
    );
    return u;
  },
  get companyPhone() {
    return digits(process.env.COMPANY_PHONE || '');
  },
  get triggers() {
    return listFromEnv('TRIGGER_KEYWORDS', ['hi', 'hello', 'hey', 'start', 'ഹായ്']);
  },
  get closeKeywords() {
    return listFromEnv('CLOSE_KEYWORDS', ['close', 'ക്ലോസ്', 'stop', 'end']);
  },
  get adminUsername() {
    return process.env.ADMIN_USERNAME || 'admin';
  },
  get adminPassword() {
    return process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  },
  get formIntro() {
    return (
      process.env.FORM_INTRO ||
      'Please fill in your details. We will confirm on WhatsApp, then connect you with our team.'
    );
  },
  get linkMessage() {
    return (
      process.env.LINK_MESSAGE ||
      'Welcome to *{{business_name}}*! 👋\n\nPlease fill this short form:\n{{form_link}}'
    );
  },
  get confirmationPrompt() {
    return (
      process.env.CONFIRMATION_PROMPT ||
      'Please confirm your details:\n\n{{summary}}\n\nReply *Yes* to continue or *No* to cancel.'
    );
  },
  get successMessage() {
    return (
      process.env.SUCCESS_MESSAGE ||
      'Thanks! You are now connected with our team. Send *close* anytime to end the chat.'
    );
  },
  get cancelMessage() {
    return process.env.CANCEL_MESSAGE || 'Cancelled. Send *Hi* to start again.';
  },
  get closeMessage() {
    return process.env.CLOSE_MESSAGE || 'Chat closed. Send *Hi* anytime to start again.';
  },
  get companyNotifyTemplate() {
    return (
      process.env.COMPANY_NOTIFY_TEMPLATE ||
      '📋 *New enquiry* [#{{code}}]\n\n{{summary}}\n\nReply in this chat (quote or include [#{{code}}]) to message the customer.'
    );
  },
  get alreadyOpenMessage() {
    return (
      process.env.ALREADY_OPEN_MESSAGE ||
      'You already have an open chat. Send your message, or type *close* to end it.'
    );
  },
  get pendingFormMessage() {
    return (
      process.env.PENDING_FORM_MESSAGE ||
      'You already have a form waiting. Open your link or reply *No* to cancel.'
    );
  },
};

function renderTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

function isTrigger(text) {
  const n = String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
  return config.triggers.some((g) => n === g || n.startsWith(`${g} `));
}

function isClose(text) {
  const n = String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
  return config.closeKeywords.some((g) => n === g || n.startsWith(`${g} `));
}

function isYes(text) {
  return /^(yes|y|ok|okay|confirm|ഉവ്വ്|അതെ)$/i.test(
    String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
  );
}

function isNo(text) {
  return /^(no|n|cancel|nope|ഇല്ല)$/i.test(
    String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
  );
}

module.exports = {
  config,
  digits,
  renderTemplate,
  isTrigger,
  isClose,
  isYes,
  isNo,
};
