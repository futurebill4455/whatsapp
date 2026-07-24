const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const {
  Settings,
  Submissions,
  MessageLog,
  Workflows,
  WorkflowRuns,
  InternalNumbers,
  ChatSessions,
  ChatFlow,
  AccessUsers,
} = require('../models');
const { bindEngine, newToken } = require('./workflowEngine');
const { buildPuppeteerLaunchOptions, isRenderLike, isVpsLinux } = require('./chromiumLaunch');
const { sanitizeFormLink } = require('../utils/leadSummary');
const {
  getBaseUrl: requireBaseUrl,
  buildFormUrl: requireBuildFormUrl,
} = require('../config/baseUrl');
const antiBan = require('./antiBan');
const replyVariations = require('./replyVariations');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_PATH = path.join(process.cwd(), '.wwebjs_cache');
const CLIENT_ID = 'insurance-bot';
const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';

/** Always-on greetings — work even if Admin Panel / DB triggers are misconfigured */
const HARDCODED_GREETINGS = ['hi', 'hello', 'hey', 'start', 'ഹായ്'];

function normalizeMsg(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

function isHardcodedGreeting(text) {
  const n = normalizeMsg(text);
  return HARDCODED_GREETINGS.some(
    (g) => n === g.toLowerCase() || n.startsWith(`${g.toLowerCase()} `)
  );
}

function getCloseKeywords() {
  // Default: Close / CLS (case-insensitive). Admin may add more in Settings.
  const raw = Settings.get('close_keywords') || 'close,cls';
  return String(raw)
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** Exact keyword match — Close / CLS from either party ends the session silently. */
function isCloseCommand(text) {
  const n = normalizeMsg(text);
  return getCloseKeywords().some((k) => n === k);
}

/**
 * ChatFlow rows that start the insurance form link (greetings).
 * Custom info keywords (brochure, address, …) return false.
 */
function isFormLinkChatFlow(flow) {
  if (!flow) return false;
  const tpl = String(flow.response_template || '');
  if (tpl.includes('{{form_link}}')) return true;
  const keys = String(flow.trigger_keyword || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const greetings = new Set([
    ...HARDCODED_GREETINGS.map((g) => g.toLowerCase()),
    ...String(Settings.get('trigger_keywords') || 'hi,hello,hey,start,ഹായ്')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
  ]);
  return keys.some((k) => greetings.has(k));
}

function isYesReply(text) {
  return ['yes', 'y', 'confirm', 'ok', 'okay'].includes(normalizeMsg(text));
}

function isNoReply(text) {
  return ['no', 'n', 'cancel'].includes(normalizeMsg(text));
}

function makeToken() {
  try {
    return newToken();
  } catch (_) {
    return crypto.randomBytes(24).toString('hex');
  }
}

function humanDelayMs() {
  return antiBan.humanJitterMs();
}

function sleep(ms) {
  return antiBan.sleep(ms);
}

function isTransientBrowserError(err) {
  const msg = String(err?.message || err || '');
  return /frame got detached|detached Frame|Navigating frame was detached|Execution context was destroyed|Target closed|Session closed|Protocol error|auth timeout|ready timeout|net::ERR_/i.test(
    msg
  );
}

/** Soften WhatsApp Web navigation + waitForFunction against SPA frame reloads */
function patchPuppeteerPageHelpers() {
  let Page;
  const candidates = [
    'puppeteer-core/lib/cjs/puppeteer/api/Page.js',
    'puppeteer-core/lib/cjs/puppeteer/api/Page',
    'puppeteer-core/lib/esm/puppeteer/api/Page.js',
  ];
  for (const id of candidates) {
    try {
      Page = require(id).Page;
      if (Page?.prototype) break;
    } catch (_) {}
  }
  if (!Page?.prototype || Page.prototype.__waNavPatched) return;
  Page.prototype.__waNavPatched = true;

  const origGoto = Page.prototype.goto;
  Page.prototype.goto = async function gotoStable(url, options = {}) {
    const isWa = String(url || '').includes('web.whatsapp.com');
    const opts = isWa
      ? {
          ...options,
          // 'load' races SPA remounts → "frame got detached" on the next waitForFunction
          waitUntil: 'domcontentloaded',
          timeout:
            !options.timeout || options.timeout === 0
              ? 180000
              : options.timeout,
        }
      : { ...options };

    try {
      return await origGoto.call(this, url, opts);
    } catch (err) {
      if (!isWa || !isTransientBrowserError(err)) throw err;
      console.warn('[WhatsApp] page.goto recovered after:', err.message || err);
      await sleep(1500);
      return origGoto.call(this, url, {
        ...opts,
        waitUntil: 'domcontentloaded',
        timeout: 180000,
      });
    }
  };

  const origWaitForFunction = Page.prototype.waitForFunction;
  Page.prototype.waitForFunction = async function waitForFunctionStable(...args) {
    const tries = Number(process.env.WA_WAIT_RETRIES) || 5;
    let lastErr;
    for (let i = 1; i <= tries; i++) {
      try {
        return await origWaitForFunction.apply(this, args);
      } catch (err) {
        lastErr = err;
        if (!isTransientBrowserError(err) || i === tries) throw err;
        console.warn(
          `[WhatsApp] waitForFunction retry ${i}/${tries}:`,
          err.message || err
        );
        await sleep(700 * i);
      }
    }
    throw lastErr;
  };

  console.log('[WhatsApp] Patched Page.goto + Page.waitForFunction for frame detach');
}

/**
 * Patch whatsapp-web.js Client so initialize/inject survive Render frame detach races.
 */
function patchClientForDetachedFrames() {
  if (Client.prototype.__detachedFramePatch) return;
  Client.prototype.__detachedFramePatch = true;

  patchPuppeteerPageHelpers();

  const originalInject = Client.prototype.inject;
  const originalInitialize = Client.prototype.initialize;

  Client.prototype.inject = async function injectWithRetry() {
    const maxAttempts = Number(process.env.WA_INJECT_RETRIES) || 6;
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!this.pupPage || this.pupPage.isClosed?.()) {
          throw new Error('Puppeteer page is closed before inject');
        }
        return await originalInject.call(this);
      } catch (err) {
        lastErr = err;
        const transient = isTransientBrowserError(err);
        console.warn(
          `[WhatsApp] inject attempt ${attempt}/${maxAttempts} failed:`,
          err?.message || err
        );
        if (!transient || attempt === maxAttempts) break;

        try {
          if (this.pupPage && !this.pupPage.isClosed?.()) {
            try {
              await this.pupPage.reload({
                waitUntil: 'domcontentloaded',
                timeout: 120000,
              });
            } catch (_) {
              await this.pupPage.goto(WHATSAPP_WEB_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 120000,
                referer: 'https://whatsapp.com/',
              });
            }
            await sleep(1200 * attempt);
          }
        } catch (navErr) {
          console.warn('[WhatsApp] inject recovery navigation failed:', navErr.message);
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  Client.prototype.initialize = async function initializeWithRetry() {
    const maxAttempts = Number(process.env.WA_INIT_RETRIES) || 4;
    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await originalInitialize.call(this);
      } catch (err) {
        lastErr = err;
        console.warn(
          `[WhatsApp] initialize attempt ${attempt}/${maxAttempts} failed:`,
          err?.message || err
        );
        if (!isTransientBrowserError(err) || attempt === maxAttempts) break;

        try {
          await this.destroy();
        } catch (_) {}
        this.pupBrowser = null;
        this.pupPage = null;
        this._framenavigatedRegistered = false;
        this._injectAbort = null;
        await sleep(2000 * attempt);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  console.log('[WhatsApp] Applied detached-frame init/inject patches');
}

patchClientForDetachedFrames();

const DEFAULT_USER_AGENT =
  process.env.WHATSAPP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function rmDirSafe(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return true;
  } catch (err) {
    console.warn(`[WhatsApp] Could not remove ${dir}: ${err.message}`);
    return false;
  }
}

class WhatsAppService {
  constructor() {
    this.client = null;
    this.io = null;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.qrSeq = 0;
    this.lastError = null;
    this.info = null;
    this.ready = false;
    this.initializing = false;
    this.authFailCount = 0;
    this._initAttempt = 0;
    this._initPromise = null;
    this._sendQueue = Promise.resolve();
    this._msgQueue = Promise.resolve();
    this._msgQueueDepth = 0;
    this._seenMsgIds = new Map();
    this._seenCleanupTimer = null;
    this._boundMessageHandler = null;
    this._boundMessageCreateHandler = null;
    this.engine = bindEngine(this);
    this.loadingPercent = null;
    this.loadingMessage = null;
    this._loadingWatchdog = null;
    this._loadingStuckCount = 0;
    this._lastLoadingKey = null;
    this._lastLoadingAt = 0;
    this._connectionPhase = 'idle';
  }

  attachSocket(io) {
    this.io = io;
    io.on('connection', (socket) => {
      socket.emit('whatsapp:status', this.getPublicStatus());
      if (this.qrDataUrl) {
        socket.emit('whatsapp:qr', { qr: this.qrDataUrl, seq: this.qrSeq, ts: Date.now() });
      }
    });
  }

  emit(event, payload) {
    if (this.io) this.io.emit(event, payload);
  }

  getPublicStatus() {
    return {
      status: this.status,
      ready: this.ready,
      qr: this.qrDataUrl,
      qrSeq: this.qrSeq,
      info: this.info,
      lastError: this.lastError,
      authFailCount: this.authFailCount,
      loadingPercent: this.loadingPercent,
      loadingMessage: this.loadingMessage,
      connectionPhase: this._connectionPhase,
    };
  }

  setConnectionPhase(phase, detail = '') {
    this._connectionPhase = phase;
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`[WhatsApp] Status: ${phase}${suffix}`);
    this.emit('whatsapp:status', this.getPublicStatus());
  }

  clearLoadingWatchdog() {
    if (this._loadingWatchdog) {
      clearTimeout(this._loadingWatchdog);
      this._loadingWatchdog = null;
    }
  }

  /**
   * If WA Web sits on Waiting / Link accepted / Finishing too long, reload once then re-init.
   */
  armLoadingWatchdog(percent, message) {
    this.clearLoadingWatchdog();
    const stuckMs = Number(process.env.WA_LOADING_STUCK_MS) || 120000;
    const key = `${percent}|${String(message || '').toLowerCase()}`;
    const now = Date.now();
    if (key !== this._lastLoadingKey) {
      this._lastLoadingKey = key;
      this._lastLoadingAt = now;
      this._loadingStuckCount = 0;
    }

    this._loadingWatchdog = setTimeout(async () => {
      if (this.ready) return;
      const label = String(message || 'loading');
      console.warn(
        `[WhatsApp] Connection stuck at "${label}" (${percent}%) for ${stuckMs}ms — recovering…`
      );
      this.setConnectionPhase('recovering', `unstick from ${label}`);
      this._loadingStuckCount += 1;

      try {
        if (this.client?.pupPage && !this.client.pupPage.isClosed?.()) {
          await this.client.pupPage.reload({
            waitUntil: 'domcontentloaded',
            timeout: 120000,
          });
          console.log('[WhatsApp] Reloaded WhatsApp Web after stuck loading screen');
          this.setConnectionPhase('loading', 'page reloaded — waiting for QR/ready');
        }
      } catch (err) {
        console.warn('[WhatsApp] Stuck-loading reload failed:', err.message);
      }

      // Second consecutive stuck → full client re-init (keep session files)
      if (this._loadingStuckCount >= 2 && !this.initializing) {
        console.warn('[WhatsApp] Still stuck after reload — restarting client…');
        this._loadingStuckCount = 0;
        try {
          await this.init({ force: true });
        } catch (err) {
          console.error('[WhatsApp] Recovery re-init failed:', err.message);
        }
      } else if (!this.ready) {
        this.armLoadingWatchdog(percent, message);
      }
    }, stuckMs);
  }

  getBaseUrl() {
    return requireBaseUrl();
  }

  buildFormUrl(token) {
    return sanitizeFormLink(requireBuildFormUrl(token));
  }

  formatPhone(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  renderTemplate(template, vars) {
    return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return vars[key] != null ? String(vars[key]) : '';
    });
  }

  clearQr(reason = 'cleared') {
    this.qrDataUrl = null;
    this.emit('whatsapp:qr', { qr: null, seq: this.qrSeq, clearing: true, reason });
  }

  clearSessionFiles() {
    const removedAuth = rmDirSafe(AUTH_PATH);
    const removedCache = rmDirSafe(CACHE_PATH);
    console.log(
      `[WhatsApp] Session cleanup — auth: ${removedAuth ? 'removed' : 'absent'}, cache: ${removedCache ? 'removed' : 'absent'}`
    );
    return { removedAuth, removedCache };
  }

  async destroyClient() {
    this.clearLoadingWatchdog();
    this._stopSeenCleanup();
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      if (this._boundMessageHandler) {
        client.removeListener('message', this._boundMessageHandler);
      }
      if (this._boundMessageCreateHandler) {
        client.removeListener('message_create', this._boundMessageCreateHandler);
      }
      this._boundMessageHandler = null;
      this._boundMessageCreateHandler = null;
      client.removeAllListeners();
    } catch (_) {}
    try {
      await client.destroy();
    } catch (err) {
      console.warn('[WhatsApp] destroy warning:', err.message);
    }
    this._seenMsgIds.clear();
  }

  async resetSession({ reason = 'manual reset' } = {}) {
    console.log(`[WhatsApp] Resetting session (${reason})…`);
    this.status = 'resetting';
    this.ready = false;
    this.info = null;
    this.lastError = null;
    this.authFailCount = 0;
    this.loadingPercent = null;
    this.loadingMessage = null;
    this.clearLoadingWatchdog();
    this.clearQr('reset');
    this.setConnectionPhase('resetting', reason);
    await this.destroyClient();
    await sleep(800);
    this.clearSessionFiles();
    await sleep(400);
    return this.init({ force: true });
  }

  async init({ force = false } = {}) {
    if (this._initPromise && !force) return this._initPromise;
    if (this.client && !force) return;
    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInit() {
    if (this.initializing) return;
    this.initializing = true;
    this._initAttempt = (this._initAttempt || 0) + 1;
    try {
      await this.destroyClient();
      this.clearLoadingWatchdog();
      this.status = 'initializing';
      this.ready = false;
      this.loadingPercent = null;
      this.loadingMessage = null;
      this.clearQr('reinit');
      this.setConnectionPhase('initializing', `boot attempt ${this._initAttempt}`);

      const launchOpts = await buildPuppeteerLaunchOptions();
      console.log(
        '[WhatsApp] Launching browser via puppeteer-core' +
          ` headless=${launchOpts.headless} executablePath=${launchOpts.executablePath} (attempt ${this._initAttempt})` +
          (isRenderLike() ? ' [Render/serverless]' : isVpsLinux() ? ' [Linux VPS]' : '')
      );

      const cacheDir = path.join(process.cwd(), '.wwebjs_cache');
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
      } catch (_) {}

      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_PATH, clientId: CLIENT_ID }),
        puppeteer: launchOpts,
        userAgent: DEFAULT_USER_AGENT,
        // Local HTML cache speeds QR on subsequent boots (avoids re-downloading WA Web)
        webVersionCache: {
          type: process.env.WA_WEB_VERSION_CACHE === 'none' ? 'none' : 'local',
          path: cacheDir,
        },
        qrMaxRetries: Number(process.env.WA_QR_MAX_RETRIES) || 20,
        takeoverOnConflict: true,
        takeoverTimeoutMs: Number(process.env.WA_TAKEOVER_TIMEOUT_MS) || 120000,
        // Free-tier chat sync after QR can take several minutes
        authTimeoutMs: Number(process.env.WA_AUTH_TIMEOUT_MS) || 600000,
      });

      this._bindClientEvents(this.client);
      this.setConnectionPhase('connecting', 'opening WhatsApp Web…');
      await this.client.initialize();
      this._initAttempt = 0;
      if (!this.ready && this.status !== 'qr' && this.status !== 'authenticated') {
        this.setConnectionPhase('waiting_qr', 'browser up — waiting for QR or session restore');
      }
    } catch (err) {
      console.error('[WhatsApp] Init failed:', err);
      this.status = 'error';
      this.lastError = err.message || String(err);
      this.ready = false;
      this.setConnectionPhase('error', this.lastError);

      const transient = isTransientBrowserError(err);
      const maxAttempts = Number(process.env.WA_SERVICE_INIT_RETRIES) || 5;

      if (this._initAttempt < maxAttempts) {
        await this.destroyClient();
        // Transient frame-detach / auth timeout: keep LocalAuth (avoid forced re-QR)
        if (!transient) {
          this.authFailCount += 1;
          console.warn('[WhatsApp] Non-transient init failure — clearing session files…');
          await sleep(1500);
          this.clearSessionFiles();
        } else {
          console.warn(
            `[WhatsApp] Transient browser error — retrying without wiping session (${this._initAttempt}/${maxAttempts})…`
          );
        }
        await sleep(transient ? 2000 * this._initAttempt : 2000);
        this.initializing = false;
        return this._doInit();
      }

      this._initAttempt = 0;
      throw err;
    } finally {
      this.initializing = false;
    }
  }

  _bindClientEvents(client) {
    client.on('qr', async (qr) => {
      const seq = ++this.qrSeq;
      this.status = 'qr';
      this.ready = false;
      this.info = null;
      this.qrDataUrl = null;
      this.clearLoadingWatchdog();
      this.loadingPercent = null;
      this.loadingMessage = null;
      this.emit('whatsapp:qr', { qr: null, seq, clearing: true, reason: 'refreshing' });
      this.setConnectionPhase('qr', `code #${seq} — scan within ~20s`);
      try {
        const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
        if (seq !== this.qrSeq) return;
        this.qrDataUrl = dataUrl;
        this.emit('whatsapp:qr', { qr: dataUrl, seq, ts: Date.now() });
        this.emit('whatsapp:status', this.getPublicStatus());
        console.log(`[WhatsApp] QR #${seq} ready — open Linked devices → Link a device`);
      } catch (err) {
        if (seq !== this.qrSeq) return;
        console.error('[WhatsApp] QR generation failed:', err.message);
        this.lastError = err.message;
        this.emit('whatsapp:status', this.getPublicStatus());
      }
    });

    client.on('loading_screen', (percent, message) => {
      const pct = percent == null ? '?' : percent;
      const msg = String(message || '').trim() || 'Waiting';
      this.loadingPercent = percent;
      this.loadingMessage = msg;
      console.log(`[WhatsApp] Loading ${pct}% — ${msg}`);
      if (!this.ready) {
        this.status = 'loading';
        // Keep QR visible until auth clears it; only hide once pairing advances
        if (/link accepted|finishing|loading|waiting/i.test(msg)) {
          this.clearQr('loading');
        }
        this.setConnectionPhase('loading', `${pct}% ${msg}`);
        this.armLoadingWatchdog(percent, msg);
      }
    });

    client.on('authenticated', () => {
      this.status = 'authenticated';
      this.authFailCount = 0;
      this.clearQr('authenticated');
      this.clearLoadingWatchdog();
      this.setConnectionPhase('authenticated', 'link accepted — finishing sync…');
    });

    client.on('ready', async () => {
      this.status = 'ready';
      this.ready = true;
      this.authFailCount = 0;
      this.lastError = null;
      this.loadingPercent = 100;
      this.loadingMessage = 'Connected';
      this.clearQr('ready');
      this.clearLoadingWatchdog();
      try {
        const wid = this.client.info?.wid?.user;
        this.info = {
          pushname: this.client.info?.pushname || null,
          phone: wid || null,
          platform: this.client.info?.platform || null,
        };
      } catch (_) {
        this.info = null;
      }
      this.setConnectionPhase('ready', this.info?.phone ? `phone ${this.info.phone}` : 'connected');
      console.log('[WhatsApp] Client ready', this.info?.phone || '');
      console.log('[WhatsApp] Listening for incoming messages — send Hi to test');
      this._startSeenCleanup();
    });

    client.on('auth_failure', async (msg) => {
      this.status = 'auth_failure';
      this.ready = false;
      this.lastError = String(msg);
      this.authFailCount += 1;
      this.clearQr('auth_failure');
      this.emit('whatsapp:status', this.getPublicStatus());
      console.error('[WhatsApp] Auth failure:', msg, `(count=${this.authFailCount})`);
      if (this.authFailCount >= 2) {
        await sleep(1000);
        try { await this.resetSession({ reason: 'auth_failure auto-recovery' }); }
        catch (err) { console.error('[WhatsApp] Auto-reset failed:', err.message); }
      }
    });

    client.on('disconnected', async (reason) => {
      this.status = 'disconnected';
      this.ready = false;
      this.info = null;
      this.lastError = String(reason || 'disconnected');
      this.clearQr('disconnected');
      this._stopSeenCleanup();
      this.emit('whatsapp:status', this.getPublicStatus());
      console.warn('[WhatsApp] Disconnected:', reason);
      const reasonStr = String(reason || '').toUpperCase();
      if (reasonStr.includes('LOGOUT') || reasonStr.includes('CONFLICT')) {
        await this.destroyClient();
        this.clearSessionFiles();
      }
      await sleep(4000);
      try { await this.init({ force: true }); }
      catch (err) { console.error('[WhatsApp] Reconnect failed:', err.message); }
    });

    // Single shared handler + serial queue — prevents free-tier OOM from parallel message work
    this._boundMessageHandler = (message) => {
      this.enqueueIncomingMessage(message, 'message');
    };
    this._boundMessageCreateHandler = (message) => {
      // message_create also fires for outbound — skip early to cut CPU
      if (message?.fromMe) return;
      this.enqueueIncomingMessage(message, 'message_create');
    };

    client.on('message', this._boundMessageHandler);
    client.on('message_create', this._boundMessageCreateHandler);

    console.log('[WhatsApp] Message listeners bound (queued message + message_create)');
  }

  /**
   * Serial inbound queue with anti-ban pauses between messages (burst protection).
   */
  enqueueIncomingMessage(message, source = 'message') {
    const maxDepth = Number(process.env.WA_MSG_QUEUE_MAX) || 40;
    if (this._msgQueueDepth >= maxDepth) {
      console.warn(
        `[WhatsApp] Dropping message (queue full ${this._msgQueueDepth}/${maxDepth}) from ${message?.from || '?'}`
      );
      return;
    }

    this._msgQueueDepth += 1;
    this._msgQueue = this._msgQueue
      .then(async () => {
        try {
          // Space out burst arrivals (not full reply jitter — that happens on send)
          await sleep(antiBan.randInt(500, 1800));
          await this.handleIncomingMessage(message);
        } catch (err) {
          console.error(
            `[WhatsApp] Message handler error (${source}):`,
            err?.message || err
          );
        } finally {
          this._msgQueueDepth = Math.max(0, this._msgQueueDepth - 1);
          await sleep(antiBan.sessionSpacingMs());
        }
      })
      .catch(() => {
        this._msgQueueDepth = Math.max(0, this._msgQueueDepth - 1);
      });
  }

  _startSeenCleanup() {
    this._stopSeenCleanup();
    this._seenCleanupTimer = setInterval(() => {
      this._pruneSeenIds();
    }, 60000);
    // Don't keep the process alive solely for this timer
    if (typeof this._seenCleanupTimer.unref === 'function') {
      this._seenCleanupTimer.unref();
    }
  }

  _stopSeenCleanup() {
    if (this._seenCleanupTimer) {
      clearInterval(this._seenCleanupTimer);
      this._seenCleanupTimer = null;
    }
  }

  _pruneSeenIds() {
    const now = Date.now();
    const ttl = Number(process.env.WA_SEEN_TTL_MS) || 120000;
    const max = Number(process.env.WA_SEEN_MAX) || 400;
    for (const [k, ts] of this._seenMsgIds) {
      if (now - ts > ttl) this._seenMsgIds.delete(k);
    }
    // Hard cap — drop oldest if still too large
    if (this._seenMsgIds.size > max) {
      const entries = [...this._seenMsgIds.entries()].sort((a, b) => a[1] - b[1]);
      const drop = entries.length - max;
      for (let i = 0; i < drop; i++) this._seenMsgIds.delete(entries[i][0]);
    }
  }

  _markSeen(message) {
    const id =
      message?.id?._serialized ||
      message?.id?.$1 ||
      message?.id?.id ||
      null;
    if (!id) return false;
    const now = Date.now();
    if (this._seenMsgIds.has(id)) return true;
    this._seenMsgIds.set(id, now);
    if (this._seenMsgIds.size > 500) this._pruneSeenIds();
    return false;
  }

  async reinitialize() {
    return this.init({ force: true });
  }

  async logout() {
    console.log('[WhatsApp] Logout requested');
    this.ready = false;
    this.status = 'disconnected';
    this.info = null;
    this.clearQr('logout');
    this.emit('whatsapp:status', this.getPublicStatus());
    if (this.client) {
      try { await this.client.logout(); } catch (_) {}
    }
    await this.destroyClient();
    this.clearSessionFiles();
    await sleep(1500);
    return this.init({ force: true });
  }

  /**
   * Resolve a stable digit phone + chat id for inbound messages (supports @c.us and @lid).
   * Sanitizes digits flexibly so whitelist matching can ignore + / spaces / 91 prefixes.
   */
  async resolveIncomingPeer(message) {
    const chatId = message.from;
    const consider = (raw) => {
      const d = this.formatPhone(String(raw || '').replace(/@.+$/, ''));
      // Plausible mobile/E.164 lengths — skip raw LID-looking huge ids
      if (d && d.length >= 10 && d.length <= 15) return d;
      return null;
    };

    let phone = null;

    // Direct @c.us chats already carry the real phone in the JID
    if (String(chatId || '').endsWith('@c.us')) {
      phone = consider(chatId);
    }

    try {
      const contact = await Promise.race([
        message.getContact(),
        sleep(3000).then(() => null),
      ]);
      if (contact) {
        const candidates = [
          contact.number,
          contact.id?.user,
          contact.id?._serialized,
          contact.id?.$1,
        ];
        for (const cand of candidates) {
          const d = consider(cand);
          if (d) {
            phone = d;
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[WhatsApp] getContact failed:', err.message);
    }

    // Fallbacks from message payload
    if (!phone) {
      try {
        const data = message._data || {};
        for (const cand of [data.from, data.author, data.notifyName ? null : null, message.author]) {
          const d = consider(cand);
          if (d) {
            phone = d;
            break;
          }
        }
      } catch (_) {}
    }

    if (!phone) {
      phone = consider(chatId) || this.formatPhone(chatId) || String(chatId || '').replace(/@.+$/, '');
    }

    console.log(`[WhatsApp] Peer resolved chatId=${chatId} phone=${phone}`);
    return { chatId, phone };
  }

  /**
   * Resolve outbound chat id for desk / cold sends (not for inbound LID replies).
   */
  async resolveOutboundChatId(to) {
    const raw = String(to || '').trim();
    if (!raw) throw new Error('Missing recipient');

    if (raw.includes('@')) return raw;

    const digits = this.formatPhone(raw);
    if (!digits) throw new Error(`Invalid recipient phone: ${raw}`);

    try {
      const numberId = await this.client.getNumberId(digits);
      if (numberId?._serialized) return numberId._serialized;
      throw new Error(`Number ${digits} is not registered on WhatsApp`);
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('not registered')) throw err;
      console.warn('[WhatsApp] getNumberId failed:', msg);
      return `${digits}@c.us`;
    }
  }

  /**
   * Show typing (or recording) indicator for a planned variable duration.
   */
  async simulatePresence(chatId, text = '', { recording = false, durationMs = null } = {}) {
    if (!this.client || !chatId) return;
    try {
      const chat = await this.client.getChatById(chatId);
      if (!chat) return;
      if (recording && typeof chat.sendStateRecording === 'function') {
        await chat.sendStateRecording();
        await sleep(
          durationMs != null ? durationMs : antiBan.recordingDurationMs()
        );
      } else if (typeof chat.sendStateTyping === 'function') {
        await chat.sendStateTyping();
        await sleep(
          durationMs != null
            ? durationMs
            : antiBan.typingDurationMs(text)
        );
      }
    } catch (err) {
      console.warn('[AntiBan] Presence simulation skipped:', err.message);
    }
  }

  /**
   * Queued send with fully dynamic 4–25s timing + proportional typing + volume caps.
   */
  async sendMessage(to, body, options = {}) {
    if (!this.client) {
      throw new Error('WhatsApp client is not ready');
    }
    if (!this.ready) {
      console.warn('[WhatsApp] sendMessage called while not ready — attempting anyway');
    }

    const run = async () => {
      const logPhone = this.formatPhone(to) || String(to || '').replace(/@.+$/, '');

      if (!options.skipRateLimit) {
        const caps = antiBan.checkSendCaps(logPhone);
        if (!caps.ok) {
          console.warn(
            `[AntiBan] Blocked send to ${logPhone}: ${caps.reason} (${caps.count}/${caps.cap})`
          );
          return null;
        }
      }

      await antiBan.outboundLimiter.waitTurn();

      const text = String(body || '');
      if (!text) return null;

      if (options.inboundText && !options.skipReading) {
        await sleep(antiBan.readingDelayMs(options.inboundText));
      }

      // Unique variable delay (4–25s) + typing share proportional to that delay
      const plan =
        options.timingPlan ||
        (options.delayMs != null
          ? antiBan.planOutboundTiming(text, { forcedTotalMs: Number(options.delayMs) })
          : antiBan.planOutboundTiming(text));

      if (!options.skipTiming && plan.thinkMs > 0) {
        await sleep(plan.thinkMs);
      }

      const presenceChat =
        options.chatId ||
        options.replyTo?.from ||
        (String(to || '').includes('@') ? String(to) : null);

      if (!options.skipTyping && presenceChat) {
        await this.simulatePresence(presenceChat, text, {
          recording: !!options.asVoiceNote,
          durationMs: plan.typingMs,
        });
      }

      console.log(
        `[AntiBan] Outbound pace total=${plan.totalMs}ms think=${plan.thinkMs}ms typing=${plan.typingMs}ms → ${logPhone}`
      );

      // 1) Reply on the same chat — most reliable for @lid peers
      if (options.replyTo && typeof options.replyTo.reply === 'function') {
        try {
          const result = await options.replyTo.reply(text);
          MessageLog.add({ direction: 'out', phone: logPhone, body: text });
          console.log(`[WhatsApp] Replied via message.reply → ${logPhone}`);
          const replyChat = options.chatId || options.replyTo.from || options.replyTo.to;
          this._lastOutboundChatId = replyChat || null;
          if (result) result._outboundChatId = this._lastOutboundChatId;
          return result;
        } catch (err) {
          console.warn('[WhatsApp] message.reply failed, falling back:', err.message);
        }
      }

      // 2) Build candidate chat ids — inbound chatId first, never block on getNumberId
      const candidates = [];
      if (options.chatId) candidates.push(options.chatId);
      if (String(to || '').includes('@')) candidates.push(String(to).trim());

      if (!candidates.length) {
        try {
          candidates.push(await this.resolveOutboundChatId(to));
        } catch (err) {
          console.error('[WhatsApp] Recipient resolve failed:', err.message);
          throw err;
        }
      } else {
        const digits = this.formatPhone(to);
        if (digits && digits.length >= 10 && !String(options.chatId || '').endsWith('@lid')) {
          try {
            const resolved = await this.resolveOutboundChatId(digits);
            if (resolved) candidates.push(resolved);
          } catch (_) {}
        }
      }

      let lastErr;
      for (const chatId of [...new Set(candidates.filter(Boolean))]) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            try {
              const chat = await this.client.getChatById(chatId);
              if (chat) {
                if (!options.skipTyping) {
                  try {
                    // Brief typing refresh only — main typing already applied above
                    await chat.sendStateTyping();
                    await sleep(antiBan.randInt(180, 650));
                  } catch (_) {}
                }
                const result = await chat.sendMessage(text);
                MessageLog.add({
                  direction: 'out',
                  phone: logPhone || chatId.replace(/@.+$/, ''),
                  body: text,
                });
                console.log(`[WhatsApp] Sent via getChatById → ${chatId}`);
                this._lastOutboundChatId = chatId;
                if (result) result._outboundChatId = chatId;
                return result;
              }
            } catch (inner) {
              lastErr = inner;
            }

            const result = await this.client.sendMessage(chatId, text);
            MessageLog.add({
              direction: 'out',
              phone: logPhone || chatId.replace(/@.+$/, ''),
              body: text,
            });
            console.log(`[WhatsApp] Sent via client.sendMessage → ${chatId}`);
            this._lastOutboundChatId = chatId;
            if (result) result._outboundChatId = chatId;
            return result;
          } catch (err) {
            lastErr = err;
            console.warn(
              `[WhatsApp] send attempt ${attempt}/3 to ${chatId} failed:`,
              err.message
            );
            await sleep(400 * attempt);
          }
        }
      }
      throw lastErr || new Error(`Failed to send WhatsApp message to ${to}`);
    };

    const next = this._sendQueue.then(run, run);
    this._sendQueue = next.catch(() => {});
    return next;
  }

  async handleIncomingMessage(message) {
    // Deduplicate message / message_create
    if (this._markSeen(message)) return;

    // WhatsApp Web 2026-07: backfill id._serialized from id.$1 before any Store lookups
    this.normalizeIncomingMessageIds(message);

    const rawBody = message.body || '';
    console.log('Received message:', rawBody, 'from:', message.from);

    if (message.fromMe) return;
    if (message.isStatus) return;
    // Allow 1:1 chats only (skip groups — bot is for personal insurance leads)
    if (message.from?.endsWith('@g.us')) {
      console.log('[WhatsApp] Ignoring group message');
      return;
    }

    if (!this.client) {
      console.warn('[WhatsApp] Skipping — no client instance');
      return;
    }

    const body = String(rawBody)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    // Allow media-only messages through (desk quotations / voice notes may have no caption)
    const inboundMediaTypes = new Set([
      'image',
      'video',
      'document',
      'ptt',
      'audio',
      'sticker',
    ]);
    const looksLikeMedia =
      !!message.hasMedia ||
      inboundMediaTypes.has(String(message.type || '').toLowerCase());
    if (!body && !looksLikeMedia) {
      console.log('[WhatsApp] Ignoring empty/non-text message');
      return;
    }

    let chatId;
    let phone;
    try {
      ({ chatId, phone } = await this.resolveIncomingPeer(message));
    } catch (err) {
      console.warn('[WhatsApp] Peer resolve error, using message.from:', err.message);
      chatId = message.from;
      phone = String(message.from || '').replace(/@.+$/, '');
    }

    console.log(
      `[WhatsApp] IN from ${phone} (${chatId}): ${(body || (message.hasMedia ? '[media]' : '')).slice(0, 80)}`
    );
    try {
      MessageLog.add({
        direction: 'in',
        phone,
        body: body || (message.hasMedia ? '[media]' : ''),
      });
    } catch (err) {
      console.warn('[WhatsApp] MessageLog failed:', err.message);
    }

    // 1) Two-way chat bridge (customer ↔ desk) — highest priority
    try {
      const bridged = await this.handleChatBridge(message, phone, chatId, body);
      if (bridged) return;
    } catch (err) {
      console.error('[ChatBridge] Error:', err.message);
    }

    if (!body) return;

    try {
      // 2) CORE access gate — independent of Drawflow / visual workflow builder.
      // Flexible phone match + unique ACCESS_CODE → unlock → bare form URL (anti-ban paced).
      const accessEnabled = Settings.get('access_control_enabled', '1') !== '0';
      if (accessEnabled) {
        const unlocked = AccessUsers.isUnlocked(phone);

        if (!unlocked) {
          const unlockResult = AccessUsers.tryUnlock(phone, body);
          if (unlockResult.ok) {
            const canonicalPhone = unlockResult.user.phone || phone;
            console.log(
              `[Access] Unlocked inbound=${phone} matched=${canonicalPhone} ` +
                `(${unlockResult.user.name}) code=${unlockResult.user.access_code} — sending form URL (no workflow dependency)`
            );
            // Status flips Waiting for code → Unlocked via verified_at; send bare URL only
            await this.sendFormLinkOnly(canonicalPhone, {
              chatId,
              replyTo: message,
              inboundText: body,
            });
            return;
          }

          // Legacy Yes/No only if a pending confirmation still exists (pre-migration)
          const authorized = AccessUsers.findByPhone(phone);
          if (authorized && (isYesReply(body) || isNoReply(body))) {
            const pending =
              Submissions.findPendingConfirmation(authorized.phone) ||
              Submissions.findPendingConfirmation(phone);
            if (pending && isYesReply(body)) {
              await this.confirmAndForward(pending, {
                chatId,
                replyTo: message,
                inboundText: body,
              });
              return;
            }
            if (pending && isNoReply(body)) {
              await this.sendFormLinkOnly(authorized.phone || phone, {
                chatId,
                replyTo: message,
                inboundText: body,
                forceNew: true,
              });
              try {
                Submissions.cancel?.(pending.id);
              } catch (_) {}
              return;
            }
          }

          console.log(
            `[Access] Silent ignore from ${phone} (reason=${unlockResult.reason}${
              authorized ? ', registered-not-unlocked' : ', unknown'
            })`
          );
          return;
        }
      }

      // 3) Yes/No for pending confirmation (unlocked users)
      if (isYesReply(body)) {
        const pending = Submissions.findPendingConfirmation(phone);
        if (pending) {
          await this.confirmAndForward(pending, {
            chatId,
            replyTo: message,
            inboundText: body,
          });
          return;
        }
      }
      if (isNoReply(body)) {
        const pending = Submissions.findPendingConfirmation(phone);
        if (pending) {
          const nodes = this.engine.getActiveGraph()?.nodes || {};
          await this.engine.resendFormAfterDecline(pending, nodes, {
            phone,
            chatId,
            replyTo: message,
            inboundText: body,
          });
          return;
        }
      }

      // 4) Working hours — pause new automation outside daytime
      if (!antiBan.isWithinWorkingHours()) {
        console.log(`[AntiBan] Outside working hours — ignoring automation from ${phone}`);
        if (Settings.get('anti_ban_after_hours_reply', '0') === '1') {
          await this.sendMessage(
            phone,
            replyVariations.pick('after_hours', { phone }),
            {
              chatId,
              replyTo: message,
              inboundText: body,
            }
          );
        }
        return;
      }

      // 5) Custom admin keywords (brochure, address, …) — unlocked users only
      const keywordFlow = ChatFlow.findByKeyword(body);
      if (keywordFlow && !isFormLinkChatFlow(keywordFlow) && !isHardcodedGreeting(body)) {
        const business = Settings.get('business_name', 'SecureLife Insurance');
        const text = this.renderTemplate(keywordFlow.response_template, {
          business_name: business,
          phone,
        });
        console.log(`[WhatsApp] Custom keyword reply for: ${body}`);
        await this.sendMessage(phone, text, {
          chatId,
          replyTo: message,
          inboundText: body,
        });
        return;
      }

      // 6) Active Drawflow workflow (or Settings/ChatFlow fallback inside engine)
      const result = await this.engine.handleIncomingMessage({
        phone,
        body,
        chatId,
        replyTo: message,
        inboundText: body,
      });
      console.log(
        '[WhatsApp] Workflow result:',
        result?.reason || (result?.handled ? 'handled' : 'unhandled'),
        result?.waiting || ''
      );
      if (result?.handled) return;
      if (result?.reason === 'unmatched_reply' && !isHardcodedGreeting(body)) return;

      // 7) Greeting ChatFlow / Hi → form link
      const flow = ChatFlow.findByKeyword(body);
      if ((flow && isFormLinkChatFlow(flow)) || isHardcodedGreeting(body)) {
        console.log('[WhatsApp] ChatFlow / greeting form-link for:', body);
        await this.sendGreetingFormLink(phone, {
          chatId,
          replyTo: message,
          flow: flow && isFormLinkChatFlow(flow) ? flow : null,
        });
        return;
      }

      console.log('[WhatsApp] No trigger matched for:', JSON.stringify(body));
    } catch (err) {
      console.error('[WhatsApp] Flow execution error:', err?.message || err);
      // Never leak error replies to unauthorized numbers
      if (Settings.get('access_control_enabled', '1') !== '0' && !AccessUsers.isUnlocked(phone)) {
        return;
      }
      try {
        await this.sendMessage(
          phone,
          'Sorry — something went wrong on our side. Please send *Hi* again in a moment.',
          { chatId, replyTo: message }
        );
      } catch (sendErr) {
        console.error('[WhatsApp] Error-reply also failed:', sendErr.message);
      }
    }
  }

  /**
   * Two-way live relay — multi-tenant safe + LID-aware desk matching.
   * Close is customer-only. Desk replies are routed via quote / [#CODE] / last-active.
   */
  async handleChatBridge(message, phone, chatId, body) {
    const digits = this.formatPhone(phone);
    if (!digits) return false;

    const mediaTypes = new Set(['image', 'video', 'document', 'ptt', 'audio', 'sticker']);
    const hasMedia =
      !!message.hasMedia || mediaTypes.has(String(message.type || '').toLowerCase());

    // ── Customer side ──
    const customerSession = ChatSessions.findActiveByCustomer(digits);
    if (customerSession) {
      if (body && isCloseCommand(body)) {
        await this.closeChatSession(customerSession, {
          closedBy: 'customer',
          replyTo: message,
          chatId,
        });
        return true;
      }

      ChatSessions.touch(customerSession.id, {
        customer_chat_id: chatId,
        side: 'customer',
      });
      if (chatId) ChatSessions.bindCustomerChatId(customerSession.id, chatId);
      await this.relayMessageAcrossBridge(message, customerSession, 'customer_to_desk', body, hasMedia);
      return true;
    }

    // ── Desk side (phone OR @lid chat id OR catalog desk) ──
    let deskSessions = await this.resolveDeskSessionsForInbound(digits, chatId);
    if (!deskSessions.length && InternalNumbers.isDeskPhone(digits)) {
      deskSessions = ChatSessions.listActiveByDesk(digits);
    }
    if (deskSessions.length > 0) {
      // Resolve which customer session this desk message belongs to
      let quotedWaId = null;
      try {
        if (message.hasQuotedMsg) {
          const quoted = await message.getQuotedMessage();
          quotedWaId =
            quoted?.id?._serialized ||
            quoted?.id?.id ||
            null;
        }
      } catch (err) {
        console.warn('[ChatBridge] getQuotedMessage failed:', err.message);
      }

      const resolved = ChatSessions.resolveDeskInbound(digits, {
        quotedWaId,
        body,
        chatId,
      });
      const session = resolved.session || deskSessions[0];
      if (!session) {
        console.warn('[ChatBridge] Desk message with no resolvable session', {
          phone: digits,
          chatId,
          hasMedia,
        });
        return true;
      }

      if (body && isCloseCommand(body)) {
        await this.closeChatSession(session, {
          closedBy: 'desk',
          replyTo: message,
          chatId,
        });
        return true;
      }

      // Persist LID ↔ desk binding so future media always matches
      if (chatId && session.desk_chat_id !== chatId) {
        ChatSessions.bindDeskChatId(session.id, chatId);
        console.log(
          `[ChatBridge] Bound desk_chat_id ${chatId} → session #${session.id}[${session.session_code}]`
        );
      }

      console.log(
        `[ChatBridge] Desk→customer route method=${resolved.method || 'desk_identity'}` +
          (resolved.ambiguous ? ` (ambiguous among ${resolved.candidates})` : '') +
          ` → session #${session.id} [${session.session_code}] customer=${session.customer_phone}`
      );

      ChatSessions.touch(session.id, { desk_chat_id: chatId, side: 'desk' });
      await this.relayMessageAcrossBridge(message, session, 'desk_to_customer', body, hasMedia);
      return true;
    }

    if (hasMedia) {
      console.warn(
        `[ChatBridge] Media from ${digits} (${chatId}) not matched to any desk session — check Catalog desk_phone`
      );
    }

    return this.tryRelayDeskQuote(message, phone, chatId, body);
  }

  /**
   * Find active sessions for an inbound desk peer (real phone or @lid).
   * Auto-binds LID chat ids by resolving each session's desk_phone when needed.
   */
  async resolveDeskSessionsForInbound(phoneDigits, chatId) {
    let sessions = ChatSessions.listActiveByDeskIdentity(phoneDigits, chatId);
    if (sessions.length) return sessions;

    // Slow path: resolve each active session's desk_phone → WA chat id and compare to inbound
    const active = ChatSessions.listActive(100);
    const matched = [];
    for (const s of active) {
      if (!s.desk_phone) continue;
      if (s.desk_chat_id && chatId && s.desk_chat_id === chatId) {
        matched.push(s);
        continue;
      }
      try {
        const resolved = await this.resolveOutboundChatId(s.desk_phone);
        if (resolved && chatId && resolved === chatId) {
          ChatSessions.bindDeskChatId(s.id, chatId);
          matched.push(ChatSessions.get(s.id));
          console.log(
            `[ChatBridge] Auto-bound desk ${s.desk_phone} → ${chatId} (session #${s.id})`
          );
        }
      } catch (err) {
        console.warn(`[ChatBridge] resolveOutboundChatId(${s.desk_phone}) failed:`, err.message);
      }
    }
    return matched;
  }

  /**
   * Silent session close — no notifications to customer or desk.
   * Either party may close with Close / CLS.
   */
  async closeChatSession(session, { closedBy = 'customer', replyTo, chatId } = {}) {
    ChatSessions.close(session.id);
    console.log(
      `[ChatBridge] Session #${session.id} [${session.session_code}] closed by ${closedBy} (silent)`
    );
  }

  /**
   * WhatsApp Web (2026-07) renamed message-key `_serialized` → `$1`.
   * Backfill so library lookups / downloadMedia receive a real id.
   */
  normalizeIncomingMessageIds(message) {
    if (!message) return message;
    const fix = (id) => {
      if (!id || typeof id !== 'object') return id;
      if (id._serialized == null && id.$1 != null) {
        id._serialized = id.$1;
      }
      if (id.remote && typeof id.remote === 'object') {
        if (id.remote._serialized == null && id.remote.$1 != null) {
          id.remote._serialized = id.remote.$1;
        }
      }
      return id;
    };
    if (message.id) message.id = fix(message.id);
    return message;
  }

  /** Serialized WA message id (`_serialized` or `$1`). */
  getMessageSerializedId(message) {
    const id = message?.id;
    if (!id) return null;
    if (typeof id === 'string') return id;
    return id._serialized || id.$1 || null;
  }

  /**
   * Build candidate WhatsApp chat IDs for a bridge peer (stored id, @c.us, getNumberId).
   */
  async resolveBridgeDestChatIds(destPhone, preferredChatId = null) {
    const candidates = [];
    const push = (id) => {
      const s = String(id || '').trim();
      if (s && !candidates.includes(s)) candidates.push(s);
    };

    push(preferredChatId);

    const digits = this.formatPhone(destPhone);
    if (digits) {
      push(`${digits}@c.us`);
      try {
        const resolved = await this.resolveOutboundChatId(digits);
        push(resolved);
      } catch (err) {
        console.warn('[ChatBridge] dest resolve failed:', err.message);
      }
      try {
        const numberId = await this.client.getNumberId(digits);
        push(numberId?._serialized);
      } catch (_) {}
    }

    return candidates;
  }

  /**
   * True native WhatsApp forward (official "Forwarded" tag).
   * Tries each dest chat id until one succeeds. No plain-text copy.
   */
  async nativeForwardToChat(message, destChatIds) {
    this.normalizeIncomingMessageIds(message);
    const msgId =
      message?.id?._serialized ||
      message?.id?.$1 ||
      (typeof message?.id === 'string' ? message.id : null);

    if (!msgId) {
      throw new Error('Cannot native-forward: message id missing');
    }
    if (typeof message.forward !== 'function' && !this.client?.pupPage) {
      throw new Error('Cannot native-forward: forward API unavailable');
    }

    let lastErr;
    for (const destChatId of destChatIds) {
      try {
        // Prefer Message.forward (uses WWebJS.forwardMessage → Forwarded tag)
        if (typeof message.forward === 'function') {
          // Ensure id shape expected by library
          if (message.id && !message.id._serialized && msgId) {
            message.id._serialized = msgId;
          }
          const result = await message.forward(destChatId);
          console.log(`[ChatBridge] Native forward OK → ${destChatId} result=${result}`);
          return { ok: true, destChatId, result };
        }

        // Direct Store path (same protocol as Message.forward)
        const result = await this.client.pupPage.evaluate(
          async (serializedMsgId, chatId) => {
            if (!window.WWebJS?.forwardMessage) {
              throw new Error('WWebJS.forwardMessage missing');
            }
            return window.WWebJS.forwardMessage(chatId, serializedMsgId);
          },
          msgId,
          destChatId
        );
        console.log(`[ChatBridge] Native forward (Store) OK → ${destChatId}`);
        return { ok: true, destChatId, result };
      } catch (err) {
        lastErr = err;
        console.warn(
          `[ChatBridge] Native forward failed → ${destChatId}:`,
          err?.message || err
        );
      }
    }

    throw lastErr || new Error('Native forward failed for all dest chat ids');
  }

  /**
   * Best-effort: read the latest message id in a chat after a native forward (for quote routing).
   */
  async peekLatestChatMessageId(chatId) {
    if (!this.client?.pupPage || !chatId) return null;
    try {
      return await this.client.pupPage.evaluate(async (id) => {
        const chat = await window.WWebJS.getChat(id, { getAsModel: false });
        if (!chat) return null;
        let last = null;
        try {
          if (typeof chat.getLastMsg === 'function') last = chat.getLastMsg();
        } catch (_) {}
        if (!last && chat.msgs) {
          const arr =
            typeof chat.msgs.getModelsArray === 'function'
              ? chat.msgs.getModelsArray()
              : chat.msgs._models || [];
          last = arr?.length ? arr[arr.length - 1] : null;
        }
        return last?.id?._serialized || last?.id?.toString?.() || null;
      }, chatId);
    } catch (_) {
      return null;
    }
  }

  /**
   * Two-way session relay with humanized pacing:
   * - Short text / media → native WhatsApp forward (Forwarded tag) + jitter/typing
   * - Long text → smart conversational chunks with typing + 1–3s micro-delays
   */
  async relayMessageAcrossBridge(message, session, direction, body, hasMediaFlag = null) {
    this.normalizeIncomingMessageIds(message);

    const toCustomer = direction === 'desk_to_customer';
    const destPhone = toCustomer ? session.customer_phone : session.desk_phone;
    const preferredChatId = toCustomer ? session.customer_chat_id : session.desk_chat_id;
    const code = session.session_code || String(session.id);
    const msgType = String(message.type || '').toLowerCase();
    const hasMedia =
      hasMediaFlag != null
        ? hasMediaFlag
        : !!(
            message.hasMedia ||
            ['image', 'video', 'document', 'ptt', 'audio', 'sticker'].includes(msgType)
          );

    const cleanBody = antiBan.cleanRelayText(body);
    const useChunks = antiBan.shouldChunkMessage(cleanBody, hasMedia);

    console.log(
      `[ChatBridge] #${session.id}[${code}] ${direction} mode=${
        useChunks ? 'chunked-human' : 'native-forward'
      } type=${message.type || 'chat'} media=${hasMedia} len=${(cleanBody || '').length}`
    );

    if (!destPhone && !preferredChatId) {
      console.error('[ChatBridge] No destination phone/chatId for relay');
      return;
    }

    const destChatIds = await this.resolveBridgeDestChatIds(destPhone, preferredChatId);
    if (!destChatIds.length) {
      console.error('[ChatBridge] No dest chat id candidates for relay');
      return;
    }

    // Shared: rate-limit turn + reading. Each outbound then gets its own unique 4–25s plan.
    await antiBan.outboundLimiter.waitTurn();
    await sleep(antiBan.readingDelayMs(cleanBody || body));

    if (useChunks) {
      await this.relayChunkedTextAcrossBridge({
        session,
        direction,
        destPhone,
        destChatIds,
        code,
        text: cleanBody,
      });
      return;
    }

    try {
      const plan = antiBan.planOutboundTiming(cleanBody || '[media]');
      console.log(
        `[AntiBan] Bridge pace total=${plan.totalMs}ms think=${plan.thinkMs}ms typing=${plan.typingMs}ms (${direction})`
      );
      await sleep(plan.thinkMs);
      await this.simulatePresence(destChatIds[0], cleanBody || '[media]', {
        recording: msgType === 'ptt' || msgType === 'audio',
        durationMs: plan.typingMs,
      });

      const forwarded = await this.nativeForwardToChat(message, destChatIds);
      const destChatId = forwarded.destChatId;

      if (toCustomer) {
        ChatSessions.bindCustomerChatId(session.id, destChatId);
      } else {
        ChatSessions.bindDeskChatId(session.id, destChatId);
      }

      ChatSessions.touch(session.id, {
        side: toCustomer ? 'desk' : 'customer',
        ...(toCustomer
          ? { customer_chat_id: destChatId }
          : { desk_chat_id: destChatId }),
      });

      const waId = await this.peekLatestChatMessageId(destChatId);
      if (waId) {
        ChatSessions.trackMessage(session.id, direction, waId, cleanBody || body);
      }

      MessageLog.add({
        direction: 'out',
        phone: destPhone,
        body: `[bridge ${direction} native-forward] ${cleanBody || '[media]'}`,
        meta: {
          session_id: session.id,
          session_code: code,
          direction,
          native: true,
          dest_chat_id: destChatId,
          wa_id: waId,
        },
      });
      console.log(
        `[ChatBridge] Native Forwarded relay OK #${session.id}[${code}] → ${destChatId}`
      );
    } catch (err) {
      console.error(
        `[ChatBridge] Native forward FAILED (${direction}):`,
        err?.message || err
      );
      // Long/short text fallback: chunked human send (still paced + typed)
      if (cleanBody) {
        console.warn('[ChatBridge] Falling back to chunked human relay');
        await this.relayChunkedTextAcrossBridge({
          session,
          direction,
          destPhone,
          destChatIds,
          code,
          text: cleanBody,
          skipInitialPace: true,
        });
        return;
      }
      MessageLog.add({
        direction: 'out',
        phone: destPhone || 'unknown',
        body: `[bridge ${direction} native-forward-FAILED] ${body || '[media]'}`,
        meta: {
          session_id: session.id,
          session_code: code,
          direction,
          native: false,
          error: String(err?.message || err),
        },
      });
    }
  }

  /**
   * Relay long text as natural chunks with typing + 1–3s micro-delays between parts.
   */
  async relayChunkedTextAcrossBridge({
    session,
    direction,
    destPhone,
    destChatIds,
    code,
    text,
    skipInitialPace = false,
  }) {
    const toCustomer = direction === 'desk_to_customer';
    const chunks = antiBan.splitIntoNaturalChunks(text);
    if (!chunks.length) return;

    let destChatId = destChatIds[0];
    console.log(
      `[ChatBridge] Chunking ${chunks.length} part(s) for #${session.id}[${code}] ${direction}`
    );

    if (!skipInitialPace) {
      // Already paced by caller when coming from main relay
    }

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        // Unique variable gap before the next chunk (never a fixed interval)
        await antiBan.outboundLimiter.waitTurn();
      }

      const chunk = antiBan.lightlyVaryTextStructure(chunks[i]);
      // Full dynamic 4–25s plan + proportional typing inside sendMessage
      const sent = await this.sendMessage(destPhone, chunk, {
        chatId: destChatId,
        skipReading: true,
      });

      if (sent?._outboundChatId) {
        destChatId = sent._outboundChatId;
      }

      const waId =
        sent?.id?._serialized || sent?.id?.$1 || sent?.id?.id || null;
      if (waId) {
        ChatSessions.trackMessage(session.id, direction, waId, chunk);
      }

      MessageLog.add({
        direction: 'out',
        phone: destPhone,
        body: `[bridge ${direction} chunk ${i + 1}/${chunks.length}] ${chunk}`,
        meta: {
          session_id: session.id,
          session_code: code,
          direction,
          native: false,
          chunked: true,
          chunk_index: i + 1,
          chunk_total: chunks.length,
          dest_chat_id: destChatId,
          wa_id: waId,
        },
      });
    }

    if (toCustomer) {
      ChatSessions.bindCustomerChatId(session.id, destChatId);
    } else {
      ChatSessions.bindDeskChatId(session.id, destChatId);
    }
    ChatSessions.touch(session.id, {
      side: toCustomer ? 'desk' : 'customer',
      ...(toCustomer
        ? { customer_chat_id: destChatId }
        : { desk_chat_id: destChatId }),
    });

    console.log(
      `[ChatBridge] Chunked relay OK #${session.id}[${code}] ${chunks.length} parts → ${destChatId}`
    );
  }

  /**
   * Download incoming media with retries.
   * Primary: msg.downloadMedia()
   * Fallback: decrypt via directPath/mediaKey on the event payload (needed for @lid chats
   * where Msg.get(msgId) fails after WhatsApp's 2026-07 Web update).
   */
  async downloadMediaWithRetry(message, attempts = 5) {
    this.normalizeIncomingMessageIds(message);
    let lastErr;

    for (let i = 1; i <= attempts; i++) {
      // Library path
      try {
        if (typeof message.downloadMedia === 'function' && message.hasMedia) {
          const media = await message.downloadMedia();
          if (media?.data) {
            console.log(
              `[ChatBridge] downloadMedia OK via library (attempt ${i}) mimetype=${media.mimetype}`
            );
            return media;
          }
          lastErr = new Error('empty media payload from downloadMedia()');
        }
      } catch (err) {
        lastErr = err;
        console.warn(
          `[ChatBridge] downloadMedia attempt ${i}/${attempts}:`,
          err?.message || err
        );
      }

      // Metadata / direct decrypt path (bypasses Msg.get — critical for @lid)
      try {
        const media = await this.downloadMediaFromMessageMeta(message);
        if (media?.data) {
          console.log(
            `[ChatBridge] downloadMedia OK via meta decrypt (attempt ${i}) mimetype=${media.mimetype}`
          );
          return media;
        }
      } catch (err) {
        lastErr = err;
        console.warn(
          `[ChatBridge] meta download attempt ${i}/${attempts}:`,
          err?.message || err
        );
      }

      await sleep(500 * i);
    }

    console.error(
      '[ChatBridge] downloadMedia gave up:',
      lastErr?.message || lastErr || 'unknown'
    );
    return null;
  }

  /**
   * Decrypt media using fields already present on the inbound message model.
   * Does not require Msg.get(serializedId), which breaks for many @lid peers.
   */
  async downloadMediaFromMessageMeta(message) {
    if (!this.client?.pupPage) return null;

    const data = message._data || {};
    const meta = {
      directPath: data.directPath,
      encFilehash: data.encFilehash,
      filehash: data.filehash,
      mediaKey: data.mediaKey || message.mediaKey,
      mediaKeyTimestamp: data.mediaKeyTimestamp,
      type: data.type || message.type,
      mimetype: data.mimetype,
      filename: data.filename || undefined,
      filesize: data.size || undefined,
      msgId: this.getMessageSerializedId(message),
    };

    if (!meta.directPath || !meta.mediaKey) {
      console.warn('[ChatBridge] Media meta incomplete — cannot direct-decrypt', {
        hasDirectPath: !!meta.directPath,
        hasMediaKey: !!meta.mediaKey,
        type: meta.type,
        msgId: meta.msgId,
      });
      return null;
    }

    const result = await this.client.pupPage.evaluate(async (meta) => {
      const mockQpl = {
        addAnnotations() {
          return this;
        },
        addPoint() {
          return this;
        },
      };

      // Prefer Store message when findable (gets freshest keys), else use meta as-is
      try {
        if (meta.msgId) {
          const Msg = window.require('WAWebCollections').Msg;
          const found =
            Msg.get(meta.msgId) ||
            (await Msg.getMessagesById([meta.msgId]))?.messages?.[0];
          if (found?.mediaData && found.mediaData.mediaStage !== 'REUPLOADING') {
            try {
              await found.downloadMedia({
                downloadEvenIfExpensive: true,
                rmrReason: 1,
                isUserInitiated: true,
              });
            } catch (_) {}
          }
        }
      } catch (_) {}

      try {
        const decrypted = await window
          .require('WAWebDownloadManager')
          .downloadManager.downloadAndMaybeDecrypt({
            directPath: meta.directPath,
            encFilehash: meta.encFilehash,
            filehash: meta.filehash,
            mediaKey: meta.mediaKey,
            mediaKeyTimestamp: meta.mediaKeyTimestamp,
            type: meta.type,
            signal: new AbortController().signal,
            downloadQpl: mockQpl,
          });

        if (!decrypted) return { error: 'empty decrypt result' };

        const b64 = await window.WWebJS.arrayBufferToBase64Async(decrypted);
        return {
          data: b64,
          mimetype: meta.mimetype,
          filename: meta.filename,
          filesize: meta.filesize,
        };
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    }, meta);

    if (!result || result.error || !result.data) {
      console.warn('[ChatBridge] meta decrypt failed:', result?.error || 'no data');
      return null;
    }

    return new MessageMedia(
      result.mimetype || 'application/octet-stream',
      result.data,
      result.filename,
      result.filesize
    );
  }

  /**
   * Legacy one-way desk→customer relay if no chat_sessions row exists yet.
   */
  async tryRelayDeskQuote(message, phone, chatId, body) {
    const digits = this.formatPhone(phone);
    if (!digits) return false;

    const lead = Submissions.findAwaitingQuoteByDeskPhone(digits);
    if (!lead) return false;

    try {
      const session = ChatSessions.open({
        submission_id: lead.id,
        customer_phone: lead.customer_phone,
        customer_chat_id: lead.customer_chat_id,
        desk_phone: digits,
        desk_chat_id: chatId,
        company_name: lead.company,
      });
      console.log(
        `[ChatBridge] Upgraded legacy lead #${lead.id} → session #${session.id}[${session.session_code}]`
      );
      const mediaTypes = new Set(['image', 'video', 'document', 'ptt', 'audio', 'sticker']);
      const hasMedia =
        !!message.hasMedia || mediaTypes.has(String(message.type || '').toLowerCase());
      await this.relayMessageAcrossBridge(message, session, 'desk_to_customer', body, hasMedia);
      return true;
    } catch (err) {
      console.error('[ChatBridge] Legacy upgrade failed:', err.message);
    }
    return false;
  }

  async sendMedia(to, media, options = {}) {
    if (!this.client) throw new Error('WhatsApp client is not ready');
    const run = async () => {
      await antiBan.outboundLimiter.waitTurn();
      const caption = options.caption || '';
      const plan = antiBan.planOutboundTiming(caption || '[media]');
      await sleep(plan.thinkMs);

      const chatId =
        options.chatId ||
        (String(to).includes('@') ? String(to) : await this.resolveOutboundChatId(to));

      try {
        await this.simulatePresence(chatId, caption, {
          recording: !!options.sendAudioAsVoice,
          durationMs: plan.typingMs,
        });
      } catch (_) {}

      const sendOpts = {};
      if (options.caption) sendOpts.caption = options.caption;
      if (options.sendAudioAsVoice) sendOpts.sendAudioAsVoice = true;
      if (options.sendMediaAsDocument) sendOpts.sendMediaAsDocument = true;

      const result = await this.client.sendMessage(chatId, media, sendOpts);
      this._lastOutboundChatId = chatId;
      if (result) result._outboundChatId = chatId;
      MessageLog.add({
        direction: 'out',
        phone: this.formatPhone(to) || String(chatId).replace(/@.+$/, ''),
        body: options.caption || '[media]',
      });
      console.log(
        `[AntiBan] Media pace total=${plan.totalMs}ms think=${plan.thinkMs}ms typing=${plan.typingMs}ms → ${chatId}`
      );
      return result;
    };
    const next = this._sendQueue.then(run, run);
    this._sendQueue = next.catch(() => {});
    return next;
  }

  /**
   * Core form-link delivery — no welcome text, no workflow-builder dependency.
   * Uses chatId/replyTo so LID peers still receive the URL after whitelist unlock.
   */
  async sendFormLinkOnly(phone, opts = {}) {
    const existing = Submissions.findLatestOpen(phone);
    if (existing && existing.status === 'awaiting_confirmation') {
      await this.confirmAndForward(existing, {
        chatId: opts.chatId,
        replyTo: opts.replyTo,
        inboundText: opts.inboundText,
      });
      return true;
    }

    let submission =
      !opts.forceNew && existing && existing.status === 'awaiting_form'
        ? existing
        : null;
    if (!submission) {
      submission = Submissions.create({ token: makeToken(), customer_phone: phone });
    }
    if (opts.chatId) {
      try {
        Submissions.setCustomerChatId(submission.token, opts.chatId);
      } catch (_) {}
    }

    // Optional: arm workflow waiter IF a graph exists — never required for unlock/form URL
    try {
      const active = this.engine?.getActiveGraph?.();
      if (active) {
        const formNode = Object.values(active.nodes || {}).find((n) => n.type === 'form_submit');
        if (formNode) {
          const run = WorkflowRuns.create({
            workflow_id: active.workflow.id,
            customer_phone: phone,
            submission_token: submission.token,
            context: { phone, chatId: opts.chatId },
          });
          Submissions.setWorkflowRun(submission.token, run.id);
          WorkflowRuns.update(run.id, {
            status: 'waiting',
            current_node_id: formNode.id,
            waiting_for: 'form_submit',
            submission_token: submission.token,
            context: { phone, chatId: opts.chatId },
          });
        }
      }
    } catch (err) {
      console.warn('[WhatsApp] Workflow arm skipped (form link still sent):', err.message);
    }

    const formLink = sanitizeFormLink(this.buildFormUrl(submission.token));
    console.log(`[WhatsApp] Bare form link → ${phone} (chatId=${opts.chatId || 'n/a'}): ${formLink}`);

    // Anti-ban jitter + typing live inside sendMessage; prefer inbound chatId/reply
    await this.sendMessage(phone, formLink, {
      chatId: opts.chatId,
      replyTo: opts.replyTo,
      inboundText: opts.inboundText,
    });
    return true;
  }

  /** Alias — welcome greeting removed; bare link only. */
  async sendGreetingFormLink(phone, opts = {}) {
    return this.sendFormLinkOnly(phone, opts);
  }

  /**
   * After web form submit: lead goes to desk ONLY + instant two-way session.
   * Never echoes submission details back to the customer.
   */
  async sendFormConfirmation(submission) {
    return this.notifyFormSubmitted(submission);
  }

  async notifyFormSubmitted(tokenOrSubmission) {
    const submission =
      typeof tokenOrSubmission === 'string'
        ? Submissions.getByToken(tokenOrSubmission)
        : tokenOrSubmission;
    if (!submission) {
      console.warn('[WhatsApp] notifyFormSubmitted: submission not found');
      return false;
    }

    try {
      const result = await this.engine.forwardLeadToDesk(submission, {
        phone: submission.customer_phone,
        chatId: submission.customer_chat_id || undefined,
        notifyCustomer: false,
        sendDeskTip: false,
      });
      console.log('[WhatsApp] Form → desk forward result:', result);
      return !!result?.ok;
    } catch (err) {
      console.error('[WhatsApp] Form → desk forward failed:', err.message);
      return false;
    }
  }

  async confirmAndForward(submission, opts = {}) {
    try {
      const waiting = WorkflowRuns.findWaiting(submission.customer_phone, 'yes_no');
      if (waiting) {
        WorkflowRuns.update(waiting.id, {
          status: 'completed',
          waiting_for: null,
          submission_token: submission.token,
        });
      }
    } catch (_) {}

    await this.engine.forwardLeadToDesk(submission, {
      phone: submission.customer_phone,
      chatId: opts.chatId || submission.customer_chat_id,
      replyTo: opts.replyTo,
      inboundText: opts.inboundText,
      notifyCustomer: false,
      sendDeskTip: false,
    });
  }
}

module.exports = new WhatsAppService();
