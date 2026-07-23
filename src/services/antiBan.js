/**
 * Anti-ban / humanization helpers for WhatsApp automation.
 * Randomized delays, typing timing, and outbound rate limiting.
 */
const Settings = (() => {
  try {
    return require('../models').Settings;
  } catch (_) {
    return { get: (_k, fb) => fb };
  }
})();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

/** Primary human jitter: 3–7 seconds (env / settings override). */
function humanJitterMs() {
  const min = Number(process.env.WA_JITTER_MIN_MS || Settings.get('anti_ban_jitter_min_ms') || 3000);
  const max = Number(process.env.WA_JITTER_MAX_MS || Settings.get('anti_ban_jitter_max_ms') || 7000);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return randInt(lo, hi);
}

/** Extra pause between different customers' session starts. */
function sessionSpacingMs() {
  const min = Number(process.env.WA_SESSION_GAP_MIN_MS || 2000);
  const max = Number(process.env.WA_SESSION_GAP_MAX_MS || 6000);
  return randInt(Math.min(min, max), Math.max(min, max));
}

/**
 * How long to keep the typing indicator before send.
 * Roughly proportional to message length, clamped for realism.
 */
function typingDurationMs(text) {
  const len = String(text || '').length;
  const base = 1200 + Math.min(len, 280) * 35;
  const jitter = randInt(200, 900);
  return Math.min(9000, Math.max(1500, base + jitter));
}

function recordingDurationMs() {
  return randInt(1800, 4500);
}

class OutboundRateLimiter {
  constructor() {
    this._lastSendAt = 0;
    this._chain = Promise.resolve();
  }

  /**
   * Ensure minimum gap between ANY outbound WhatsApp actions (anti burst).
   */
  async waitTurn() {
    const minGap = Number(
      process.env.WA_OUTBOUND_MIN_GAP_MS || Settings.get('anti_ban_min_gap_ms') || 3500
    );
    const now = Date.now();
    const wait = Math.max(0, this._lastSendAt + minGap - now);
    if (wait > 0) await sleep(wait);
    // Small extra jitter so gaps are never perfectly equal
    await sleep(randInt(150, 800));
    this._lastSendAt = Date.now();
  }

  /** Serialize outbound work through one chain. */
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
  typingDurationMs,
  recordingDurationMs,
  outboundLimiter,
};
