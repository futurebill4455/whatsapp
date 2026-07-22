/**
 * Lean WhatsApp service for Render free tier.
 * Core only: QR link, receive messages, simple auto-replies. No workflows/forms/bridge.
 */
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Settings, MessageLog } = require('../models');
const { buildPuppeteerLaunchOptions, isRenderLike } = require('./chromiumLaunch');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_PATH = path.join(process.cwd(), '.wwebjs_cache');
const CLIENT_ID = 'insurance-bot';
const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';

const GREETINGS = ['hi', 'hello', 'hey', 'start', 'ഹായ്'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeMsg(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

function isGreeting(text) {
  const n = normalizeMsg(text);
  return GREETINGS.some((g) => n === g || n.startsWith(`${g} `));
}

function isTransientBrowserError(err) {
  const msg = String(err?.message || err || '');
  return /frame got detached|detached Frame|Navigating frame was detached|Execution context was destroyed|Target closed|Session closed|Protocol error|auth timeout|ready timeout|net::ERR_/i.test(
    msg
  );
}

function patchPuppeteerPageHelpers() {
  let Page;
  for (const id of [
    'puppeteer-core/lib/cjs/puppeteer/api/Page.js',
    'puppeteer-core/lib/cjs/puppeteer/api/Page',
  ]) {
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
          waitUntil: 'domcontentloaded',
          timeout: !options.timeout || options.timeout === 0 ? 180000 : options.timeout,
        }
      : { ...options };
    try {
      return await origGoto.call(this, url, opts);
    } catch (err) {
      if (!isWa || !isTransientBrowserError(err)) throw err;
      await sleep(1500);
      return origGoto.call(this, url, { ...opts, waitUntil: 'domcontentloaded', timeout: 180000 });
    }
  };

  const origWait = Page.prototype.waitForFunction;
  Page.prototype.waitForFunction = async function waitStable(...args) {
    const tries = Number(process.env.WA_WAIT_RETRIES) || 4;
    let lastErr;
    for (let i = 1; i <= tries; i++) {
      try {
        return await origWait.apply(this, args);
      } catch (err) {
        lastErr = err;
        if (!isTransientBrowserError(err) || i === tries) throw err;
        await sleep(600 * i);
      }
    }
    throw lastErr;
  };
}

function patchClientForDetachedFrames() {
  if (Client.prototype.__detachedFramePatch) return;
  Client.prototype.__detachedFramePatch = true;
  patchPuppeteerPageHelpers();

  const originalInject = Client.prototype.inject;
  const originalInitialize = Client.prototype.initialize;

  Client.prototype.inject = async function injectWithRetry() {
    const maxAttempts = Number(process.env.WA_INJECT_RETRIES) || 4;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await originalInject.call(this);
      } catch (err) {
        lastErr = err;
        if (!isTransientBrowserError(err) || attempt === maxAttempts) break;
        console.warn(`[WhatsApp] inject retry ${attempt}/${maxAttempts}:`, err?.message || err);
        try {
          if (this.pupPage && !this.pupPage.isClosed?.()) {
            await this.pupPage.goto(WHATSAPP_WEB_URL, {
              waitUntil: 'domcontentloaded',
              timeout: 120000,
              referer: 'https://whatsapp.com/',
            });
            await sleep(1000 * attempt);
          }
        } catch (_) {}
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  Client.prototype.initialize = async function initializeWithRetry() {
    const maxAttempts = Number(process.env.WA_INIT_RETRIES) || 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await originalInitialize.call(this);
      } catch (err) {
        lastErr = err;
        if (!isTransientBrowserError(err) || attempt === maxAttempts) break;
        console.warn(`[WhatsApp] initialize retry ${attempt}/${maxAttempts}:`, err?.message || err);
        try {
          await this.destroy();
        } catch (_) {}
        this.pupBrowser = null;
        this.pupPage = null;
        this._framenavigatedRegistered = false;
        await sleep(2000 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
}

patchClientForDetachedFrames();

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
    this.loadingPercent = null;
    this.loadingMessage = null;
    this._loadingWatchdog = null;
    this._loadingStuckCount = 0;
    this._lastLoadingKey = null;
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
      loadingPercent: this.loadingPercent,
      loadingMessage: this.loadingMessage,
      connectionPhase: this._connectionPhase,
    };
  }

  setConnectionPhase(phase, detail = '') {
    this._connectionPhase = phase;
    console.log(`[WhatsApp] Status: ${phase}${detail ? ` — ${detail}` : ''}`);
    this.emit('whatsapp:status', this.getPublicStatus());
  }

  clearQr(reason = 'cleared') {
    this.qrDataUrl = null;
    this.emit('whatsapp:qr', { qr: null, seq: this.qrSeq, clearing: true, reason });
  }

  clearLoadingWatchdog() {
    if (this._loadingWatchdog) {
      clearTimeout(this._loadingWatchdog);
      this._loadingWatchdog = null;
    }
  }

  armLoadingWatchdog(percent, message) {
    this.clearLoadingWatchdog();
    const stuckMs = Number(process.env.WA_LOADING_STUCK_MS) || 120000;
    const key = `${percent}|${String(message || '').toLowerCase()}`;
    if (key !== this._lastLoadingKey) {
      this._lastLoadingKey = key;
      this._loadingStuckCount = 0;
    }
    this._loadingWatchdog = setTimeout(async () => {
      if (this.ready) return;
      console.warn(`[WhatsApp] Stuck at "${message}" — reloading…`);
      this._loadingStuckCount += 1;
      try {
        if (this.client?.pupPage && !this.client.pupPage.isClosed?.()) {
          await this.client.pupPage.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
        }
      } catch (err) {
        console.warn('[WhatsApp] Reload failed:', err.message);
      }
      if (this._loadingStuckCount >= 2 && !this.initializing) {
        this._loadingStuckCount = 0;
        try {
          await this.init({ force: true });
        } catch (_) {}
      } else if (!this.ready) {
        this.armLoadingWatchdog(percent, message);
      }
    }, stuckMs);
  }

  clearSessionFiles() {
    rmDirSafe(AUTH_PATH);
    rmDirSafe(CACHE_PATH);
  }

  async destroyClient() {
    this.clearLoadingWatchdog();
    this._stopSeenCleanup();
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      if (this._boundMessageHandler) client.removeListener('message', this._boundMessageHandler);
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
      this.status = 'initializing';
      this.ready = false;
      this.clearQr('reinit');
      this.setConnectionPhase('initializing', `attempt ${this._initAttempt}`);

      const launchOpts = await buildPuppeteerLaunchOptions();
      console.log(
        `[WhatsApp] puppeteer-core launch headless=${launchOpts.headless}` +
          (isRenderLike() ? ' [Render]' : '')
      );

      const cacheDir = path.join(process.cwd(), '.wwebjs_cache');
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
      } catch (_) {}

      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_PATH, clientId: CLIENT_ID }),
        puppeteer: launchOpts,
        userAgent:
          process.env.WHATSAPP_USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        webVersionCache: {
          type: process.env.WA_WEB_VERSION_CACHE === 'none' ? 'none' : 'local',
          path: cacheDir,
        },
        qrMaxRetries: Number(process.env.WA_QR_MAX_RETRIES) || 20,
        takeoverOnConflict: true,
        takeoverTimeoutMs: Number(process.env.WA_TAKEOVER_TIMEOUT_MS) || 120000,
        authTimeoutMs: Number(process.env.WA_AUTH_TIMEOUT_MS) || 600000,
      });

      this._bindClientEvents(this.client);
      this.setConnectionPhase('connecting', 'opening WhatsApp Web…');
      await this.client.initialize();
      this._initAttempt = 0;
    } catch (err) {
      console.error('[WhatsApp] Init failed:', err);
      this.status = 'error';
      this.lastError = err.message || String(err);
      this.ready = false;
      this.setConnectionPhase('error', this.lastError);

      const maxAttempts = Number(process.env.WA_SERVICE_INIT_RETRIES) || 4;
      if (this._initAttempt < maxAttempts) {
        await this.destroyClient();
        if (!isTransientBrowserError(err)) {
          this.clearSessionFiles();
        }
        await sleep(2000 * this._initAttempt);
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
      this.clearLoadingWatchdog();
      this.emit('whatsapp:qr', { qr: null, seq, clearing: true, reason: 'refreshing' });
      this.setConnectionPhase('qr', `#${seq}`);
      try {
        const dataUrl = await qrcode.toDataURL(qr, {
          margin: 1,
          width: 360,
          errorCorrectionLevel: 'M',
        });
        if (seq !== this.qrSeq) return;
        this.qrDataUrl = dataUrl;
        this.emit('whatsapp:qr', { qr: dataUrl, seq, ts: Date.now() });
        this.emit('whatsapp:status', this.getPublicStatus());
        console.log(`[WhatsApp] QR #${seq} ready`);
      } catch (err) {
        console.error('[WhatsApp] QR failed:', err.message);
      }
    });

    client.on('loading_screen', (percent, message) => {
      const msg = String(message || '').trim() || 'Waiting';
      this.loadingPercent = percent;
      this.loadingMessage = msg;
      console.log(`[WhatsApp] Loading ${percent ?? '?'}% — ${msg}`);
      if (!this.ready) {
        this.status = 'loading';
        if (/link accepted|finishing|loading|waiting/i.test(msg)) this.clearQr('loading');
        this.setConnectionPhase('loading', `${percent ?? '?'}% ${msg}`);
        this.armLoadingWatchdog(percent, msg);
      }
    });

    client.on('authenticated', () => {
      this.status = 'authenticated';
      this.clearQr('authenticated');
      this.clearLoadingWatchdog();
      this.setConnectionPhase('authenticated', 'finishing sync…');
    });

    client.on('ready', async () => {
      this.status = 'ready';
      this.ready = true;
      this.lastError = null;
      this.loadingPercent = 100;
      this.loadingMessage = 'Connected';
      this.clearQr('ready');
      this.clearLoadingWatchdog();
      try {
        this.info = {
          pushname: this.client.info?.pushname || null,
          phone: this.client.info?.wid?.user || null,
          platform: this.client.info?.platform || null,
        };
      } catch (_) {
        this.info = null;
      }
      this.setConnectionPhase('ready', this.info?.phone || 'connected');
      console.log('[WhatsApp] Ready', this.info?.phone || '');
      this._startSeenCleanup();
    });

    client.on('auth_failure', async (msg) => {
      this.status = 'auth_failure';
      this.ready = false;
      this.lastError = String(msg);
      this.authFailCount += 1;
      console.error('[WhatsApp] Auth failure:', msg);
      if (this.authFailCount >= 2) {
        try {
          await this.resetSession({ reason: 'auth_failure' });
        } catch (_) {}
      }
    });

    client.on('disconnected', async (reason) => {
      this.status = 'disconnected';
      this.ready = false;
      this.info = null;
      this.lastError = String(reason || 'disconnected');
      this._stopSeenCleanup();
      console.warn('[WhatsApp] Disconnected:', reason);
      const r = String(reason || '').toUpperCase();
      if (r.includes('LOGOUT') || r.includes('CONFLICT')) {
        await this.destroyClient();
        this.clearSessionFiles();
      }
      await sleep(4000);
      try {
        await this.init({ force: true });
      } catch (err) {
        console.error('[WhatsApp] Reconnect failed:', err.message);
      }
    });

    this._boundMessageHandler = (message) => this.enqueueIncomingMessage(message);
    this._boundMessageCreateHandler = (message) => {
      if (message?.fromMe) return;
      this.enqueueIncomingMessage(message);
    };
    client.on('message', this._boundMessageHandler);
    client.on('message_create', this._boundMessageCreateHandler);
    console.log('[WhatsApp] Lean message listeners bound');
  }

  enqueueIncomingMessage(message) {
    const maxDepth = Number(process.env.WA_MSG_QUEUE_MAX) || 30;
    if (this._msgQueueDepth >= maxDepth) {
      console.warn('[WhatsApp] Queue full — dropping message');
      return;
    }
    this._msgQueueDepth += 1;
    this._msgQueue = this._msgQueue
      .then(async () => {
        try {
          await this.handleIncomingMessage(message);
        } catch (err) {
          console.error('[WhatsApp] Handler error:', err?.message || err);
        } finally {
          this._msgQueueDepth = Math.max(0, this._msgQueueDepth - 1);
          await sleep(Number(process.env.WA_MSG_YIELD_MS) || 40);
        }
      })
      .catch(() => {
        this._msgQueueDepth = Math.max(0, this._msgQueueDepth - 1);
      });
  }

  _startSeenCleanup() {
    this._stopSeenCleanup();
    this._seenCleanupTimer = setInterval(() => this._pruneSeenIds(), 60000);
    if (typeof this._seenCleanupTimer.unref === 'function') this._seenCleanupTimer.unref();
  }

  _stopSeenCleanup() {
    if (this._seenCleanupTimer) {
      clearInterval(this._seenCleanupTimer);
      this._seenCleanupTimer = null;
    }
  }

  _pruneSeenIds() {
    const now = Date.now();
    const ttl = Number(process.env.WA_SEEN_TTL_MS) || 60000;
    const max = Number(process.env.WA_SEEN_MAX) || 150;
    for (const [k, ts] of this._seenMsgIds) {
      if (now - ts > ttl) this._seenMsgIds.delete(k);
    }
    if (this._seenMsgIds.size > max) {
      const entries = [...this._seenMsgIds.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - max; i++) this._seenMsgIds.delete(entries[i][0]);
    }
  }

  _markSeen(message) {
    const id = message?.id?._serialized || message?.id?.$1 || message?.id?.id || null;
    if (!id) return false;
    if (this._seenMsgIds.has(id)) return true;
    this._seenMsgIds.set(id, Date.now());
    if (this._seenMsgIds.size > 200) this._pruneSeenIds();
    return false;
  }

  formatPhone(phone) {
    return String(phone || '').replace(/\D/g, '');
  }

  async sendMessage(to, body, options = {}) {
    if (!this.client) throw new Error('WhatsApp client is not ready');
    const text = String(body || '');
    if (!text) return null;

    const run = async () => {
      if (options.replyTo && typeof options.replyTo.reply === 'function') {
        try {
          const result = await options.replyTo.reply(text);
          MessageLog.add({ direction: 'out', phone: this.formatPhone(to), body: text });
          return result;
        } catch (_) {}
      }
      const chatId =
        options.chatId ||
        (String(to).includes('@') ? String(to) : `${this.formatPhone(to)}@c.us`);
      const result = await this.client.sendMessage(chatId, text);
      MessageLog.add({
        direction: 'out',
        phone: this.formatPhone(to) || String(chatId).replace(/@.+$/, ''),
        body: text,
      });
      return result;
    };

    const next = this._sendQueue.then(run, run);
    this._sendQueue = next.catch(() => {});
    return next;
  }

  async handleIncomingMessage(message) {
    if (this._markSeen(message)) return;
    if (message.fromMe || message.isStatus) return;
    if (message.from?.endsWith('@g.us')) return;

    const chatId = message.from;
    const phone = String(chatId || '').replace(/@.+$/, '');
    const body = String(message.body || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    if (!body) return;

    console.log(`[WhatsApp] IN ${phone}: ${body.slice(0, 80)}`);
    try {
      MessageLog.add({ direction: 'in', phone, body });
    } catch (_) {}

    // Minimal auto-reply — no forms, workflows, or desk bridge
    let reply;
    if (isGreeting(body)) {
      reply =
        Settings.get('welcome_message') ||
        'Hello! 👋 Thanks for messaging us. How can we help you today?';
    } else {
      reply =
        Settings.get('default_reply') ||
        'Thanks for your message. Our team will get back to you shortly.';
    }

    try {
      await this.sendMessage(phone, reply, { chatId, replyTo: message });
    } catch (err) {
      console.error('[WhatsApp] Reply failed:', err.message);
    }
  }

  async logout() {
    this.ready = false;
    this.status = 'disconnected';
    if (this.client) {
      try {
        await this.client.logout();
      } catch (_) {}
    }
    await this.destroyClient();
    this.clearSessionFiles();
    await sleep(1000);
    return this.init({ force: true });
  }
}

module.exports = new WhatsAppService();
