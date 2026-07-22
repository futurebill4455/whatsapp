/**
 * Lean in-memory WhatsApp bot for Render free tier.
 * Flow: trigger → form link → Yes → forward to company → relay until "close".
 * No DB / message log / lead storage. WhatsApp LocalAuth only (device link).
 */
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const {
  config,
  digits,
  renderTemplate,
  isTrigger,
  isClose,
  isYes,
  isNo,
} = require('../config/runtime');
const store = require('../store/memory');
const { buildPuppeteerLaunchOptions, isRenderLike } = require('./chromiumLaunch');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_PATH = path.join(process.cwd(), '.wwebjs_cache');
const CLIENT_ID = 'insurance-bot';
const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      memory: store.stats(),
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

      if (!config.companyPhone) {
        console.warn('[WhatsApp] COMPANY_PHONE is not set — forwards will fail until configured');
      }

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
  }

  enqueueIncomingMessage(message) {
    const maxDepth = Number(process.env.WA_MSG_QUEUE_MAX) || 25;
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
    const t = Date.now();
    const ttl = Number(process.env.WA_SEEN_TTL_MS) || 60000;
    const max = Number(process.env.WA_SEEN_MAX) || 120;
    for (const [k, ts] of this._seenMsgIds) {
      if (t - ts > ttl) this._seenMsgIds.delete(k);
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
    if (this._seenMsgIds.size > 160) this._pruneSeenIds();
    return false;
  }

  async sendMessage(to, body, options = {}) {
    if (!this.client) throw new Error('WhatsApp client is not ready');
    const text = String(body || '');
    if (!text) return null;

    const run = async () => {
      if (options.replyTo && typeof options.replyTo.reply === 'function') {
        try {
          return await options.replyTo.reply(text);
        } catch (_) {}
      }
      const chatId =
        options.chatId ||
        (String(to).includes('@') ? String(to) : `${digits(to)}@c.us`);
      return this.client.sendMessage(chatId, text);
    };

    const next = this._sendQueue.then(run, run);
    this._sendQueue = next.catch(() => {});
    return next;
  }

  async _quotedWaId(message) {
    try {
      if (message?.hasQuotedMsg && typeof message.getQuotedMessage === 'function') {
        const q = await message.getQuotedMessage();
        const id = q?.id?._serialized || q?.id?.$1 || q?.id?.id;
        if (id) return String(id);
      }
    } catch (_) {}
    try {
      const raw =
        message?._data?.quotedMsgId ||
        message?._data?.quotedStanzaID ||
        message?.quotedMsgId;
      if (raw) return String(raw);
    } catch (_) {}
    return null;
  }

  async handleIncomingMessage(message) {
    if (this._markSeen(message)) return;
    if (message.fromMe || message.isStatus) return;
    if (message.from?.endsWith('@g.us')) return;

    const chatId = message.from;
    const phone = digits(String(chatId || '').replace(/@.+$/, ''));
    const body = String(message.body || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();

    const isCompanyPhone = config.companyPhone && phone === config.companyPhone;
    const isCompanyChat = !isCompanyPhone && store.isCompanyChatId(chatId);

    if (isCompanyPhone || isCompanyChat) {
      await this._handleCompanyMessage(message, phone, chatId, body);
      return;
    }

    if (!body) return;

    // Active customer bridge
    const bridge = store.getBridgeByCustomer(phone);
    if (bridge) {
      if (isClose(body)) {
        await this._closeBridge(bridge, { notifyCompany: true, replyTo: message });
        return;
      }
      store.bindCustomerChatId(bridge.id, chatId);
      store.touchBridge(bridge.id, 'customer');
      const relay = `[#${bridge.code}] ${body}`;
      try {
        const companyChat = bridge.companyChatId || `${bridge.companyPhone}@c.us`;
        const sent = await this.sendMessage(bridge.companyPhone, relay, { chatId: companyChat });
        const waId = sent?.id?._serialized || sent?.id?.id;
        store.trackWaMessage(bridge.id, waId);
      } catch (err) {
        console.error('[WhatsApp] Relay to company failed:', err.message);
        await this.sendMessage(phone, 'Could not reach the company right now. Try again shortly.', {
          chatId,
          replyTo: message,
        });
      }
      return;
    }

    // Pending confirmation
    const pending = store.getPendingByPhone(phone);
    if (pending?.status === 'awaiting_confirmation') {
      if (isYes(body)) {
        await this._confirmAndOpenBridge(pending, { chatId, replyTo: message });
        return;
      }
      if (isNo(body)) {
        store.clearPending(pending.token);
        await this.sendMessage(phone, config.cancelMessage, { chatId, replyTo: message });
        return;
      }
      await this.sendMessage(
        phone,
        'Please reply *Yes* to confirm or *No* to cancel.',
        { chatId, replyTo: message }
      );
      return;
    }

    if (pending?.status === 'awaiting_form') {
      if (isNo(body) || isClose(body)) {
        store.clearPending(pending.token);
        await this.sendMessage(phone, config.cancelMessage, { chatId, replyTo: message });
        return;
      }
      if (isTrigger(body)) {
        const link = `${config.baseUrl}/form/${pending.token}`;
        const text = renderTemplate(config.linkMessage, {
          business_name: config.businessName,
          form_link: link,
        });
        await this.sendMessage(phone, text, { chatId, replyTo: message });
        return;
      }
      await this.sendMessage(phone, config.pendingFormMessage, { chatId, replyTo: message });
      return;
    }

    // New trigger → form link
    if (isTrigger(body)) {
      if (!config.companyPhone) {
        await this.sendMessage(
          phone,
          'Bot is not configured yet (missing COMPANY_PHONE).',
          { chatId, replyTo: message }
        );
        return;
      }
      const row = store.createPending({ customerPhone: phone, customerChatId: chatId });
      const link = `${config.baseUrl}/form/${row.token}`;
      const text = renderTemplate(config.linkMessage, {
        business_name: config.businessName,
        form_link: link,
      });
      await this.sendMessage(phone, text, { chatId, replyTo: message });
      return;
    }

    // Ignore non-trigger noise when idle (saves outbound spam / RAM)
  }

  async _handleCompanyMessage(message, phone, chatId, body) {
    const { bridge, method } = store.resolveCompanyInbound(config.companyPhone || phone, {
      quotedWaId: await this._quotedWaId(message),
      body,
      chatId,
    });

    if (!bridge) {
      if (body) console.log('[WhatsApp] Company message with no active bridge — ignored');
      return;
    }

    store.bindCompanyChatId(bridge.id, chatId);
    store.touchBridge(bridge.id, 'company');

    let text = body;
    if (!text) {
      text = '[Media / non-text message — please describe in text]';
    } else {
      text = text.replace(/\[#[A-Z0-9]{3,6}\]\s*/gi, '').trim() || text;
    }

    const customerChat = bridge.customerChatId || `${bridge.customerPhone}@c.us`;
    try {
      const sent = await this.sendMessage(bridge.customerPhone, text, { chatId: customerChat });
      const waId = sent?.id?._serialized || sent?.id?.id;
      store.trackWaMessage(bridge.id, waId);
      if (method === 'last_customer') {
        console.log(`[WhatsApp] Company→customer via last-active [#${bridge.code}]`);
      }
    } catch (err) {
      console.error('[WhatsApp] Relay to customer failed:', err.message);
    }
  }

  async _confirmAndOpenBridge(pending, { chatId, replyTo } = {}) {
    if (!config.companyPhone) {
      await this.sendMessage(pending.customerPhone, 'Company number is not configured.', {
        chatId,
        replyTo,
      });
      return;
    }

    const summary = store.formatSummary(pending.data);
    const bridge = store.openBridge({
      customerPhone: pending.customerPhone,
      customerChatId: chatId || pending.customerChatId,
      companyPhone: config.companyPhone,
      data: pending.data,
    });
    store.clearPending(pending.token);

    const companyMsg = renderTemplate(config.companyNotifyTemplate, {
      code: bridge.code,
      summary,
      business_name: config.businessName,
    });

    try {
      const sent = await this.sendMessage(config.companyPhone, companyMsg);
      const waId = sent?.id?._serialized || sent?.id?.id;
      store.trackWaMessage(bridge.id, waId);
      if (sent?.to) store.bindCompanyChatId(bridge.id, String(sent.to));
    } catch (err) {
      console.error('[WhatsApp] Forward to company failed:', err.message);
      store.closeBridge(bridge.id);
      await this.sendMessage(
        pending.customerPhone,
        'Could not reach the company. Please try again later with Hi.',
        { chatId, replyTo }
      );
      return;
    }

    await this.sendMessage(pending.customerPhone, config.successMessage, { chatId, replyTo });
  }

  async _closeBridge(bridge, { notifyCompany = false, replyTo = null } = {}) {
    store.closeBridge(bridge.id);
    try {
      await this.sendMessage(bridge.customerPhone, config.closeMessage, {
        chatId: bridge.customerChatId,
        replyTo,
      });
    } catch (_) {}
    if (notifyCompany) {
      try {
        await this.sendMessage(
          bridge.companyPhone,
          `Chat [#${bridge.code}] closed by customer.`,
          { chatId: bridge.companyChatId }
        );
      } catch (_) {}
    }
  }

  /** Called from HTTP after form submit — ask Yes/No on WhatsApp */
  async notifyFormSubmitted(token) {
    const pending = store.getPendingByToken(token);
    if (!pending || pending.status !== 'awaiting_confirmation') return false;
    const summary = store.formatSummary(pending.data);
    const text = renderTemplate(config.confirmationPrompt, { summary });
    await this.sendMessage(pending.customerPhone, text, {
      chatId: pending.customerChatId,
    });
    return true;
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
