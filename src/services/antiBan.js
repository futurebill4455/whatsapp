/**
 * Enterprise anti-ban / humanization layer for WhatsApp automation.
 * Fully dynamic variable timing (default 4–25s) — no fixed/repeating delays.
 * Typing duration scales with each planned delay. Working hours + rate caps.
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

/** Recent delays — ensure consecutive sends never share the same timing fingerprint. */
const _recentDelays = [];
const RECENT_DELAY_WINDOW = 10;

function jitterBounds() {
  const min = numSetting('anti_ban_jitter_min_ms', 4000, ['WA_JITTER_MIN_MS']);
  const max = numSetting('anti_ban_jitter_max_ms', 25000, ['WA_JITTER_MAX_MS']);
  return { lo: Math.min(min, max), hi: Math.max(min, max) };
}

/**
 * Unique randomized delay for every outbound action (default 4–25s).
 * Never returns the exact same value as the previous delay (or near-duplicates).
 */
function nextVariableDelayMs() {
  const { lo, hi } = jitterBounds();
  const span = Math.max(1, hi - lo);
  let delay = lo;
  for (let attempt = 0; attempt < 16; attempt++) {
    // Non-uniform-ish: mix uniform with occasional long/short tails
    const roll = Math.random();
    if (roll < 0.12) {
      delay = randInt(lo, lo + Math.floor(span * 0.35));
    } else if (roll < 0.28) {
      delay = randInt(hi - Math.floor(span * 0.35), hi);
    } else {
      delay = randInt(lo, hi);
    }

    const last = _recentDelays[_recentDelays.length - 1];
    const tooClose =
      last != null && Math.abs(delay - last) < Math.min(750, Math.floor(span * 0.04));
    const exactRepeat = _recentDelays.includes(delay);
    if (!tooClose && !exactRepeat) break;
    // Nudge away from last value
    delay = last != null
      ? Math.min(hi, Math.max(lo, last + (delay >= last ? 1 : -1) * randInt(800, 3500)))
      : delay;
  }

  _recentDelays.push(delay);
  while (_recentDelays.length > RECENT_DELAY_WINDOW) _recentDelays.shift();
  return delay;
}

/** @deprecated alias — use nextVariableDelayMs / planOutboundTiming */
function humanJitterMs() {
  return nextVariableDelayMs();
}

/**
 * Plan think + typing for one outbound message.
 * totalMs is unique 4–25s; typingMs is proportional to that delay (+ text length).
 */
function planOutboundTiming(text = '', { forcedTotalMs = null } = {}) {
  const totalMs =
    forcedTotalMs != null && Number.isFinite(Number(forcedTotalMs)) && Number(forcedTotalMs) >= 0
      ? Number(forcedTotalMs)
      : nextVariableDelayMs();

  const len = String(text || '').length;
  // Typing takes ~28–62% of the planned delay, scaled by message length
  const share = 0.28 + Math.random() * 0.34;
  let typingMs = Math.floor(totalMs * share);
  typingMs += Math.min(len, 360) * randInt(8, 18);
  typingMs += randInt(-500, 700);
  typingMs = Math.max(1400, Math.min(typingMs, Math.max(1600, totalMs - 600), 20000));

  const thinkMs = Math.max(400, totalMs - typingMs);
  return {
    totalMs,
    thinkMs,
    typingMs,
    delayMs: totalMs,
  };
}

/** Extra pause between different customers / queue slots (also non-repeating). */
function sessionSpacingMs() {
  return nextVariableDelayMs();
}

/**
 * Simulate reading the inbound message before composing a reply.
 * Longer messages → longer pause (clamped for realism). Still randomized.
 */
function readingDelayMs(inboundText) {
  const len = String(inboundText || '').length;
  const base = 700 + Math.min(len, 500) * 28;
  const jitter = randInt(250, 1400);
  return Math.min(10000, Math.max(800, base + jitter));
}

/**
 * Typing indicator duration — proportional to planned delay when provided.
 */
function typingDurationMs(text, plannedDelayMs = null) {
  if (plannedDelayMs != null && Number(plannedDelayMs) > 0) {
    return planOutboundTiming(text, { forcedTotalMs: Number(plannedDelayMs) }).typingMs;
  }
  return planOutboundTiming(text).typingMs;
}

function recordingDurationMs() {
  // Still variable — never a fixed recording wait
  return randInt(2200, Math.min(12000, Math.floor(nextVariableDelayMs() * 0.45)));
}

