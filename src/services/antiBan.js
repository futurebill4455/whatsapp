/**
 * Anti-ban / humanization: unique 4–30s jitter, typing simulation, rate caps, working hours.
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
  const raw = Settings.get(key);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const _recentDelays = [];
const RECENT_DELAY_WINDOW = 12;

function jitterBounds() {
  let min = numSetting('anti_ban_jitter_min_ms', 4000, ['WA_JITTER_MIN_MS']);
  let max = numSetting('anti_ban_jitter_max_ms', 30000, ['WA_JITTER_MAX_MS']);
  min = Math.max(2000, Math.min(Number(min) || 4000, 30000));
  max = Math.max(min, Math.min(Number(max) || 30000, 30000));
  return { lo: min, hi: max };
}

/** Unique randomized delay — never identical to recent delays (default up to 30s). */
function nextVariableDelayMs() {
  const { lo, hi } = jitterBounds();
  const span = Math.max(1, hi - lo);
  let delay = lo;
  for (let attempt = 0; attempt < 20; attempt++) {
    const roll = Math.random();
    if (roll < 0.15) delay = randInt(lo, lo + Math.floor(span * 0.3));
    else if (roll < 0.35) delay = randInt(hi - Math.floor(span * 0.3), hi);
    else delay = randInt(lo, hi);

    const last = _recentDelays[_recentDelays.length - 1];
    const tooClose = last != null && Math.abs(delay - last) < Math.min(900, Math.floor(span * 0.04));
    if (!tooClose && !_recentDelays.includes(delay)) break;
    delay =
      last != null
        ? Math.min(hi, Math.max(lo, last + (delay >= last ? 1 : -1) * randInt(900, 4000)))
        : delay;
  }
  _recentDelays.push(delay);
  while (_recentDelays.length > RECENT_DELAY_WINDOW) _recentDelays.shift();
  return delay;
}

function planOutboundTiming(text = '', { forcedTotalMs = null } = {}) {
  const totalMs =
    forcedTotalMs != null && Number.isFinite(Number(forcedTotalMs))
      ? Number(forcedTotalMs)
      : nextVariableDelayMs();
  const len = String(text || '').length;
  const share = 0.28 + Math.random() * 0.34;
  let typingMs = Math.floor(totalMs * share) + Math.min(len, 400) * randInt(8, 18);
  typingMs = Math.max(1400, Math.min(typingMs, Math.max(1600, totalMs - 600), 22000));
  const thinkMs = Math.max(400, totalMs - typingMs);
  return { totalMs, thinkMs, typingMs, delayMs: totalMs };
}

function readingDelayMs(inboundText) {
  const len = String(inboundText || '').length;
  return Math.min(10000, Math.max(800, 700 + Math.min(len, 500) * 28 + randInt(250, 1400)));
}

function typingDurationMs(text, plannedDelayMs = null) {
  if (plannedDelayMs != null && Number(plannedDelayMs) > 0) {
    return planOutboundTiming(text, { forcedTotalMs: Number(plannedDelayMs) }).typingMs;
  }
  return planOutboundTiming(text).typingMs;
}

function recordingDurationMs() {
  return randInt(2200, Math.min(12000, Math.floor(nextVariableDelayMs() * 0.45)));
}

function sessionSpacingMs() {
  return nextVariableDelayMs();
}

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
    if (hour === 24) hour = 0;
  } catch (_) {
    hour = now.getHours();
    minute = now.getMinutes();
  }
  const mins = hour * 60 + minute;
  const startM = Math.max(0, Math.min(24, start)) * 60;
  const endM = Math.max(0, Math.min(24, end)) * 60;
  if (startM === endM) return true;
  if (startM < endM) return mins >= startM && mins < endM;
  return mins >= startM || mins < endM;
}

function checkSendCaps(phone) {
  let MessageLog;
  try {
    MessageLog = require('../models').MessageLog;
  } catch (_) {
    return { ok: true };
  }
  const digits = String(phone || '').replace(/\D/g, '');
  const perUserHourly = numSetting('anti_ban_hourly_cap', 18);
  const perUserDaily = numSetting('anti_ban_daily_cap', 60);
  const globalHourly = numSetting('anti_ban_global_hourly_cap', 220);
  try {
    if (digits && perUserHourly > 0) {
      const h = MessageLog.countOutboundSince(digits, '-1 hour');
      if (h >= perUserHourly) return { ok: false, reason: 'user_hourly_cap', count: h, cap: perUserHourly };
    }
    if (digits && perUserDaily > 0) {
      const d = MessageLog.countOutboundSince(digits, '-1 day');
      if (d >= perUserDaily) return { ok: false, reason: 'user_daily_cap', count: d, cap: perUserDaily };
    }
    if (globalHourly > 0) {
      const g = MessageLog.countOutboundSince(null, '-1 hour');
      if (g >= globalHourly) return { ok: false, reason: 'global_hourly_cap', count: g, cap: globalHourly };
    }
  } catch (_) {}
  return { ok: true };
}

function chunkThresholdChars() {
  return numSetting('anti_ban_chunk_threshold', 160);
}

function shouldChunkMessage(text, hasMedia = false) {
  if (hasMedia) return false;
  const t = String(text || '').trim();
  return !!t && t.length >= chunkThresholdChars();
}

function cleanRelayText(text) {
  return String(text || '')
    .replace(/\[#[A-Z0-9]{3,8}\]\s*/gi, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function lightlyVaryTextStructure(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  t = t.replace(/\n{3,}/g, () => '\n'.repeat(randInt(1, 2)));
  t = t.replace(/[ \t]{2,}/g, () => (Math.random() < 0.5 ? ' ' : '  '));
  return t.trim();
}

function splitIntoNaturalChunks(text) {
  const raw = lightlyVaryTextStructure(text);
  if (!raw) return [];
  const softMax = randInt(110, 190);
  const hardMax = randInt(200, 320);
  if (raw.length <= softMax) return [raw];
  const units = [];
  for (const para of raw.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
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
    if (joined.length > softMax) {
      if (buf) flush();
      buf = unit;
    } else buf = joined;
  }
  flush();
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < 25) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${last}`.trim();
  }
  return chunks.length ? chunks : [raw];
}

class OutboundRateLimiter {
  constructor() {
    this._lastSendAt = 0;
    this._chain = Promise.resolve();
  }
  async waitTurn() {
    const minGap = numSetting('anti_ban_min_gap_ms', 4000);
    const wait = Math.max(0, this._lastSendAt + minGap - Date.now());
    if (wait > 0) await sleep(wait);
    await sleep(randInt(200, 900));
    this._lastSendAt = Date.now();
  }
}

const outboundLimiter = new OutboundRateLimiter();

module.exports = {
  sleep,
  randInt,
  nextVariableDelayMs,
  humanJitterMs: nextVariableDelayMs,
  planOutboundTiming,
  readingDelayMs,
  typingDurationMs,
  recordingDurationMs,
  sessionSpacingMs,
  isWithinWorkingHours,
  checkSendCaps,
  shouldChunkMessage,
  splitIntoNaturalChunks,
  lightlyVaryTextStructure,
  cleanRelayText,
  outboundLimiter,
};
