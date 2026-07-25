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

/**
 * Format insurance-specific extra fields into clean bullet lines.
 */
function formatExtraDetails(submission, extra) {
  const lines = [];
  const type = String(submission?.insurance_type || '').toLowerCase();
  const members = parseMembers(submission?.members_json);
  const memberCount = submission?.member_count || extra.member_count;
  const premium =
    submission?.premium_amount || extra.premium_amount || extra.coverage_amount;
  const duration =
    submission?.policy_duration || extra.policy_duration || extra.duration;

  if (premium) lines.push(`• Sum insured / Premium : ${premium}`);
  if (duration) lines.push(`• Duration             : ${duration}`);

  if (type.includes('health') || members.length || memberCount) {
    if (memberCount) lines.push(`• Members              : ${memberCount}`);
    if (members.length) {
      lines.push('• Member details');
      members.forEach((m, i) => {
        const name = m.name || '—';
        const dob = m.dob || '—';
        const gender = m.gender || '—';
        lines.push(`   ${i + 1}. ${name}`);
        lines.push(`      DOB: ${dob}  ·  Gender: ${gender}`);
      });
    }
  }

  if (type.includes('vehicle') || type.includes('motor')) {
    if (extra.vehicle_model) lines.push(`• Vehicle              : ${extra.vehicle_model}`);
    if (extra.manufacturing_year) {
      lines.push(`• Year                 : ${extra.manufacturing_year}`);
    }
    if (extra.policy_type) lines.push(`• Policy type          : ${extra.policy_type}`);
  }

  if (submission?.advisor_name || extra.advisor_name) {
    lines.push(
      `• Advisor              : ${submission?.advisor_name || extra.advisor_name}`
    );
  }

  // Remaining free-form extras (skip ids / already rendered / phone)
  const skip = new Set([
    'member_count',
    'members',
    'premium_amount',
    'coverage_amount',
    'policy_duration',
    'duration',
    'advisor_name',
    'vehicle_model',
    'manufacturing_year',
    'policy_type',
    'company_id',
    'insurance_type_id',
    'phone',
    'customer_phone',
    'mobile',
  ]);
  for (const [key, value] of Object.entries(extra || {})) {
    if (skip.has(key) || value == null || value === '') continue;
    if (typeof value === 'object') continue;
    if (/phone|mobile|msisdn/i.test(key)) continue;
    const label = key.replace(/_/g, ' ');
    lines.push(`• ${label.charAt(0).toUpperCase()}${label.slice(1)} : ${value}`);
  }

  return lines.join('\n');
}

/**
 * Build template vars for confirmation / forward messages from a submission row.
 */
function buildLeadVars(submission, overrides = {}) {
  const extra = parseExtra(submission?.extra_json || submission?.extra_data);
  const insurance_type =
    overrides.insurance_type || submission?.insurance_type || '';
  const details = formatExtraDetails(submission, extra);

  return {
    name: overrides.name || submission?.customer_name || '—',
    // phone kept for legacy templates but stripped from forward output
    phone: '',
    insurance_type: insurance_type || '—',
    company: overrides.company || submission?.company || '—',
    premium_amount: submission?.premium_amount || extra.premium_amount || '',
    policy_duration: submission?.policy_duration || extra.policy_duration || '',
    advisor_name: submission?.advisor_name || extra.advisor_name || '',
    member_count: submission?.member_count || extra.member_count || '',
    submitted_at: formatSubmittedAt(
      overrides.submitted_at || submission?.submitted_at
    ),
    details,
    ...extra,
    ...overrides,
    phone: '', // never expose phone in desk lead summary
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
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Remove any phone / mobile lines from a lead message body. */
function stripPhoneFromLeadMessage(text) {
  return String(text || '')
    .replace(/\{\{\s*phone\s*\}\}/gi, '')
    .replace(/^.*\b(phone|mobile|whatsapp)\b\s*[:：].*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Clean, aligned desk lead summary — no customer phone number.
 */
const DEFAULT_FORWARD_TEMPLATE = `📋 *New Insurance Lead*

• Name         : {{name}}
• Insurance    : {{insurance_type}}
• Company      : {{company}}
{{details}}

_Submitted: {{submitted_at}}_`;

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
  formatSubmittedAt,
  buildLeadVars,
  renderTemplate,
  stripPhoneFromLeadMessage,
  sanitizeFormLink,
  buildForwardMessage,
  DEFAULT_FORWARD_TEMPLATE,
};
