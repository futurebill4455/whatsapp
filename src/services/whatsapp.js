const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const {
  Settings,
  Submissions,
  MessageLog,
  Workflows,
  WorkflowRuns,
  InternalNumbers,
  ChatSessions,
} = require('../models');
const { WorkflowEngine } = require('./workflowEngine');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_PATH = path.join(process.cwd(), '.wwebjs_cache');
const CLIENT_ID = 'insurance-bot';

/** Always-on greetings — work even if Admin Panel / DB triggers are misconfigured */
const HARDCODED_GREETINGS = ['hi', 'hello', 'hey', 'start', 'ഹായ്'];
const CLOSE_KEYWORDS = ['close', 'ക്ലോസ്'];

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

function isCloseCommand(text) {
  const n = normalizeMsg(text);
  return CLOSE_KEYWORDS.some((k) => n === k.toLowerCase());
}

function humanDelayMs() {
  return 3000 + Math.floor(Math.random() * 2001);
}

const DEFAULT_USER_AGENT =
  process.env.WHATSAPP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Chromium flags required on Render / Linux (no sandbox) and low-memory hosts */
function buildPuppeteerArgs(extraArgs = []) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-software-rasterizer',
    '--disable-features=IsolateOrigins,site-per-process',
    '--mute-audio',
    '--window-size=1280,720',
  ];

  const wantSingle =
    process.env.PUPPETEER_SINGLE_PROCESS === '1' ||
    (process.env.PUPPETEER_NO_SINGLE_PROCESS !== '1' && process.platform !== 'win32');

  if (wantSingle) args.push('--single-process');

  for (const a of extraArgs) {
    if (a && !args.includes(a)) args.push(a);
  }
  return args;
}

/**
 * Build puppeteer-core launch options using @sparticuz/chromium on Render/Linux.
 * Optional PUPPETEER_EXECUTABLE_PATH / system Chrome for local Windows/macOS.
 */
