/**
 * Enterprise anti-ban / humanization layer for WhatsApp automation.
 * - 5–12s jitter on outbound
 * - Reading delay ∝ inbound length, then typing indicator
 * - Working-hours gate
 * - Per-user hourly/daily caps + global outbound gap
 */
const Settings = (() => {
  try {
    return require('../models').Settings;
  } catch (_) {
    return { get: (_k, fb) => fb };
  }
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function randInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return a + Math.floor(Math.random() * (Math.max(b, a) - a + 1));
}

function numSetting(key, fallback, envAliases = []) {
  for (const envKey of envAliases) {
    if (process.env[envKey] != null && process.env[envKey] !== '') {
      const n = Number(process.env[envKey]);
      if (Number.isFinite(n)) return n;
    }
  }
  const upper = key.toUpperCase();
  if (process.env[upper] != null && process.env[upper] !== '') {
    const n = Number(process.env[upper]);
    if (Number.isFinite(n)) return n;
  }
  const raw = Settings.get(key);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Primary human jitter: 5–12 seconds (settings / env override). */
function humanJitterMs() {
  const min = numSetting('anti_ban_jitter_min_ms', 5000, ['WA_JITTER_MIN_MS']);
  const max = numSetting('anti_ban_jitter_max_ms', 12000, ['WA_JITTER_MAX_MS']);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return randInt(lo, hi);
}

/** Extra pause between different customers / queue slots. */
function sessionSpacingMs() {
  const min = Number(process.env.WA_SESSION_GAP_MIN_MS || 2000);
  const max = Number(process.env.WA_SESSION_GAP_MAX_MS || 5000);
  return randInt(Math.min(min, max), Math.max(min, max));
}

/**
 * Simulate reading the inbound message before composing a reply.
 * Longer messages → longer pause (clamped for realism).
 */
function readingDelayMs(inboundText) {
  const len = String(inboundText || '').length;
  // ~180–280 chars/min reading + short “think”
  const base = 700 + Math.min(len, 500) * 28;
  const jitter = randInt(250, 1100);
  return Math.min(10000, Math.max(800, base + jitter));
}

/**
 * How long to keep the typing indicator before send.
 * Roughly proportional to outbound message length.
 */
function typingDurationMs(text) {
  const len = String(text || '').length;
  const base = 1400 + Math.min(len, 320) * 38;
  const jitter = randInt(300, 1100);
  return Math.min(12000, Math.max(1800, base + jitter));
}

function recordingDurationMs() {
  return randInt(2000, 5200);
}

/**
 * True when current local time (configured timezone) is inside working hours.
 * Default: 09:00–21:00 Asia/Kolkata.
 */
function isWithinWorkingHours(now = new Date()) {
  if (Settings.get('anti_ban_hours_enabled', '1') === '0') return true;

  const tz = Settings.get('anti_ban_timezone') || 'Asia/Kolkata';
  const start = numSetting('anti_ban_hours_start', 9);
  const end = numSetting('anti_ban_hours_end', 21);

  let hour = 12;
  let minute = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
    minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    // en-GB may return 24 for midnight in some engines
    if (hour === 24) hour = 0;
  } catch (err) {
    console.warn('[AntiBan] Timezone resolve failed, using server local hour:', err.message);
    hour = now.getHours();
    minute = now.getMinutes();
  }

  const mins = hour * 60 + minute;
  const startM = Math.max(0, Math.min(24, start)) * 60;
  const endM = Math.max(0, Math.min(24, end)) * 60;
  if (startM === endM) return true; // misconfigured → allow
  if (startM < endM) return mins >= startM && mins < endM;
  // Overnight window e.g. 22 → 6
  return mins >= startM || mins < endM;
}

function getRateCaps() {
  return {
    perUserHourly: numSetting('anti_ban_hourly_cap', 18),
    perUserDaily: numSetting('anti_ban_daily_cap', 60),
    globalHourly: numSetting('anti_ban_global_hourly_cap', 220),
  };
}

/**
 * Check MessageLog volume caps. Returns { ok, reason }.
 */
function checkSendCaps(phone) {
  let MessageLog;
  try {
    MessageLog = require('../models').MessageLog;
  } catch (_) {
    return { ok: true };
  }

  const digits = String(phone || '').replace(/\D/g, '');
  const caps = getRateCaps();

  try {
    if (digits && caps.perUserHourly > 0) {
      const h = MessageLog.countOutboundSince(digits, '-1 hour');
      if (h >= caps.perUserHourly) {
        return { ok: false, reason: 'user_hourly_cap', count: h, cap: caps.perUserHourly };
      }
    }
    if (digits && caps.perUserDaily > 0) {
      const d = MessageLog.countOutboundSince(digits, '-1 day');
      if (d >= caps.perUserDaily) {
        return { ok: false, reason: 'user_daily_cap', count: d, cap: caps.perUserDaily };
      }
    }
    if (caps.globalHourly > 0) {
      const g = MessageLog.countOutboundSince(null, '-1 hour');
      if (g >= caps.globalHourly) {
        return { ok: false, reason: 'global_hourly_cap', count: g, cap: caps.globalHourly };
      }
    }
  } catch (err) {
    console.warn('[AntiBan] Cap check skipped:', err.message);
  }
  return { ok: true };
}

/**
 * Full pre-reply humanization: read inbound → jitter gap → caller shows typing.
 */
async function humanPauseBeforeReply(inboundText, { skipReading = false, skipJitter = false } = {}) {
  if (!skipReading) {
    await sleep(readingDelayMs(inboundText));
  }
  if (!skipJitter) {
    await sleep(humanJitterMs());
  }
}

class OutboundRateLimiter {
  constructor() {
    this._lastSendAt = 0;
    this._chain = Promise.resolve();
  }

  /** Ensure minimum gap between ANY outbound WhatsApp actions (anti burst). */
  async waitTurn() {
    const minGap = numSetting('anti_ban_min_gap_ms', 4000);
    const now = Date.now();
    const wait = Math.max(0, this._lastSendAt + minGap - now);
    if (wait > 0) await sleep(wait);
    await sleep(randInt(200, 900));
    this._lastSendAt = Date.now();
  }

  enqueue(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }
}

const outboundLimiter = new OutboundRateLimiter();

module.exports = {
  sleep,
  randInt,
  humanJitterMs,
  sessionSpacingMs,
  readingDelayMs,
  typingDurationMs,
  recordingDurationMs,
  isWithinWorkingHours,
  checkSendCaps,
  getRateCaps,
  humanPauseBeforeReply,
  outboundLimiter,
};
