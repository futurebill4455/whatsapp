const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const {
  Settings,
  ChatFlow,
  Submissions,
  InternalNumbers,
  MessageLog,
} = require('../models');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_PATH = path.join(process.cwd(), '.wwebjs_cache');
const CLIENT_ID = 'insurance-bot';

/** Chrome-like UA so WhatsApp Web accepts the Puppeteer session */
const DEFAULT_USER_AGENT =
  process.env.WHATSAPP_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildPuppeteerArgs() {
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
    '--mute-audio',
    '--window-size=1280,720',
  ];

  // Helps some linking failures; can be unstable on Windows — enable by default
  // unless PUPPETEER_NO_SINGLE_PROCESS=1 is set.
  if (process.env.PUPPETEER_NO_SINGLE_PROCESS !== '1') {
    args.push('--single-process');
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rmDirSafe(dir) {
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
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
  }

  attachSocket(io) {
    this.io = io;
    io.on('connection', (socket) => {
      socket.emit('whatsapp:status', this.getPublicStatus());
      if (this.qrDataUrl) {
        socket.emit('whatsapp:qr', {
          qr: this.qrDataUrl,
          seq: this.qrSeq,
          ts: Date.now(),
        });
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
    return String(phone).replace(/\D/g, '');
  }

  toChatId(phone) {
    const digits = this.formatPhone(phone);
    return digits.includes('@') ? digits : `${digits}@c.us`;
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

  /**
   * Wipe LocalAuth + web cache folders. Safe to call when client is destroyed.
   */
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
    try {
      client.removeAllListeners();
    } catch (_) {}
    try {
      await client.destroy();
    } catch (err) {
      console.warn('[WhatsApp] destroy warning:', err.message);
    }
  }

  /**
   * Full reset: destroy client, delete LocalAuth, re-init for a fresh QR.
   */
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

      const puppeteerOpts = {
        headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : true,
        args: buildPuppeteerArgs(),
        defaultViewport: { width: 1280, height: 720 },
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: AUTH_PATH,
          clientId: CLIENT_ID,
        }),
        puppeteer: puppeteerOpts,
        userAgent: DEFAULT_USER_AGENT,
        // Avoid stale pinned remote HTML; let the library use the live WA Web build
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

      // Corrupted session often breaks initialize — clear and retry once
      if (this.authFailCount < 3) {
        this.authFailCount += 1;
        console.warn('[WhatsApp] Clearing session after init failure and retrying…');
        await this.destroyClient();
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
      // Bump sequence first so in-flight async encodes of older QR are discarded
      const seq = ++this.qrSeq;
      this.status = 'qr';
      this.ready = false;
      this.info = null;
      this.qrDataUrl = null;

      // Tell UI immediately that the previous QR is invalid
      this.emit('whatsapp:qr', { qr: null, seq, clearing: true, reason: 'refreshing' });
      this.emit('whatsapp:status', this.getPublicStatus());

      try {
        const dataUrl = await qrcode.toDataURL(qr, {
          margin: 1,
          width: 360,
          errorCorrectionLevel: 'M',
        });

        // Race guard: a newer QR arrived while we were encoding
        if (seq !== this.qrSeq) {
          console.log(`[WhatsApp] Discarded stale QR encode (seq ${seq} < ${this.qrSeq})`);
          return;
        }

        this.qrDataUrl = dataUrl;
        this.emit('whatsapp:qr', {
          qr: dataUrl,
          seq,
          ts: Date.now(),
        });
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
      this.status = 'loading';
      this.clearQr('loading');
      this.emit('whatsapp:status', this.getPublicStatus());
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
    });

    client.on('auth_failure', async (msg) => {
      this.status = 'auth_failure';
      this.ready = false;
      this.lastError = String(msg);
      this.authFailCount += 1;
      this.clearQr('auth_failure');
      this.emit('whatsapp:status', this.getPublicStatus());
      console.error('[WhatsApp] Auth failure:', msg, `(count=${this.authFailCount})`);

      // Repeated failures → wipe corrupted LocalAuth and start clean
      if (this.authFailCount >= 2) {
        console.warn('[WhatsApp] Repeated auth failures — clearing LocalAuth and restarting');
        await sleep(1000);
        try {
          await this.resetSession({ reason: 'auth_failure auto-recovery' });
        } catch (err) {
          console.error('[WhatsApp] Auto-reset failed:', err.message);
        }
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

      // LOGOUT often means session is dead — clear auth so next QR is clean
      const reasonStr = String(reason || '').toUpperCase();
      if (reasonStr.includes('LOGOUT') || reasonStr.includes('CONFLICT')) {
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

    client.on('message', async (message) => {
      try {
        await this.handleIncomingMessage(message);
      } catch (err) {
        console.error('[WhatsApp] Message handler error:', err);
      }
    });
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
      try {
        await this.client.logout();
      } catch (_) {}
    }
    await this.destroyClient();
    this.clearSessionFiles();
    await sleep(1500);
    return this.init({ force: true });
  }

  async sendMessage(phone, body) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
    const chatId = this.toChatId(phone);
    const result = await this.client.sendMessage(chatId, body);
    MessageLog.add({ direction: 'out', phone: this.formatPhone(phone), body });
    return result;
  }

  async handleIncomingMessage(message) {
    if (message.fromMe) return;
    if (message.from.endsWith('@g.us')) return;
    if (message.isStatus) return;

    const phone = message.from.replace(/@c\.us$/, '');
    const body = (message.body || '').trim();
    if (!body) return;

    MessageLog.add({ direction: 'in', phone, body });

    const lower = body.toLowerCase();

    if (['yes', 'y', 'confirm', 'ok', 'okay'].includes(lower)) {
      const pending = Submissions.findPendingConfirmation(phone);
      if (pending) {
        await this.confirmAndForward(pending);
        return;
      }
    }

    if (['no', 'n', 'cancel'].includes(lower)) {
      const pending = Submissions.findPendingConfirmation(phone);
      if (pending) {
        Submissions.markCancelled(pending.id);
        await this.sendMessage(phone, Settings.get('cancel_message'));
        return;
      }
    }

    const flow = ChatFlow.findByKeyword(body);
    if (!flow) return;

    const existing = Submissions.findLatestOpen(phone);
    if (existing && existing.status === 'awaiting_confirmation') {
      await this.sendMessage(phone, Settings.get('already_pending_message'));
      return;
    }

    const submission =
      existing && existing.status === 'awaiting_form'
        ? existing
        : Submissions.create({ token: uuidv4(), customer_phone: phone });

    const formLink = `${this.getBaseUrl()}/form/${submission.token}`;
    const text = this.renderTemplate(flow.response_template, {
      business_name: Settings.get('business_name', 'Insurance'),
      form_link: formLink,
      phone,
    });

    await this.sendMessage(phone, text);
  }

  async sendFormConfirmation(submission) {
    const template = Settings.get('confirmation_template');
    const text = this.renderTemplate(template, {
      name: submission.customer_name,
      insurance_type: submission.insurance_type,
      company: submission.company,
      phone: submission.customer_phone,
    });
    await this.sendMessage(submission.customer_phone, text);
  }

  async confirmAndForward(submission) {
    Submissions.markConfirmed(submission.id);

    const target = InternalNumbers.resolveForType(submission.insurance_type);
    if (!target) {
      await this.sendMessage(
        submission.customer_phone,
        'Your details are confirmed, but no internal desk number is configured yet. Our admin will follow up shortly.'
      );
      return;
    }

    const forwardText = this.renderTemplate(Settings.get('forward_template'), {
      name: submission.customer_name,
      phone: submission.customer_phone,
      insurance_type: submission.insurance_type,
      company: submission.company,
      submitted_at: submission.form_submitted_at || new Date().toISOString(),
    });

    await this.sendMessage(target.phone, forwardText);
    Submissions.markForwarded(submission.id, target.phone);

    await this.sendMessage(
      submission.customer_phone,
      Settings.get('success_message')
    );
  }
}

module.exports = new WhatsAppService();