async function buildPuppeteerLaunchOptions() {
  // @sparticuz/chromium is ESM; CJS consumers get the class on `.default`
  const chromiumMod = require('@sparticuz/chromium');
  const chromium = chromiumMod.default || chromiumMod;

  const envPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    process.env.CHROMIUM_PATH;

  let executablePath = null;
  let extraArgs = [];
  let headless = true;
  let source = 'none';

  const useSparticuz =
    process.env.USE_SPARTICUZ_CHROMIUM === '1' ||
    process.platform === 'linux' ||
    !!process.env.RENDER ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  if (envPath && fs.existsSync(envPath)) {
    executablePath = envPath;
    source = 'env';
  } else if (useSparticuz) {
    // Primary path for Render: inflate + return path from chromium.br (no Chrome download)
    try {
      chromium.setGraphicsMode = true;
    } catch (_) {}
    executablePath = await chromium.executablePath();
    extraArgs = typeof chromium.args !== 'undefined' ? [...chromium.args] : [];
    // chrome-headless-shell is required by recent @sparticuz/chromium builds
    headless = 'shell';
    source = 'sparticuz';
  } else {
    // Local Windows/macOS: prefer installed Chrome so WhatsApp Web still works
    const systemPaths =
      process.platform === 'win32'
        ? [
            process.env.LOCALAPPDATA &&
              path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];

    for (const candidate of systemPaths.filter(Boolean)) {
      if (fs.existsSync(candidate)) {
        executablePath = candidate;
        source = 'system';
        break;
      }
    }

    if (!executablePath) {
      try {
        chromium.setGraphicsMode = true;
      } catch (_) {}
      executablePath = await chromium.executablePath();
      extraArgs = typeof chromium.args !== 'undefined' ? [...chromium.args] : [];
      headless = 'shell';
      source = 'sparticuz';
    }
  }

  const headlessEnv = process.env.PUPPETEER_HEADLESS;
  if (headlessEnv === 'false') headless = false;
  else if (headlessEnv === 'shell' || headlessEnv === 'new' || headlessEnv === 'true') {
    headless = headlessEnv === 'true' ? true : headlessEnv;
  }

  if (!executablePath) {
    throw new Error(
      'Could not find Chrome/Chromium. On Render, @sparticuz/chromium must provide chromium.executablePath(). ' +
        'Locally, install Chrome or set PUPPETEER_EXECUTABLE_PATH.'
    );
  }

  console.log(`[WhatsApp] Browser source=${source} executablePath=${executablePath}`);

  return {
    headless,
    executablePath,
    args: buildPuppeteerArgs(extraArgs),
    defaultViewport: { width: 1280, height: 720 },
    protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 180000,
    timeout: Number(process.env.PUPPETEER_TIMEOUT) || 120000,
    ignoreHTTPSErrors: true,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    this._initPromise = null;
    this._sendQueue = Promise.resolve();
    this._seenMsgIds = new Map();
    this.engine = new WorkflowEngine(this);
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
    };
  }

  getBaseUrl() {
    return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
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
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try { client.removeAllListeners(); } catch (_) {}
    try { await client.destroy(); } catch (err) {
      console.warn('[WhatsApp] destroy warning:', err.message);
    }
  }

  async resetSession({ reason = 'manual reset' } = {}) {
    console.log(`[WhatsApp] Resetting session (${reason})…`);
    this.status = 'resetting';
    this.ready = false;
    this.info = null;
    this.lastError = null;
    this.authFailCount = 0;
    this.clearQr('reset');
    this.emit('whatsapp:status', this.getPublicStatus());
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
    try {
      await this.destroyClient();
      this.status = 'initializing';
      this.ready = false;
      this.clearQr('reinit');
      this.emit('whatsapp:status', this.getPublicStatus());

      const launchOpts = await buildPuppeteerLaunchOptions();
      console.log(
        '[WhatsApp] Launching browser (puppeteer-core) headless=%s executablePath=%s',
        launchOpts.headless,
        launchOpts.executablePath
      );

      this.client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_PATH, clientId: CLIENT_ID }),
        puppeteer: launchOpts,
        userAgent: DEFAULT_USER_AGENT,
        webVersionCache: { type: 'none' },
        qrMaxRetries: 15,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 10000,
        authTimeoutMs: 120000,
      });

      this._bindClientEvents(this.client);
      await this.client.initialize();
    } catch (err) {
      console.error('[WhatsApp] Init failed:', err);
      this.status = 'error';
      this.lastError = err.message || String(err);
      this.ready = false;
      this.emit('whatsapp:status', this.getPublicStatus());
      if (this.authFailCount < 3) {
        this.authFailCount += 1;
        console.warn('[WhatsApp] Clearing session after init failure and retrying…');
        await this.destroyClient();
        await sleep(2000);
        this.clearSessionFiles();
        await sleep(1500);
        this.initializing = false;
        return this._doInit();
      }
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
      this.emit('whatsapp:qr', { qr: null, seq, clearing: true, reason: 'refreshing' });
      this.emit('whatsapp:status', this.getPublicStatus());
      try {
        const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
        if (seq !== this.qrSeq) return;
        this.qrDataUrl = dataUrl;
        this.emit('whatsapp:qr', { qr: dataUrl, seq, ts: Date.now() });
        this.emit('whatsapp:status', this.getPublicStatus());
        console.log(`[WhatsApp] QR #${seq} ready — scan promptly (codes expire ~20s)`);
      } catch (err) {
        if (seq !== this.qrSeq) return;
        console.error('[WhatsApp] QR generation failed:', err.message);
        this.lastError = err.message;
        this.emit('whatsapp:status', this.getPublicStatus());
      }
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[WhatsApp] Loading ${percent}% ${message || ''}`);
      if (!this.ready) {
        this.status = 'loading';
        this.clearQr('loading');
        this.emit('whatsapp:status', this.getPublicStatus());
      }
    });

    client.on('authenticated', () => {
      this.status = 'authenticated';
      this.authFailCount = 0;
      this.clearQr('authenticated');
      this.emit('whatsapp:status', this.getPublicStatus());
      console.log('[WhatsApp] Authenticated — waiting for ready…');
    });

    client.on('ready', async () => {
      this.status = 'ready';
      this.ready = true;
      this.authFailCount = 0;
      this.lastError = null;
      this.clearQr('ready');
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
      this.emit('whatsapp:status', this.getPublicStatus());
      console.log('[WhatsApp] Client ready', this.info?.phone || '');
      console.log('[WhatsApp] Listening for incoming messages — send Hi to test');
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

    // Primary + secondary listeners (message_create catches some multi-device deliveries)
    const onIncoming = async (message) => {
      try {
        await this.handleIncomingMessage(message);
      } catch (err) {
        console.error('[WhatsApp] Message handler error:', err?.message || err);
        console.error(err?.stack || '');
      }
    };

    client.on('message', onIncoming);
    client.on('message_create', async (message) => {
      // message_create also fires for outbound — skip those early
      if (message.fromMe) return;
      await onIncoming(message);
    });

    console.log('[WhatsApp] Message listeners bound (message + message_create)');
  }

  _markSeen(message) {
    const id = message?.id?._serialized || message?.id?.id || null;
    if (!id) return false;
    const now = Date.now();
    if (this._seenMsgIds.has(id)) return true;
    this._seenMsgIds.set(id, now);
    if (this._seenMsgIds.size > 500) {
      for (const [k, ts] of this._seenMsgIds) {
        if (now - ts > 120000) this._seenMsgIds.delete(k);
      }
    }
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
   * Never blocks replies — getContact is timed out.
   */
  async resolveIncomingPeer(message) {
    const chatId = message.from;
    let phone = String(chatId || '').replace(/@.+$/, '');

    try {
      const contact = await Promise.race([
        message.getContact(),
        sleep(1200).then(() => null),
      ]);
      if (contact) {
        const number = contact.number || contact.id?.user;
        // Prefer real phone numbers; ignore pure LID-looking ids when we already have chatId
        if (number && String(number).replace(/\D/g, '').length >= 10) {
          phone = String(number).replace(/\D/g, '');
        }
      }
    } catch (err) {
      console.warn('[WhatsApp] getContact failed:', err.message);
    }

    phone = this.formatPhone(phone) || phone;
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
   * Queued send. For inbound turns, ALWAYS prefer msg.reply / inbound chatId (LID-safe).
   */
  async sendMessage(to, body, options = {}) {
    if (!this.client) {
      throw new Error('WhatsApp client is not ready');
    }
    if (!this.ready) {
      console.warn('[WhatsApp] sendMessage called while not ready — attempting anyway');
    }

    const run = async () => {
      const text = String(body || '');
      if (!text) return null;

      const logPhone = this.formatPhone(to) || String(to || '').replace(/@.+$/, '');

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
        // Optional extra candidate for real phone numbers (desk forwards)
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

    // ── Two-way chat bridge (customer ↔ desk) — highest priority after logging ──
    try {
      const bridged = await this.handleChatBridge(message, phone, chatId, body);
      if (bridged) return;
    } catch (err) {
      console.error('[ChatBridge] Error:', err.message);
    }

    if (!body) return;

    const payload = { phone, body, chatId, replyTo: message };

    try {
      if (Workflows.getActive()) {
        const result = await this.engine.handleIncomingMessage(payload);
        console.log(
          '[WhatsApp] Workflow result:',
          result?.reason || (result?.handled ? 'handled' : 'unhandled'),
          result?.waiting || ''
        );
        if (result?.handled) return;
        if (result?.reason === 'unmatched_reply' && !isHardcodedGreeting(body)) return;
      }

      // Yes/No recovery without active waiter
      const lower = normalizeMsg(body);
      if (['yes', 'y', 'confirm', 'ok', 'okay'].includes(lower)) {
        const pending = Submissions.findPendingConfirmation(phone);
        if (pending) {
          await this.confirmAndForward(pending, { chatId, replyTo: message });
          return;
        }
      }
      if (['no', 'n', 'cancel'].includes(lower)) {
        const pending = Submissions.findPendingConfirmation(phone);
        if (pending) {
          await this.engine.resendFormAfterDecline(
            pending,
            this.engine.getActiveGraph()?.nodes || {},
            { phone, chatId, replyTo: message }
          );
          return;
        }
      }

      // Safety net: Hi / ഹായ് always get a form link
      if (isHardcodedGreeting(body)) {
        console.log('[WhatsApp] Hardcoded greeting fallback for:', body);
        await this.sendGreetingFormLink(phone, { chatId, replyTo: message });
      } else {
        console.log('[WhatsApp] No trigger matched for:', JSON.stringify(body));
      }
    } catch (err) {
      console.error('[WhatsApp] Flow execution error:', err?.message || err);
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

    // ── Desk side (phone OR @lid chat id) ──
    let deskSessions = await this.resolveDeskSessionsForInbound(digits, chatId);
    if (deskSessions.length > 0) {
      if (body && isCloseCommand(body)) {
        console.log('[ChatBridge] Ignoring close from desk — customer must close');
        try {
          await this.sendMessage(
            digits,
            'ℹ️ Only the *customer* can end a chat by sending *close*. Please *reply to* their message (or include their [#CODE]).',
            { chatId, replyTo: message }
          );
        } catch (_) {}
        return true;
      }

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

      // If resolve used phone-only and failed, fall back to deskSessions[0]
      const session = resolved.session || deskSessions[0];
      if (!session) {
        console.warn('[ChatBridge] Desk message with no resolvable session', {
          phone: digits,
          chatId,
          hasMedia,
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

  async closeChatSession(session, { closedBy = 'customer', replyTo, chatId } = {}) {
    if (closedBy !== 'customer') {
      console.warn('[ChatBridge] closeChatSession blocked — not customer');
      return;
    }

    ChatSessions.close(session.id);
    console.log(
      `[ChatBridge] Session #${session.id} [${session.session_code}] closed by customer ${session.customer_phone}`
    );

    const thanks =
      Settings.get('chat_close_message') ||
      'Thank you! Your conversation has been ended. Have a good day!';

    try {
      await this.sendMessage(session.customer_phone, thanks, {
        chatId: session.customer_chat_id || chatId,
        replyTo,
      });
    } catch (err) {
      console.error('[ChatBridge] Failed to send close message to customer:', err.message);
    }

    try {
      await this.sendMessage(
        session.desk_phone,
        `ℹ️ Customer chat [#${session.session_code || session.id}] (${session.customer_phone}) has ended.`,
        { chatId: session.desk_chat_id || undefined }
      );
    } catch (err) {
      console.warn('[ChatBridge] Desk close notify skipped:', err.message);
    }
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
   * Forward text/media across the bridge. Downloads desk media with retries.
   */
  async relayMessageAcrossBridge(message, session, direction, body, hasMediaFlag = null) {
    this.normalizeIncomingMessageIds(message);

    const toCustomer = direction === 'desk_to_customer';
    const destPhone = toCustomer ? session.customer_phone : session.desk_phone;
    const destChatId = toCustomer ? session.customer_chat_id : session.desk_chat_id;
    const company = session.company_name || 'insurer';
    const code = session.session_code || String(session.id);
    const msgType = String(message.type || '').toLowerCase();
    const hasMedia =
      hasMediaFlag != null
        ? hasMediaFlag
        : !!(
            message.hasMedia ||
            ['image', 'video', 'document', 'ptt', 'audio', 'sticker'].includes(msgType)
          );

    console.log(
      `[ChatBridge] #${session.id}[${code}] ${direction} type=${message.type || 'chat'} media=${hasMedia}: ${(body || '').slice(0, 60)}`
    );

    if (!destPhone && !destChatId) {
      console.error('[ChatBridge] No destination phone/chatId for relay');
      return;
    }

    const prefix = toCustomer
      ? `📩 *${company}*\n\n`
      : `💬 *Customer* [#${code}]\n📞 ${session.customer_phone}\n\n`;

    try {
      let sent = null;

      if (hasMedia) {
        // Brief settle so WhatsApp finishes writing media keys / blob cache
        await sleep(500);
        const media = await this.downloadMediaWithRetry(message);
        if (media) {
          const caption = body
            ? `${prefix}${body}`
            : `${prefix}${toCustomer ? 'Sent you a file' : 'Customer sent a file'}`;
          console.log(
            `[ChatBridge] Forwarding media mimetype=${media.mimetype} type=${msgType} → ${destChatId || destPhone}`
          );
          sent = await this.sendMedia(destPhone || destChatId, media, {
            caption,
            chatId: destChatId || undefined,
            sendAudioAsVoice: msgType === 'ptt',
            sendMediaAsDocument: msgType === 'document',
          });
        } else {
          console.error('[ChatBridge] downloadMedia failed — sending text fallback');
          if (body) {
            sent = await this.sendMessage(destPhone || destChatId, `${prefix}${body}`, {
              chatId: destChatId || undefined,
            });
          } else {
            sent = await this.sendMessage(
              destPhone || destChatId,
              `${prefix}(Received a file that could not be downloaded — please resend)`,
              { chatId: destChatId || undefined }
            );
          }
        }
      } else if (body) {
        sent = await this.sendMessage(destPhone || destChatId, `${prefix}${body}`, {
          chatId: destChatId || undefined,
        });
      } else {
        console.warn('[ChatBridge] Nothing to relay (empty body, no media)');
        return;
      }

      const waId =
        sent?.id?._serialized || sent?.id?.$1 || sent?.id?.id || null;
      if (waId) {
        ChatSessions.trackMessage(session.id, direction, waId, body);
      }
      // Also bind outbound chat id when sending to desk
      if (!toCustomer && sent?._outboundChatId) {
        ChatSessions.bindDeskChatId(session.id, sent._outboundChatId);
      }

      MessageLog.add({
        direction: 'out',
        phone: destPhone,
        body: `[bridge ${direction}] ${body || '[media]'}`,
        meta: { session_id: session.id, session_code: code, direction, wa_id: waId },
      });
      console.log(`[ChatBridge] Relay OK → ${destChatId || destPhone}`);
    } catch (err) {
      console.error(`[ChatBridge] Relay ${direction} failed:`, err.message);
    }
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
      const chatId =
        options.chatId ||
        (String(to).includes('@') ? String(to) : await this.resolveOutboundChatId(to));

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
      console.log(`[WhatsApp] Media sent → ${chatId}`);
      return result;
    };
    const next = this._sendQueue.then(run, run);
    this._sendQueue = next.catch(() => {});
    return next;
  }

  /**
   * Always-available greeting reply (does not depend on Admin Panel keywords).
   */
  async sendGreetingFormLink(phone, opts = {}) {
    const existing = Submissions.findLatestOpen(phone);
    if (existing && existing.status === 'awaiting_confirmation') {
      await this.sendMessage(
        phone,
        Settings.get('already_pending_message') ||
          'You already have a pending request. Reply *Yes* / *No* to confirm.',
        opts
      );
      return true;
    }

    const submission =
      existing && existing.status === 'awaiting_form'
        ? existing
        : Submissions.create({ token: uuidv4(), customer_phone: phone });
    if (opts.chatId) Submissions.setCustomerChatId(submission.token, opts.chatId);

    // Arm workflow waiter for form_submit if possible
    try {
      const active = this.engine.getActiveGraph();
      if (active) {
        const formNode = Object.values(active.nodes).find((n) => n.type === 'form_submit');
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
      console.warn('[WhatsApp] Could not arm form_submit waiter:', err.message);
    }

    const formLink = `${this.getBaseUrl()}/form/${submission.token}`;
    const business = Settings.get('business_name', 'SecureLife Insurance');
    const text =
      `Welcome to *${business}*! 👋\n\n` +
      `To get started with your insurance enquiry, please fill out this short form:\n${formLink}\n\n` +
      `Our team will assist you once you submit and confirm your details.`;

    const delay = humanDelayMs();
    console.log(`[WhatsApp] Greeting delay ${delay}ms before form link`);
    await sleep(delay);
    await this.sendMessage(phone, text, opts);
    console.log(`[WhatsApp] Greeting form link sent → ${phone}: ${formLink}`);
    return true;
  }

  async sendFormConfirmation(submission) {
    if (Workflows.getActive()) {
      const result = await this.engine.handleFormSubmit(submission);
      if (result.handled) return;
    }

    const { buildLeadVars, renderTemplate } = require('../utils/leadSummary');
    const vars = buildLeadVars(submission);
    const template = Settings.get('confirmation_template');
    const text = renderTemplate(template, vars);
    try {
      await this.sendMessage(submission.customer_phone, text);
    } catch (err) {
      console.error('[WhatsApp] Legacy confirmation send failed:', err.message);
    }
  }

  async confirmAndForward(submission, opts = {}) {
    await this.engine.forwardLeadToDesk(submission, {
      phone: submission.customer_phone,
      chatId: opts.chatId,
      replyTo: opts.replyTo,
    });
  }
}

module.exports = new WhatsAppService();
