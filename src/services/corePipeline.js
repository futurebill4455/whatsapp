/**
 * Non-blocking priority architecture for WhatsApp auto-chat & media forwarding.
 *
 * CORE lane  — inbound auto-chat, bridge relay, workflow replies (never waits on bulk)
 * BULK lane  — campaigns, admin web-chat, deferred DB/side-effects
 *
 * Everything stays in-process (single WWebJS client) but queues are isolated so
 * campaigns / logs / admin never throttle the primary response path.
 */
const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('../utils/logger');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function randInt(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return a + Math.floor(Math.random() * (Math.max(b, a) - a + 1));
}

/**
 * Per-chat inbound queues with bounded parallelism across chats.
 * Different peers process concurrently; same peer stays ordered.
 */
class CoreInboundScheduler {
  constructor({ maxParallel = 6, maxDepth = 80 } = {}) {
    this.maxParallel = Math.max(1, Number(maxParallel) || 6);
    this.maxDepth = Math.max(8, Number(maxDepth) || 80);
    /** @type {Map<string, Promise>} */
    this._chains = new Map();
    this._depth = 0;
    this._active = 0;
    this._waiters = [];
  }

  get depth() {
    return this._depth;
  }

  get active() {
    return this._active;
  }

  _chatKey(message) {
    const raw =
      message?.from ||
      message?.author ||
      message?.id?.remote ||
      message?.to ||
      'unknown';
    return String(raw).trim() || 'unknown';
  }

  async _acquireSlot() {
    if (this._active < this.maxParallel) {
      this._active += 1;
      return;
    }
    await new Promise((resolve) => this._waiters.push(resolve));
    this._active += 1;
  }

  _releaseSlot() {
    this._active = Math.max(0, this._active - 1);
    const next = this._waiters.shift();
    if (next) next();
  }

  /**
   * Enqueue core inbound work. Returns immediately (fire-and-forget).
   * @returns {boolean} false if dropped due to depth cap
   */
  enqueue(message, handler, onError) {
    if (this._depth >= this.maxDepth) {
      logger.warn(
        `[CorePipeline] inbound depth=${this._depth} — dropping from=${message?.from || '?'}`
      );
      return false;
    }

    const key = this._chatKey(message);
    this._depth += 1;

    const prev = this._chains.get(key) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await this._acquireSlot();
        try {
          // Yield so Puppeteer/CDP keep-alive stays responsive
          await sleep(0);
          await handler(message);
        } catch (err) {
          if (typeof onError === 'function') {
            try {
              await onError(err, message);
            } catch (_) {}
          } else {
            throw err;
          }
        } finally {
          this._releaseSlot();
        }
      })
      .finally(() => {
        this._depth = Math.max(0, this._depth - 1);
        // Drop settled chain head to avoid unbounded Map growth
        if (this._chains.get(key) === next) {
          this._chains.delete(key);
        }
      });

    this._chains.set(key, next);
    return true;
  }
}

/**
 * Dual outbound gate: CORE never waits for BULK; BULK yields while CORE is active.
 *
 * Core sends can overlap on pacing/typing but share a short socket mutex around the
 * actual Puppeteer send (passed as fn). Bulk is fully serialized and always yields.
 */
class PriorityOutboundGate {
  constructor() {
    this._coreActive = 0;
    this._coreLastAt = 0;
    this._bulkLastAt = 0;
    this._socketChain = Promise.resolve();
    this._bulkChain = Promise.resolve();
  }

  get coreBusy() {
    return this._coreActive > 0;
  }

