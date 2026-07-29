/**
 * WhatsApp interactive Buttons / List helpers for campaign replies.
 * Tries native wweb.js Buttons (≤3) or List (>3); callers should fall back to text.
 */
const { Buttons, List } = require('whatsapp-web.js');

function slugLabel(label, index = 0) {
  const slug = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 24);
  return `qr_${index}_${slug || 'btn'}`;
}

function parseButtonLabels(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
      else list = String(raw).split(/[,|]/);
    } catch (_) {
      list = String(raw).split(/[,|]/);
    }
  }
  return list
    .map((item, i) => {
      if (item && typeof item === 'object') {
        const label = String(item.label || item.body || item.title || '').trim();
        if (!label) return null;
        return {
          id: String(item.id || slugLabel(label, i)),
          label,
        };
      }
      const label = String(item || '').trim();
      if (!label) return null;
      return { id: slugLabel(label, i), label };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function buildQuickReplyFooter(labels) {
  const buttons = parseButtonLabels(labels);
  if (buttons.length < 1) {
    return `

———
Reply with:
*Interested* or *Not Interested*`;
  }
  const parts = buttons.map((b) => `*${b.label}*`).join(' or ');
  return `

———
Reply with:
${parts}`;
}

/**
 * Build a wweb.js Buttons (≤3) or List (>3) payload.
 */
function buildInteractivePayload(body, labels, opts = {}) {
  const buttons = parseButtonLabels(labels);
  if (!buttons.length) {
    throw new Error('No interactive buttons configured');
  }

  const title = opts.title || '';
  const footer = opts.footer || 'Tap a button to reply';
  const listButtonText = opts.listButtonText || 'Choose option';

  if (buttons.length <= 3) {
    return {
      mode: 'buttons',
      buttons,
      payload: new Buttons(
        body,
        buttons.map((b) => ({ id: b.id, body: b.label })),
        title || undefined,
        footer
      ),
    };
  }

  return {
    mode: 'list',
    buttons,
    payload: new List(
      typeof body === 'string' ? body : 'Please choose an option',
      listButtonText,
      [
        {
          title: title || 'Options',
          rows: buttons.map((b) => ({
            id: b.id,
            title: b.label.slice(0, 24),
            description: b.label.length > 24 ? b.label : '',
          })),
        },
      ],
      title || 'Options',
      footer
    ),
  };
}

/**
 * Detect an interactive button/list reply on an inbound Message.
 */
function extractInteractiveReply(message) {
  if (!message) return null;

  try {
    const selectedButtonId =
      message.selectedButtonId || message._data?.selectedButtonId;
    if (selectedButtonId) {
      const label =
        String(message.body || '').trim() ||
        String(
          message._data?.buttonText || message._data?.displayText || ''
        ).trim() ||
        String(selectedButtonId);
      return {
        id: String(selectedButtonId),
        label,
        source: 'button',
      };
    }
  } catch (_) {}

  try {
    const selectedRowId =
      message.selectedRowId ||
      message._data?.listResponse?.singleSelectReply?.selectedRowId;
    if (selectedRowId) {
      const label =
        String(message.body || '').trim() ||
        String(
          message._data?.listResponse?.title ||
            message._data?.listResponse?.description ||
            ''
        ).trim() ||
        String(selectedRowId);
      return {
        id: String(selectedRowId),
        label,
        source: 'list',
      };
    }
  } catch (_) {}

  const type = String(message.type || message._data?.type || '').toLowerCase();
  if (
    type.includes('button') ||
    type.includes('template_button') ||
    type === 'list_response'
  ) {
    const label = String(message.body || '').trim();
    if (label) {
      return {
        id: String(message._data?.selectedId || type),
        label,
        source: type,
      };
    }
  }

  return null;
}

function statusForLabel(label) {
  const n = String(label || '').toLowerCase();
  if (/not\s*interest|decline|reject/.test(n) || /^(no|2)$/.test(n)) {
    return 'replied_not_interested';
  }
  if (/interest|yes|more\s*detail|tell\s*me|\binfo\b/.test(n)) {
    if (/not/.test(n)) return 'replied_not_interested';
    return 'replied_interested';
  }
  const slug = n.replace(/[^a-z0-9]+/g, '_').slice(0, 40);
  return `replied_${slug || 'custom'}`;
}

/**
 * Map a reply label/id to a campaign recipient status using configured buttons.
 */
function classifyButtonReply(textOrId, configuredLabels) {
  const buttons = parseButtonLabels(configuredLabels);
  const raw = String(textOrId || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  const norm = raw.toLowerCase();
  if (!norm) return null;

  for (const b of buttons) {
    if (
      norm === b.label.toLowerCase() ||
      norm === b.id.toLowerCase() ||
      norm.includes(b.id.toLowerCase())
    ) {
      return statusForLabel(b.label);
    }
  }

  if (
    /^(interested|yes|1|i am interested|i'm interested)\b/.test(norm) ||
    norm === 'interested'
  ) {
    return 'replied_interested';
  }
  if (
    /^(not interested|no|2|not_interested)\b/.test(norm) ||
    norm === 'not interested'
  ) {
    return 'replied_not_interested';
  }

  if (buttons.some((b) => norm === b.label.toLowerCase())) {
    return statusForLabel(raw);
  }
  return null;
}

module.exports = {
  parseButtonLabels,
  buildQuickReplyFooter,
  buildInteractivePayload,
  extractInteractiveReply,
  classifyButtonReply,
  statusForLabel,
  slugLabel,
};
