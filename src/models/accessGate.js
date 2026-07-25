/**
 * Common access-code gate (Settings.common_access_code).
 * Only an exact match of the shared code unlocks the flow — everything else is ignored.
 */
const db = require('../config/db');

function settingsGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

const AccessGate = {
  /** Strip zero-width chars / spaces / punctuation; uppercase. " insu-2026 " → "INSU2026" */
  normalizeCode(code) {
    return String(code || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  },

  getCommonCode() {
    return this.normalizeCode(settingsGet('common_access_code', 'INSU2026'));
  },

  /**
   * Unlock only when the entire inbound message is exactly the common access code.
   * Greetings, wrong codes, and random chat → silent (ok: false).
   */
  tryUnlock(_phone, codeInput) {
    const expected = this.getCommonCode();
    if (!expected) {
      return { ok: false, reason: 'not_configured' };
    }

    const got = this.normalizeCode(codeInput);
    if (!got) {
      return { ok: false, reason: 'ignored' };
    }

    if (got === expected) {
      return { ok: true, reason: 'unlocked', matchedCode: expected };
    }

    // Never treat as a soft "wrong code" — caller must stay silent
    return { ok: false, reason: 'ignored', matchedCode: null };
  },
};

module.exports = { AccessGate };