  /**
   * Serialize only the Puppeteer/WA socket hop (keep fn short).
   */
  async withSocket(fn) {
    const run = this._socketChain.then(() => fn());
    this._socketChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * @param {'core'|'bulk'} lane
   * @param {() => Promise<any>} fn  — should be the real WA send (keep short)
   * @param {{ minGapMs?: number, jitterMs?: [number, number], yieldAfterCoreMs?: number }} opts
   */
  async run(lane, fn, opts = {}) {
    if (lane === 'bulk') {
      return this._runBulk(fn, opts);
    }
    this.markCoreStart();
    try {
      await this._prepareCore(opts);
      return await this.withSocket(fn);
    } finally {
      this.markCoreEnd();
    }
  }

  /**
   * Spacing / yield only (no socket lock). Use before long typing delays.
   */
  async waitTurn(lane = 'core', opts = {}) {
    if (lane === 'bulk') {
      await this._prepareBulk(opts);
      return;
    }
    await this._prepareCore(opts);
  }

  markCoreStart() {
    this._coreActive += 1;
  }

  markCoreEnd() {
    this._coreActive = Math.max(0, this._coreActive - 1);
    this._coreLastAt = Date.now();
  }

  async _prepareCore(opts = {}) {
    const minGap = Math.max(0, Number(opts.minGapMs) ?? 600);
    const [jLo, jHi] = opts.jitterMs || [40, 180];
    const wait = Math.max(0, this._coreLastAt + minGap - Date.now());
    if (wait > 0) await sleep(wait);
    if (jHi > 0) await sleep(randInt(jLo, jHi));
  }

  async _prepareBulk(opts = {}) {
    const minGap = Math.max(0, Number(opts.minGapMs) ?? 4500);
    const [jLo, jHi] = opts.jitterMs || [400, 1200];
    const yieldAfterCoreMs = Math.max(
      0,
      Number(opts.yieldAfterCoreMs) ?? 2500
    );

    let spins = 0;
    while (this._coreActive > 0 && spins < 250) {
      await sleep(40);
      spins += 1;
    }
    const afterCore = Math.max(
      0,
      this._coreLastAt + yieldAfterCoreMs - Date.now()
    );
    if (afterCore > 0) await sleep(afterCore);

    const wait = Math.max(0, this._bulkLastAt + minGap - Date.now());
    if (wait > 0) await sleep(wait);
    if (jHi > 0) await sleep(randInt(jLo, jHi));

    if (this._coreActive > 0) {
      while (this._coreActive > 0) await sleep(40);
      await sleep(yieldAfterCoreMs);
    }
  }

  async _runBulk(fn, opts = {}) {
    const run = this._bulkChain.then(async () => {
      await this._prepareBulk(opts);
      try {
        const result = await this.withSocket(fn);
        this._bulkLastAt = Date.now();
        return result;
      } catch (err) {
        this._bulkLastAt = Date.now();
        throw err;
      }
    });
    this._bulkChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }
}

/**
 * Fire-and-forget background work (DB logs, campaign reply tagging, etc.).
 * Never awaited from the core inbound path.
 */
class BackgroundWorkQueue {
  constructor({ maxDepth = 500 } = {}) {
    this.maxDepth = maxDepth;
    this._depth = 0;
    this._chain = Promise.resolve();
  }

  get depth() {
    return this._depth;
  }

  schedule(fn, label = 'bg') {
    if (typeof fn !== 'function') return false;
    if (this._depth >= this.maxDepth) {
      logger.warn(`[CorePipeline] background queue full — skip ${label}`);
      return false;
    }
    this._depth += 1;
    this._chain = this._chain
      .then(async () => {
        await sleep(0);
        await fn();
      })
      .catch((err) => {
        logger.debug(`[CorePipeline] bg ${label}:`, err.message);
      })
      .finally(() => {
        this._depth = Math.max(0, this._depth - 1);
      });
    return true;
  }
}

/**
 * Optional worker_threads helper for CPU-ish side work.
 * Falls back to BackgroundWorkQueue if worker creation fails.
 * (SQLite stays on main thread — workers are for pure compute only.)
 */
function runInWorker(workerRelativePath, workerData, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    try {
      worker = new Worker(path.join(__dirname, workerRelativePath), {
        workerData,
      });
    } catch (err) {
      return reject(err);
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        worker.terminate();
      } catch (_) {}
      reject(new Error('worker_timeout'));
    }, timeoutMs);
    worker.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg);
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      if (code !== 0) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`worker_exit_${code}`));
      }
    });
  });
}

const inbound = new CoreInboundScheduler({
  maxParallel: Number(process.env.WA_CORE_PARALLEL) || 6,
  maxDepth: Number(process.env.WA_MSG_QUEUE_MAX) || 80,
});

const outbound = new PriorityOutboundGate();
const background = new BackgroundWorkQueue({
  maxDepth: Number(process.env.WA_BG_QUEUE_MAX) || 500,
});

module.exports = {
  CoreInboundScheduler,
  PriorityOutboundGate,
  BackgroundWorkQueue,
  inbound,
  outbound,
  background,
  runInWorker,
  sleep,
  randInt,
};
