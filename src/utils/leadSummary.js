/**
 * Shared lead summary helpers for WhatsApp confirmation + desk forwarding.
 */

function parseExtra(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function parseMembers(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function formatSubmittedAt(value) {
  if (!value) return new Date().toLocaleString('en-IN', { hour12: true });
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function dash(value) {
  const s = value == null ? '' : String(value).trim();
  return s || '—';
}

/** Keys that must never appear in desk lead summaries. */
const SENSITIVE_EXTRA_KEYS = new Set([
  'phone',
  'mobile',
  'msisdn',
  'whatsapp',
  'wa',
  'from',
  'peer',
  'peer_key',
  'peerkey',
  'sender',
  'sender_phone',
  'sender_mobile',
  'staff_phone',
  'staff_mobile',
  'agent_phone',
  'advisor_phone',
  'customer_phone',
  'customer_mobile',
  'customer_chat_id',
  'chat_id',
  'chatid',
  'wa_chat_id',
  'lid',
  'jid',
  'user_id',
  'userid',
  'internal_id',
  'wa_id',
]);

function isSensitiveKey(key) {
  const k = String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!k) return true;
  if (SENSITIVE_EXTRA_KEYS.has(k)) return true;
  return /phone|mobile|msisdn|whatsapp|chat[_\s-]?id|peer|sender|staff[_\s-]?phone|@c\.us|@lid|jid|wa_id|user[_\s-]?id/i.test(
    k
  );
}

/** Detect WhatsApp JIDs, LIDs, or bare phone-looking values. */
function looksLikePhoneOrChatId(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;
  if (/@(c\.us|lid|g\.us|s\.whatsapp\.net)\b/i.test(s)) return true;
  if (/^(wa:|tel:|raw:)/i.test(s)) return true;
  // 8–15 digit phone (optionally with + / spaces / dashes)
  const digits = s.replace(/[\s\-().+]/g, '');
  if (/^\d{8,15}$/.test(digits) && digits.length >= 10) return true;
  return false;
}

function scrubSensitiveObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (isSensitiveKey(key)) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    if (looksLikePhoneOrChatId(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Bullet list of health members for the desk lead card.
 */
function formatMemberList(submission) {
  const members = parseMembers(submission?.members_json);
  if (!members.length) return '—';
  return members
    .map((m, i) => {
      const name = dash(m.name);
      const dob = dash(m.dob);
      const gender = dash(m.gender);
      return `• ${i + 1}. ${name}\n  DOB: ${dob}  ·  Gender: ${gender}`;
    })
    .join('\n');
}

/**
 * Type-specific extras (vehicle / life / advisor / free-form).
 * Avoid space-padded columns — WhatsApp collapses them and looks squashed.
 */
function formatExtraDetails(submission, extra) {
  const lines = [];
  const type = String(submission?.insurance_type || '').toLowerCase();
  const members = parseMembers(submission?.members_json);
  const memberCount = submission?.member_count || extra.member_count;
  const premium =
    submission?.premium_amount || extra.premium_amount || extra.coverage_amount;

  const isHealth = type.includes('health') || members.length || memberCount;
  const isVehicle = type.includes('vehicle') || type.includes('motor');
  const isLife = type.includes('life');

  if (isVehicle) {
    if (extra.vehicle_number) {
      lines.push(`• Vehicle number: ${extra.vehicle_number}`);
    }
    if (extra.vehicle_model) {
      lines.push(`• Vehicle: ${extra.vehicle_model}`);
    }
    if (extra.manufacturing_year) {
      lines.push(`• Year: ${extra.manufacturing_year}`);
    }
    if (extra.vehicle_age != null && extra.vehicle_age !== '') {
      lines.push(`• Vehicle age: ${extra.vehicle_age} years`);
    }
    if (extra.policy_type) {
      lines.push(`• Policy type: ${extra.policy_type}`);
    }
    if (extra.insurance_company_name) {
      lines.push(`• Insurance company: ${extra.insurance_company_name}`);
    }
  }

  if (isLife) {
    if (extra.date_of_birth) {
      lines.push(`• Date of birth: ${extra.date_of_birth}`);
    }
    if (extra.plan_name) {
      lines.push(`• Plan name: ${extra.plan_name}`);
    }
    const yearly =
      extra.yearly_premium_amount ||
      (premium && premium !== '—' ? premium : null);
    if (yearly && !isHealth) {
      lines.push(`• Yearly premium: ${yearly}`);
    }
  }

  if (submission?.advisor_name || extra.advisor_name) {
    const advisor = String(
      submission?.advisor_name || extra.advisor_name || ''
    ).trim();
    // Never print advisor field if it's actually a phone / chat id
    if (advisor && !looksLikePhoneOrChatId(advisor)) {
      lines.push(`• Advisor: ${advisor}`);
    }
  }

  const skip = new Set([
    'member_count',
    'members',
    'premium_amount',
    'coverage_amount',
    'policy_duration',
    'duration',
    'advisor_name',
    'vehicle_model',
    'vehicle_number',
    'manufacturing_year',
    'vehicle_age',
    'policy_type',
    'insurance_company_name',
    'date_of_birth',
    'plan_name',
    'yearly_premium_amount',
    'company_id',
    'insurance_type_id',
  ]);
  for (const [key, value] of Object.entries(extra || {})) {
    if (skip.has(key) || value == null || value === '') continue;
    if (typeof value === 'object') continue;
    if (isSensitiveKey(key) || looksLikePhoneOrChatId(value)) continue;
    const label = key.replace(/_/g, ' ');
    lines.push(
      `• ${label.charAt(0).toUpperCase()}${label.slice(1)}: ${value}`
    );
  }

  return lines.join('\n');
}

/**
 * Build template vars for confirmation / forward messages from a submission row.
 */
function buildLeadVars(submission, overrides = {}) {
  const extraRaw = parseExtra(submission?.extra_json || submission?.extra_data);
  const extra = scrubSensitiveObject(extraRaw);
  const safeOverrides = scrubSensitiveObject(overrides || {});
  const insurance_type =
    safeOverrides.insurance_type ||
    overrides.insurance_type ||
    submission?.insurance_type ||
    '';
  const premium = dash(
    overrides.premium ??
      overrides.premium_amount ??
      submission?.premium_amount ??
      extraRaw.premium_amount ??
      extraRaw.coverage_amount
  );
  const duration = dash(
    overrides.duration ??
      overrides.policy_duration ??
      submission?.policy_duration ??
      extraRaw.policy_duration ??
      extraRaw.duration
  );
  const members_count = dash(
    overrides.members_count ??
      overrides.member_count ??
      submission?.member_count ??
      extraRaw.member_count
  );
  const member_details = formatMemberList(submission);
  const extra_details = formatExtraDetails(submission, extraRaw);

  const advisorRaw = String(
    overrides.advisor_name ||
      submission?.advisor_name ||
      extraRaw.advisor_name ||
      ''
  ).trim();
  const advisor_name =
    advisorRaw && !looksLikePhoneOrChatId(advisorRaw) ? advisorRaw : '';

  return {
    name: dash(overrides.name || submission?.customer_name),
    insurance_type: dash(insurance_type),
    company: dash(overrides.company || submission?.company),
    premium,
    premium_amount: premium,
    duration,
    policy_duration: duration,
    members_count,
    member_count: members_count,
    member_details,
    // legacy alias used by older templates
    details: [extra_details].filter(Boolean).join('\n'),
    extra_details,
    advisor_name: dash(advisor_name),
    submitted_at: formatSubmittedAt(
      overrides.submitted_at || submission?.submitted_at
    ),
    // scrubbed extras only — never reintroduce phones / chat ids
    ...extra,
    ...safeOverrides,
    // hard-lock sensitive placeholders to empty (legacy templates)
    phone: '',
    mobile: '',
    customer_phone: '',
    customer_chat_id: '',
    chat_id: '',
    peer: '',
    sender: '',
    from: '',
    staff_phone: '',
    premium,
    duration,
    members_count,
    member_details,
    extra_details,
    advisor_name: dash(advisor_name),
  };
}

/**
 * Render a template with {{placeholders}}. Empty details lines collapse cleanly.
 */
function renderTemplate(template, vars) {
  return String(template || '')
    .replace(/\{\{(\w+)\}\}/g, (_, key) =>
      vars[key] != null ? String(vars[key]) : ''
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove phone / mobile / chat-id / peer lines from a lead message body.
 * Final safety net after template render.
 */
function stripPhoneFromLeadMessage(text) {
  return String(text || '')
    .replace(/\{\{\s*(phone|mobile|customer_phone|customer_chat_id|chat_id|peer|from|sender|staff_phone)\s*\}\}/gi, '')
    .replace(
      /^.*\b(phone|mobile|whatsapp|chat\s*id|peer|sender|staff\s*phone|customer\s*chat|wa\s*id|user\s*id|jid|lid)\b\s*[:：].*$/gim,
      ''
    )
    // Bare WhatsApp JIDs / LIDs on their own line
    .replace(/^.*\d{6,}@(?:c\.us|lid|g\.us|s\.whatsapp\.net).*$/gim, '')
    // Lines that are mostly just a phone number
    .replace(/^[\s•*_]*[+]?[\d\s\-().]{10,18}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Clean multiline desk lead summary — no space-padded columns, no customer phone.
 * Renders cleanly across WhatsApp clients.
 */
const DEFAULT_FORWARD_TEMPLATE = `📋 *New Insurance Lead*
👤 *Name:* {{name}}
🏥 *Insurance:* {{insurance_type}}
🏢 *Company:* {{company}}
💰 *Sum Insured / Premium:* {{premium}}
⏳ *Duration:* {{duration}}
👥 *Members:* {{members_count}}

📝 *Member Details:*
{{member_details}}

{{extra_details}}

🕒 *Submitted:* {{submitted_at}}`;

/**
 * Clean a form URL for WhatsApp: bare http(s)://… only.
 * Strips soft hyphens, zero-width chars, and angle brackets.
 */
function sanitizeFormLink(url) {
  let s = String(url || '')
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .replace(/[<>]/g, '')
    .trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  const withoutScheme = s.replace(/^https?:\/\//i, '');
  if (withoutScheme.includes('/') && withoutScheme.replace(/\/+$/, '').includes('/')) {
    return s.replace(/\/+$/, '');
  }
  return s.replace(/\/+$/, '') || s;
}

/**
 * Full desk-forward message from a submission (+ optional custom template).
 * Always strips phone lines for privacy.
 */
function buildForwardMessage(submission, template) {
  const vars = buildLeadVars(submission);
  const raw = renderTemplate(template || DEFAULT_FORWARD_TEMPLATE, vars);
  return stripPhoneFromLeadMessage(raw);
}

module.exports = {
  parseExtra,
  parseMembers,
  formatExtraDetails,
  formatMemberList,
  formatSubmittedAt,
  buildLeadVars,
  renderTemplate,
  stripPhoneFromLeadMessage,
  sanitizeFormLink,
  buildForwardMessage,
  isSensitiveKey,
  looksLikePhoneOrChatId,
  scrubSensitiveObject,
  DEFAULT_FORWARD_TEMPLATE,
};
