/**
 * Parse contacts from CSV / Excel / pasted text.
 */
const XLSX = require('xlsx');

function digits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Prefix country code (e.g. 91) onto local numbers that lack it.
 * Leaves numbers that already start with the code unchanged.
 */
function applyCountryCode(phone, countryCode) {
  const dig = digits(phone);
  const code = digits(countryCode);
  if (!dig) return '';
  if (!code) return dig;
  if (dig.startsWith(code)) return dig;
  // Strip leading 0 from local trunk (0XXXXXXXXXX)
  const local = dig.replace(/^0+/, '');
  if (local.startsWith(code)) return local;
  return code + local;
}

function applyCountryCodeToRows(rows, countryCode) {
  return (rows || []).map((r) => ({
    ...r,
    phone: applyCountryCode(r.phone, countryCode),
  })).filter((r) => r.phone && r.phone.length >= 8);
}

function rowFromObject(obj) {
  const keys = Object.keys(obj || {});
  const lower = {};
  for (const k of keys) lower[String(k).trim().toLowerCase()] = obj[k];

  const phone =
    lower.phone ||
    lower.mobile ||
    lower.number ||
    lower.whatsapp ||
    lower.contact ||
    lower['phone number'] ||
    lower['mobile number'] ||
    '';
  const name =
    lower.name ||
    lower.customer ||
    lower['full name'] ||
    lower.customer_name ||
    '';
  const tags = lower.tags || lower.tag || lower.group || '';

  return {
    phone: digits(phone),
    name: name ? String(name).trim() : null,
    tags: tags ? String(tags).trim() : null,
  };
}

/**
 * Paste formats:
 *  - one phone per line
 *  - name,phone
 *  - phone name
 */
function parsePastedText(text) {
  const rows = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^phone\b/i.test(line) || /^name\b/i.test(line)) continue;

    let name = null;
    let phone = null;

    if (line.includes(',')) {
      const parts = line.split(',').map((p) => p.trim());
      if (digits(parts[0]).length >= 8 && digits(parts[1] || '').length < 8) {
        phone = digits(parts[0]);
        name = parts[1] || null;
      } else {
        name = parts[0] || null;
        phone = digits(parts[1] || parts[0]);
      }
    } else if (/\s+/.test(line)) {
      const parts = line.split(/\s+/);
      const maybePhone = parts.find((p) => digits(p).length >= 8);
      phone = digits(maybePhone || '');
      name = parts.filter((p) => p !== maybePhone).join(' ') || null;
    } else {
      phone = digits(line);
    }

    if (phone && phone.length >= 8) {
      rows.push({ phone, name, tags: null });
    }
  }
  return rows;
}

function parseCsvBuffer(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return json.map(rowFromObject).filter((r) => r.phone && r.phone.length >= 8);
}

function parseExcelBuffer(buf) {
  return parseCsvBuffer(buf);
}

function contactsToCsv(contacts) {
  const header = 'name,phone,tags\n';
  const lines = (contacts || []).map((c) => {
    const name = String(c.name || '').replace(/"/g, '""');
    const phone = String(c.phone || '');
    const tags = String(c.tags || '').replace(/"/g, '""');
    return `"${name}",${phone},"${tags}"`;
  });
  return header + lines.join('\n');
}

module.exports = {
  parsePastedText,
  parseCsvBuffer,
  parseExcelBuffer,
  contactsToCsv,
  rowFromObject,
  digits,
  applyCountryCode,
  applyCountryCodeToRows,
};
