/**
 * Humanization / anti-detection engine.
 * Every outbound interaction uses a unique randomized delay of 1–45 seconds
 * with typing/recording presence covering the full window.
 */
const Settings = (() => {
  try {
    return require('../models').Settings;
  } catch (_) {
    return { get: (_k, fb) => fb };
  }
})();
const logger = require('../utils/logger');

/** Absolute delay window (ms) — product requirement */
const DELAY_MIN_MS = 1000;
const DELAY_MAX_MS = 45000;

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
const RECENT_DELAY_WINDOW = 20;

/**
 * Bounds for human delay: default 1s–45s (clamped to product window).
 */
function jitterBounds() {
  let min = numSetting('anti_ban_jitter_min_ms', DELAY_MIN_MS, [
    'WA_JITTER_MIN_MS',
  ]);
  let max = numSetting('anti_ban_jitter_max_ms', DELAY_MAX_MS, [
    'WA_JITTER_MAX_MS',
  ]);
  min = Math.max(DELAY_MIN_MS, Math.min(Number(min) || DELAY_MIN_MS, DELAY_MAX_MS));
  max = Math.max(min, Math.min(Number(max) || DELAY_MAX_MS, DELAY_MAX_MS));
  return { lo: min, hi: max };
}

/**
 * Completely randomized delay between 1–45s (or configured bounds).
 * Avoids near-identical back-to-back delays so the bot does not look scripted.
 */
function nextVariableDelayMs() {
  const { lo, hi } = jitterBounds();
  const span = Math.max(1, hi - lo);
  let delay = lo;
  for (let attempt = 0; attempt < 32; attempt++) {
    const roll = Math.random();
    // Weighted mix: short / mid / long human response times
    if (roll < 0.18) delay = randInt(lo, lo + Math.floor(span * 0.22));
    else if (roll < 0.4) delay = randInt(hi - Math.floor(span * 0.28), hi);
    else if (roll < 0.7) delay = randInt(lo + Math.floor(span * 0.25), lo + Math.floor(span * 0.65));
    else delay = randInt(lo, hi);

    const last = _recentDelays[_recentDelays.length - 1];
    const minGap = Math.min(1200, Math.floor(span * 0.04));
    const tooClose =
      last != null && Math.abs(delay - last) < minGap;
    if (!tooClose && !_recentDelays.includes(delay)) break;
    delay =
      last != null
        ? Math.min(
            hi,
            Math.max(
              lo,
              last + (delay >= last ? 1 : -1) * randInt(900, 4200)
            )
          )
        : delay;
  }
  _recentDelays.push(delay);
  while (_recentDelays.length > RECENT_DELAY_WINDOW) _recentDelays.shift();
  logger.debug(
    `[AntiBan] human delay = ${delay}ms window=${lo}-${hi}ms`
  );
  return delay;
}

/**
 * Plan outbound timing. Typing/recording covers the FULL 1–45s window.
 */
function planOutboundTiming(text = '', { forcedTotalMs = null } = {}) {
  const totalMs =
    forcedTotalMs != null && Number.isFinite(Number(forcedTotalMs))
      ? Math.max(DELAY_MIN_MS, Math.min(DELAY_MAX_MS, Number(forcedTotalMs)))
      : nextVariableDelayMs();
  return {
    totalMs,
    thinkMs: 0,
    typingMs: totalMs,
    delayMs: totalMs,
  };
}

function readingDelayMs(_inboundText) {
  return nextVariableDelayMs();
}

function typingDurationMs(text, plannedDelayMs = null) {
  if (plannedDelayMs != null && Number(plannedDelayMs) > 0) {
    return planOutboundTiming(text, {
      forcedTotalMs: Number(plannedDelayMs),
    }).typingMs;
  }
  return planOutboundTiming(text).typingMs;
}

function recordingDurationMs() {
  return nextVariableDelayMs();
}

function sessionSpacingMs() {
  return Math.min(4000, nextVariableDelayMs());
}

function isWithinWorkingHours(_now = new Date()) {
  return true;
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
      if (h >= perUserHourly) {
        return { ok: false, reason: 'user_hourly_cap', count: h, cap: perUserHourly };
      }
    }
    if (digits && perUserDaily > 0) {
      const d = MessageLog.countOutboundSince(digits, '-1 day');
      if (d >= perUserDaily) {
        return { ok: false, reason: 'user_daily_cap', count: d, cap: perUserDaily };
      }
    }
    if (globalHourly > 0) {
      const g = MessageLog.countOutboundSince(null, '-1 hour');
      if (g >= globalHourly) {
        return { ok: false, reason: 'global_hourly_cap', count: g, cap: globalHourly };
      }
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
  DELAY_MIN_MS,
  DELAY_MAX_MS,
  sleep,
  randInt,
  jitterBounds,
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
