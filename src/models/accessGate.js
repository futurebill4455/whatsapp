/**
 * Common access-code gate (Settings.common_access_code).
 * No per-user phone whitelist — any sender with the shared code starts the flow.
 */
const db = require('../config/db');

function settingsGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

const AccessGate = {
  normalizeCode(code) {
    return String(code || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  },

  codeCandidatesFromMessage(raw) {
    const text = String(raw || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const out = [];
    const push = (v) => {
      const n = this.normalizeCode(v);
      if (n && n.length >= 3 && !out.includes(n)) out.push(n);
    };
    if (!text) return out;
    push(text);
    for (const tok of text.split(/[\s,;|:@#]+/)) push(tok);
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length > 1) push(parts[parts.length - 1]);
    return out;
  },

  getCommonCode() {
    return this.normalizeCode(settingsGet('common_access_code', 'INSU2026'));
  },

  /** Compare inbound WhatsApp text to the shared admin-configured code. */
  tryUnlock(_phone, codeInput) {
    const expected = this.getCommonCode();
    if (!expected) {
      return { ok: false, reason: 'not_configured' };
    }

    const candidates = this.codeCandidatesFromMessage(codeInput);
    if (!candidates.length) {
      return { ok: false, reason: 'invalid_input' };
    }

    if (candidates.includes(expected)) {
      return { ok: true, reason: 'unlocked', matchedCode: expected };
    }

    const looksLikeCode = candidates.some((c) => c.length >= 4);
    return {
      ok: false,
      reason: looksLikeCode ? 'wrong_code' : 'noise',
      matchedCode: null,
    };
  },
};

module.exports = { AccessGate };
