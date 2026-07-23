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

/**
 * Format insurance-specific extra fields into clean bullet lines.
 */
function formatExtraDetails(extra, type) {
  if (!extra || typeof extra !== 'object') return '';
  const lines = [];
  const t = String(type || '').toLowerCase();

  if (t === 'health') {
    if (extra.member_count) lines.push(`• Members: ${extra.member_count}`);
    if (extra.coverage_amount) lines.push(`• Coverage amount: ${extra.coverage_amount}`);
    if (extra.duration_days) lines.push(`• Duration: ${extra.duration_days} days`);
    if (Array.isArray(extra.members) && extra.members.length) {
      lines.push('• Member details:');
      extra.members.forEach((m, i) => {
        const name = m.name || '—';
        const dob = m.dob || '—';
        const gender = m.gender || '—';
        lines.push(`   ${i + 1}. ${name} | DOB: ${dob} | Gender: ${gender}`);
      });
    }
    // Legacy single-person health fields
    if (extra.age && !extra.members) lines.push(`• Age: ${extra.age}`);
    if (extra.existing_illnesses && !extra.members) {
      lines.push(`• Existing illnesses: ${extra.existing_illnesses}`);
    }
  } else if (t === 'vehicle') {
    if (extra.vehicle_model) lines.push(`• Vehicle: ${extra.vehicle_model}`);
    if (extra.manufacturing_year) lines.push(`• Year: ${extra.manufacturing_year}`);
    if (extra.policy_type) lines.push(`• Policy type: ${extra.policy_type}`);
    if (extra.coverage_amount) lines.push(`• Coverage amount: ${extra.coverage_amount}`);
    if (extra.duration_days) lines.push(`• Duration: ${extra.duration_days} days`);
  } else {
    // Generic fallback when type is unknown
    if (extra.coverage_amount) lines.push(`• Coverage amount: ${extra.coverage_amount}`);
    if (extra.duration_days) lines.push(`• Duration: ${extra.duration_days} days`);
    if (Array.isArray(extra.members) && extra.members.length) {
      lines.push('• Member details:');
      extra.members.forEach((m, i) => {
        const name = m.name || '—';
        const dob = m.dob || '—';
        const gender = m.gender || '—';
        lines.push(`   ${i + 1}. ${name} | DOB: ${dob} | Gender: ${gender}`);
      });
    }
    if (extra.vehicle_model) lines.push(`• Vehicle: ${extra.vehicle_model}`);
    if (extra.manufacturing_year) lines.push(`• Year: ${extra.manufacturing_year}`);
    if (extra.policy_type) lines.push(`• Policy type: ${extra.policy_type}`);
  }

  return lines.join('\n');
}

/**
 * Build template vars for confirmation / forward messages from a submission row.
 */
function buildLeadVars(submission, overrides = {}) {
  const extra = parseExtra(submission?.extra_data);
  const insurance_type = overrides.insurance_type || submission?.insurance_type || '';
  const details = formatExtraDetails(extra, insurance_type);

  return {
    name: overrides.name || submission?.customer_name || '—',
    phone: overrides.phone || submission?.customer_phone || '—',
    insurance_type: insurance_type || '—',
    company: overrides.company || submission?.company || '—',
    submitted_at:
      overrides.submitted_at ||
      submission?.form_submitted_at ||
      new Date().toISOString(),
    details,
    member_count: extra.member_count || '',
    coverage_amount: extra.coverage_amount || '',
    duration_days: extra.duration_days || '',
    ...extra,
    ...overrides,
  };
}

/**
 * Render a template with {{placeholders}}. Empty details lines collapse cleanly.
 */
function renderTemplate(template, vars) {
  return String(template || '')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DEFAULT_CONFIRMATION_TEMPLATE = `Hi {{name}}, please confirm your details:

• Name: {{name}}
• Insurance Type: {{insurance_type}}
• Company: {{company}}
{{details}}

*Is this correct?* Reply *Yes* or *No*.`;

const DEFAULT_FORWARD_TEMPLATE = `📋 *New Insurance Lead*

• Name: {{name}}
• Phone: {{phone}}
• Insurance Type: {{insurance_type}}
• Company: {{company}}
{{details}}
• Submitted: {{submitted_at}}`;

/**
 * Customer confirmation message from a submission (+ optional custom template).
 */
function buildConfirmationMessage(submission, template) {
  const vars = buildLeadVars(submission);
  return renderTemplate(template || DEFAULT_CONFIRMATION_TEMPLATE, vars);
}

/**
 * Full desk-forward message from a submission (+ optional custom template).
 */
function buildForwardMessage(submission, template) {
  const vars = buildLeadVars(submission);
  return renderTemplate(template || DEFAULT_FORWARD_TEMPLATE, vars);
}

/**
 * Strip soft hyphens / zero-width chars WhatsApp clients sometimes inject into long URLs.
 */
function sanitizeFormLink(url) {
  return String(url || '')
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

/**
 * Build a WhatsApp-safe form-link message.
 * Splits around {{form_link}} so the bare URL can be sent alone (avoids WhatsApp
 * soft-hyphenating long URLs mid-line). Prefer: intro → link → optional footer.
 */
function buildFormLinkParts(template, vars = {}) {
  const link = sanitizeFormLink(vars.form_link);
  const marker = '___FORM_LINK___';
  const rendered = renderTemplate(String(template || ''), {
    ...vars,
    form_link: marker,
  }).replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '');

  const idx = rendered.indexOf(marker);
  let intro;
  let footer = '';

  if (idx === -1) {
    intro = rendered.replace(/\n{3,}/g, '\n\n').trim() || 'Please fill out this short form:';
  } else {
    intro = rendered
      .slice(0, idx)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    footer = rendered
      .slice(idx + marker.length)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!intro) intro = 'Please fill out this short form:';
  }

  const combined = [intro, link, footer].filter(Boolean).join('\n\n');
  return { intro, link, footer, combined };
}

/**
 * Single-string version when a caller cannot send two messages.
 */
function formatFormLinkMessage(template, vars = {}) {
  return buildFormLinkParts(template, vars).combined;
}

module.exports = {
  parseExtra,
  formatExtraDetails,
  buildLeadVars,
  renderTemplate,
  buildConfirmationMessage,
  buildForwardMessage,
  sanitizeFormLink,
  buildFormLinkParts,
  formatFormLinkMessage,
  DEFAULT_CONFIRMATION_TEMPLATE,
  DEFAULT_FORWARD_TEMPLATE,
};
