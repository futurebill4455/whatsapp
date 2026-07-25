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

const DEFAULT_FORWARD_TEMPLATE = `📋 *New Insurance Lead*

• Name: {{name}}
• Phone: {{phone}}
• Insurance Type: {{insurance_type}}
• Company: {{company}}
{{details}}
• Submitted: {{submitted_at}}`;

/**
 * Full desk-forward message from a submission (+ optional custom template).
 */
function buildForwardMessage(submission, template) {
  const vars = buildLeadVars(submission);
  return renderTemplate(template || DEFAULT_FORWARD_TEMPLATE, vars);
}

module.exports = {
  parseExtra,
  formatExtraDetails,
  buildLeadVars,
  renderTemplate,
  buildForwardMessage,
  DEFAULT_FORWARD_TEMPLATE,
};