/**
 * Extra irregularity wrapper — always a fresh unique delay (never static).
 */
function antiPatternJitterMs() {
  return nextVariableDelayMs();
}

/** Inter-chunk gap: same dynamic engine (4–25s), never a fixed 1s/3s pattern. */
function microDelayMs() {
  return nextVariableDelayMs();
}

/**
 * Full pre-reply humanization: read inbound → unique variable delay.
 */
async function humanPauseBeforeReply(inboundText, { skipReading = false, skipJitter = false } = {}) {
  if (!skipReading) {
    await sleep(readingDelayMs(inboundText));
  }
  if (!skipJitter) {
    await sleep(nextVariableDelayMs());
  }
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

/** Long-message chunk threshold (chars). */
function chunkThresholdChars() {
  return numSetting('anti_ban_chunk_threshold', 160);
}

function shouldChunkMessage(text, hasMedia = false) {
  if (hasMedia) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  return t.length >= chunkThresholdChars();
}

/**
 * Subtle structural variation without changing meaning —
 * breaks identical payload fingerprints across relays.
 */
function lightlyVaryTextStructure(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  // Normalize wild newline runs randomly to 1–2 breaks
  t = t.replace(/\n{3,}/g, () => '\n'.repeat(randInt(1, 2)));
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n[ \t]+/g, '\n');
  t = t.replace(/[ \t]{2,}/g, () => (Math.random() < 0.5 ? ' ' : '  '));
  // Rarely drop a trailing space-before-punct artifact
  t = t.replace(/ +([,.!?])/g, '$1');
  return t.trim();
}

/**
 * Split long text into natural conversational chunks.
 * Prefers paragraphs → sentences → soft length cuts at word boundaries.
 * Target sizes are randomized so chunk lengths never look mechanical.
 */
function splitIntoNaturalChunks(text) {
  const raw = lightlyVaryTextStructure(text);
  if (!raw) return [];

  const softMax = randInt(110, 190);
  const hardMax = randInt(200, 320);
  if (raw.length <= softMax) return [raw];

  const paragraphs = raw.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const units = [];
  for (const para of paragraphs) {
    const sentences = para.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) || [para];
    for (const s of sentences) {
      const piece = String(s || '').trim();
      if (piece) units.push(piece);
    }
  }
  if (!units.length) units.push(raw);

  const chunks = [];
  let buf = '';

  const flush = () => {
    const c = buf.trim();
    if (c) chunks.push(c);
    buf = '';
  };

  for (const unit of units) {
    if (unit.length > hardMax) {
      if (buf) flush();
      // Hard-wrap oversized unit at word boundaries with jittered cut points
      let rest = unit;
      while (rest.length > hardMax) {
        const cutAt = randInt(Math.floor(hardMax * 0.55), hardMax);
        let idx = rest.lastIndexOf(' ', cutAt);
        if (idx < hardMax * 0.35) idx = cutAt;
        chunks.push(rest.slice(0, idx).trim());
        rest = rest.slice(idx).trim();
      }
      if (rest) buf = rest;
      continue;
    }

    const joined = buf ? `${buf} ${unit}` : unit;
    // Randomly flush early so boundaries aren't identical every time
    const earlyFlush = buf && joined.length >= softMax - randInt(0, 40) && Math.random() < 0.35;
    if (joined.length > softMax || earlyFlush) {
      if (buf) flush();
      buf = unit;
    } else {
      buf = joined;
    }
  }
  flush();

  // Merge tiny trailing crumbs into previous chunk
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < 25) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${last}`.trim();
  }

  return chunks.length ? chunks : [raw];
}

/**
 * Strip bridge/system artifacts so relayed text stays clean.
 */
function cleanRelayText(text) {
  return String(text || '')
    .replace(/\[#[A-Z0-9]{3,8}\]\s*/gi, '')
    .replace(/↑\s*forwarded from customer/gi, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
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
  nextVariableDelayMs,
  planOutboundTiming,
  sessionSpacingMs,
  readingDelayMs,
  typingDurationMs,
  recordingDurationMs,
  isWithinWorkingHours,
  checkSendCaps,
  getRateCaps,
  humanPauseBeforeReply,
  chunkThresholdChars,
  microDelayMs,
  antiPatternJitterMs,
  shouldChunkMessage,
  lightlyVaryTextStructure,
  splitIntoNaturalChunks,
  cleanRelayText,
  outboundLimiter,
};
