/**
 * WhatsApp service singleton — LocalAuth, QR, anti-ban sends, chat bridge, workflow.
 */
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { Message } = require('whatsapp-web.js/src/structures');
const qrcode = require('qrcode');
const {
  Settings,
  Submissions,
  MessageLog,
  ChatSessions,
} = require('../models');
const {
  bindEngine,
  newToken,
  notifyFormSubmitted: engineNotifyForm,
} = require('./workflowEngine');
const { buildPuppeteerLaunchOptions, isRenderLike, isVpsLinux } = require('./chromiumLaunch');
const { sanitizeFormLink } = require('../utils/leadSummary');
const { buildFormUrl } = require('../config/baseUrl');
const antiBan = require('./antiBan');
const {
  createPresenceMediaHelpers,
  isMediaLikeMessage,
  buildMediaSendOptionSets,
} = require('./waPresenceMedia');

const AUTH_PATH = path.join(process.cwd(), '.wwebjs_auth');
const CACHE_PATH = path.join(process.cwd(), '.wwebjs_cache');
const CLIENT_ID = 'insurance-bot';
const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';

function sleep(ms) {
  return antiBan.sleep(ms);
}

function normalizeMsg(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

function getCloseKeywords() {
  const raw = Settings.get('close_keywords') || 'close,cls';
  return String(raw)
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** Exact keyword match — Close / CLS ends the session silently. */
function isCloseCommand(text) {
  const n = normalizeMsg(text);
  return getCloseKeywords().some((k) => n === k);
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
          timeout:
            !options.timeout || options.timeout === 0 ? 180000 : options.timeout,
        }
      : options;
    try {
      return await origGoto.call(this, url, opts);
    } catch (err) {
      if (!isWa || !isTransientBrowserError(err)) throw err;
      await sleep(1500);
      return origGoto.call(this, url, opts);
    }
  };
}

class WhatsAppService {
  constructor() {
    this.client = null;
    this.io = null;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.lastError = null;
    this.info = null;
    this.ready = false;
    this._initPromise = null;
    this._initAttempt = 0;
    this._msgQueue = Promise.resolve();
    this._msgQueueDepth = 0;
    this._seenIds = new Set();
    this._lastOutboundChatId = null;
    this._unreadPollTimer = null;
    this._lastInboundAt = 0;
    /** @type {Map<string, { timer: NodeJS.Timeout, message: any, peerKey: string, body: string, chatId: string, inboundAt: number, msgId: string }>} */
    this._pendingSmartDelay = new Map();
    /** chatKey → last manual (human) fromMe timestamp ms */
    this._manualReplyAt = new Map();
    /** chatKey → ignore fromMe as "manual" until this time (bot-initiated sends) */
    this._botOutboundIgnoreUntil = new Map();
    this._qrEncodeBusy = false;
    this._pendingQrRaw = null;
    this._lastQrEmitAt = 0;
    this._presenceMedia = null;
    this.engine = bindEngine(this);
  }

  /**
   * Encode QR without blocking the event loop; keep payload small for fast tab switches.
   */
  queueQrEncode(qrRaw) {
    this._pendingQrRaw = qrRaw;
    if (this._qrEncodeBusy) return;
    this._qrEncodeBusy = true;

    const run = async () => {
      while (this._pendingQrRaw) {
        const raw = this._pendingQrRaw;
        this._pendingQrRaw = null;
        try {
          const dataUrl = await qrcode.toDataURL(raw, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            margin: 1,
            width: 260,
            rendererOpts: { quality: 0.8 },
          });
          this.qrDataUrl = dataUrl;
          this.status = 'qr';
          this.ready = false;
          this._lastQrEmitAt = Date.now();
          this.emit('whatsapp:qr', { qr: this.qrDataUrl });
          this.emit('whatsapp:status', this.getPublicStatus());
          console.log('[WhatsApp] QR ready — scan with phone');
        } catch (err) {
          console.error('[WhatsApp] QR encode failed:', err.message);
        }
        await new Promise((r) => setImmediate(r));
      }
    };

    setImmediate(() => {
      run()
        .catch((err) => console.error('[WhatsApp] QR queue error:', err.message))
        .finally(() => {
          this._qrEncodeBusy = false;
          if (this._pendingQrRaw) this.queueQrEncode(this._pendingQrRaw);
        });
    });
  }

  get pm() {
    if (!this._presenceMedia) {
      this._presenceMedia = createPresenceMediaHelpers(this);
    }
    return this._presenceMedia;
  }

  attachSocket(io) {
    this.io = io;
    io.on('connection', (socket) => {
      socket.emit('whatsapp:status', this.getPublicStatus());
      if (this.qrDataUrl) {
        socket.emit('whatsapp:qr', { qr: this.qrDataUrl });
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
      qr: !!this.qrDataUrl,
      info: this.info,
      lastError: this.lastError,
      platform: process.platform,
      renderLike: isRenderLike(),
      vpsLinux: isVpsLinux(),
    };
  }

  clearQr(reason) {
    this.qrDataUrl = null;
    if (reason) console.log(`[WhatsApp] QR cleared (${reason})`);
  }

  formatPhone(phone) {
    // Strip JID server suffix before digit extraction
    return String(phone || '')
      .replace(/@.+$/, '')
      .replace(/^whatsapp:/i, '')
      .replace(/\D/g, '');
  }

  /**
   * True when a digit string looks like a real mobile MSISDN (not a WhatsApp @lid id).
   */
  looksLikeMsisdn(digits) {
    const d = String(digits || '');
    if (!d) return false;
    // Typical WA phones: 10–15 digits. LID internals are often longer/opaque.
    if (d.length < 10 || d.length > 15) return false;
    // Reject obvious LID-only lengths that aren't country+national (keep 10–15)
    return true;
  }

  /**
   * Resolve a stable digit phone + chat id for inbound messages (@c.us and @lid).
   * Never treats @lid user-ids as phone numbers.
   */
  async resolveIncomingPeer(message) {
    const chatId = message.from || message.author || null;
    const lidUser =
      String(chatId || '').endsWith('@lid')
        ? String(chatId).replace(/@.+$/, '').replace(/\D/g, '')
        : '';

    const consider = (raw) => {
      if (raw == null) return null;
      const s = String(raw).trim();
      // Never trust @lid / @broadcast as the phone itself
      if (/@(lid|broadcast|g\.us)\b/i.test(s)) return null;
      const d = this.formatPhone(s);
      if (!this.looksLikeMsisdn(d)) return null;
      // Reject when digits are exactly the opaque LID user id
      if (lidUser && d === lidUser) return null;
      return d;
    };

    let phone = null;
    const trySet = (val, source) => {
      const d = consider(val);
      if (d && !phone) {
        phone = d;
        console.log(`[WhatsApp] Peer phone via ${source}: ${d}`);
      }
      return !!d;
    };

    // 1) Classic @c.us JID
    if (String(chatId || '').endsWith('@c.us')) {
      trySet(chatId, 'from@c.us');
    }

    // 2) Message payload fields (often still hold PN on LID chats)
    const data = message._data || {};
    trySet(data.from, '_data.from');
    trySet(data.author, '_data.author');
    trySet(data.peerRecipientJid || data.peerJid || data.remoteJid, '_data.peer');
    trySet(data.notify, '_data.notify'); // usually name, ignore if non-numeric

    // 3) Contact model
    if (!phone) {
      try {
        const contact = await message.getContact();
        trySet(contact?.number, 'contact.number');
        trySet(contact?.id?._serialized, 'contact.id');
        trySet(contact?.id?.user, 'contact.user');
        // Some builds expose phoneNumber / formattedNumber
        trySet(contact?.phoneNumber, 'contact.phoneNumber');
        trySet(contact?.formattedNumber, 'contact.formattedNumber');
      } catch (err) {
        console.warn('[WhatsApp] getContact failed:', err.message);
      }
    }

    // 4) Chat model
    if (!phone) {
      try {
        const chat = await message.getChat();
        trySet(chat?.id?._serialized, 'chat.id');
        trySet(chat?.id?.user, 'chat.user');
      } catch (_) {}
    }

    // 5) LID → phone via whatsapp-web.js official helper (then Store fallback)
    if (!phone && String(chatId || '').endsWith('@lid') && this.client) {
      try {
        if (typeof this.client.getContactLidAndPhone === 'function') {
          const mapped = await this.client.getContactLidAndPhone([chatId]);
          const entry = Array.isArray(mapped) ? mapped[0] : mapped;
          const pn = entry?.pn || entry?.phone || null;
          if (trySet(pn, 'getContactLidAndPhone')) {
            // done
          }
        }
      } catch (err) {
        console.warn('[WhatsApp] getContactLidAndPhone failed:', err.message);
      }
    }

    if (!phone && String(chatId || '').endsWith('@lid') && this.client?.pupPage) {
      try {
        const resolved = await this.client.pupPage.evaluate(async (lidJid) => {
          const out = { phone: null, via: null };
          try {
            // Library helper injected into page
            if (window.WWebJS?.enforceLidAndPnRetrieval) {
              const { phone } = await window.WWebJS.enforceLidAndPnRetrieval(lidJid);
              const serialized =
                phone?._serialized || phone?.user || (typeof phone === 'string' ? phone : null);
              if (serialized) {
                out.phone = String(serialized).replace(/@.+$/, '').replace(/\D/g, '');
                out.via = 'enforceLidAndPnRetrieval';
                return out;
              }
            }

            const widFactory = window.Store?.WidFactory || window.require?.('WAWebWidFactory');
            const wid =
              typeof widFactory?.createWid === 'function'
                ? widFactory.createWid(lidJid)
                : lidJid;

            const Contact =
              window.Store?.Contact ||
              window.require?.('WAWebCollections')?.Contact;
            let contact =
              Contact?.get?.(lidJid) ||
              Contact?.get?.(wid) ||
              null;
            if (!contact && Contact?.find) {
              try {
                contact = await Contact.find(wid);
              } catch (_) {}
            }
            if (contact) {
              const alt =
                contact.phoneNumber?._serialized ||
                contact.phoneNumber?.user ||
                contact.number ||
                null;
              const candidate = String(alt || '')
                .replace(/@.+$/, '')
                .replace(/\D/g, '');
              if (candidate && candidate.length >= 10 && candidate.length <= 15) {
                out.phone = candidate;
                out.via = 'Contact.phoneNumber';
                return out;
              }
            }
          } catch (e) {
            out.via = 'error:' + (e?.message || e);
          }
          return out;
        }, chatId);

        if (resolved?.phone && this.looksLikeMsisdn(resolved.phone)) {
          phone = resolved.phone;
          console.log(
            `[WhatsApp] Peer phone via Store/${resolved.via}: ${phone} (from ${chatId})`
          );
        } else {
          console.warn(
            `[WhatsApp] Could not map LID ${chatId} → phone (${resolved?.via || 'n/a'})`
          );
        }
      } catch (err) {
        console.warn('[WhatsApp] LID→PN resolve failed:', err.message);
      }
    }

    // 6) Last resort: only if from looks like @c.us-style digits (never @lid)
    if (!phone) trySet(chatId, 'fallback');

    // Canonicalize Indian 10-digit → 91…
    if (phone && phone.length === 10) phone = `91${phone}`;

    return { phone: phone || '', chatId };
  }

  getBaseUrl() {
    const { getBaseUrl } = require('../config/baseUrl');
    return getBaseUrl();
  }

  buildFormUrl(token) {
    return sanitizeFormLink(buildFormUrl(token));
  }

  async resolveOutboundChatId(phoneOrId) {
    const raw = String(phoneOrId || '').trim();
    if (!raw) throw new Error('Empty phone/chat id');
    if (raw.includes('@')) return raw;

    const digits = this.formatPhone(raw);
    if (!digits) throw new Error('Invalid phone');

    if (this.client?.getNumberId) {
      try {
        const numberId = await this.client.getNumberId(digits);
        if (numberId?._serialized) return numberId._serialized;
        if (numberId?.user) return `${numberId.user}@${numberId.server || 'c.us'}`;
      } catch (_) {}
    }

    return `${digits}@c.us`;
  }

  stopUnreadPoller() {
    if (this._unreadPollTimer) {
      clearInterval(this._unreadPollTimer);
      this._unreadPollTimer = null;
    }
  }

  async destroyClient() {
    this.stopUnreadPoller();
    const client = this.client;
    this.client = null;
    this.ready = false;
    if (!client) return;
    try {
      await client.destroy();
    } catch (err) {
      console.warn('[WhatsApp] destroy:', err.message);
    }
  }

  clearSessionFiles() {
    for (const dir of [AUTH_PATH, CACHE_PATH]) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[WhatsApp] Cleared ${dir}`);
        }
      } catch (err) {
        console.warn('[WhatsApp] clearSessionFiles:', err.message);
      }
    }
  }

  async init({ force = false } = {}) {
    if (this._initPromise && !force) return this._initPromise;
    this._initPromise = this._doInit();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInit() {
    this._initAttempt += 1;
    await this.destroyClient();
    this.status = 'initializing';
    this.lastError = null;
    this.clearQr('reinit');
    this.emit('whatsapp:status', this.getPublicStatus());

    patchPuppeteerPageHelpers();

    const launchOpts = await buildPuppeteerLaunchOptions();
    console.log(
      `[WhatsApp] Launching browser via puppeteer-core` +
        ` headless=${launchOpts.headless} executablePath=${launchOpts.executablePath}` +
        ` (attempt ${this._initAttempt})` +
        (isRenderLike() ? ' [Render/serverless]' : isVpsLinux() ? ' [VPS Linux]' : '')
    );

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: CLIENT_ID,
        dataPath: AUTH_PATH,
      }),
      puppeteer: launchOpts,
      webVersionCache: {
        type: process.env.WA_WEB_VERSION_CACHE || 'local',
      },
      authTimeoutMs: Number(process.env.WA_AUTH_TIMEOUT_MS) || 600000,
      qrMaxRetries: Number(process.env.WA_QR_MAX_RETRIES) || 20,
      takeoverOnConflict: true,
      takeoverTimeoutMs: Number(process.env.WA_TAKEOVER_TIMEOUT_MS) || 120000,
    });

    this.client = client;
    this._bindClientEvents(client);

    try {
      await client.initialize();
    } catch (err) {
      this.lastError = err.message;
      this.status = 'error';
      this.emit('whatsapp:status', this.getPublicStatus());
      console.error('[WhatsApp] initialize failed:', err.message);
      if (isTransientBrowserError(err) && this._initAttempt < 3) {
        await sleep(4000);
        return this.init({ force: true });
      }
      throw err;
    }
  }

  _bindClientEvents(client) {
    client.on('qr', (qr) => {
      // Encode off the critical path; coalesce rapid QR refreshes
      this.queueQrEncode(qr);
    });

    client.on('authenticated', () => {
      this.status = 'authenticated';
      this.clearQr('authenticated');
      this.emit('whatsapp:status', this.getPublicStatus());
      console.log('[WhatsApp] Authenticated');
    });

    client.on('ready', async () => {
      this.status = 'ready';
      this.ready = true;
      this.clearQr('ready');
      try {
        const wid = client.info?.wid;
        this.info = {
          pushname: client.info?.pushname || null,
          wid: wid?._serialized || wid?.user || null,
        };
      } catch (_) {
        this.info = null;
      }
      this.emit('whatsapp:status', this.getPublicStatus());
      console.log('[WhatsApp] Ready', this.info?.wid || '');
      try {
        const { AccessGate } = require('../models');
        console.log(
          `[WhatsApp] Common access code: ${AccessGate.getCommonCode() || '(not set)'}`
        );
      } catch (_) {}
      console.log(
        '[WhatsApp] Inbound listeners active: message, message_create, message_ciphertext (+ unread poller)'
      );
      this.startUnreadPoller();
    });

    client.on('auth_failure', (msg) => {
      this.status = 'auth_failure';
      this.ready = false;
      this.lastError = String(msg || 'auth_failure');
      this.emit('whatsapp:status', this.getPublicStatus());
      console.error('[WhatsApp] Auth failure:', msg);
    });

    client.on('disconnected', async (reason) => {
      this.stopUnreadPoller();
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
      try {
        await this.init({ force: true });
      } catch (err) {
        console.error('[WhatsApp] Reconnect failed:', err.message);
      }
    });

    // Primary inbound path (decrypted messages from others)
    client.on('message', (message) => {
      this.onClientMessageEvent('message', message);
    });

    // Fires for own + others; needed when `message` is flaky on newer WA Web
    client.on('message_create', (message) => {
      this.onClientMessageEvent('message_create', message);
    });

    // Ciphertext arrives first; `message` only fires after decrypt (often never)
    client.on('message_ciphertext', (message) => {
      this.onClientMessageEvent('message_ciphertext', message);
      this.watchCiphertextMessage(message);
    });

    client.on('message_ciphertext_failed', (message) => {
      console.warn(
        `[WhatsApp] Ciphertext decrypt FAILED from=${message?.from || '?'} type=${message?.type || '?'}`
      );
    });
  }

  /**
   * Shared entry for WA Web message events — always logs so terminal proves listener is alive.
   */
  onClientMessageEvent(source, message) {
    if (!message) return;
    const from = message.from || message.author || '?';
    const msgType = String(message.type || 'unknown').toLowerCase();
    const bodyPreview = String(message.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const mediaHint = isMediaLikeMessage(message)
      ? ` media=yes hasMediaFlag=${!!message.hasMedia}`
      : '';
    console.log(
      `Received message [${source}]: "${bodyPreview || `[${msgType}]`}" from: ${from}` +
        (message.fromMe ? ' (fromMe)' : '') +
        mediaHint
    );

    if (source === 'message_ciphertext') return; // wait for decrypt / poller

    // Track our own sends so the smart-delay window can detect manual replies
    if (message.fromMe) {
      this.notePossibleManualReply(message);
      return;
    }

    this._lastInboundAt = Date.now();
    this.enqueueIncomingMessage(message);
  }

  chatKeyFromMessage(message) {
    if (!message) return '';
    if (message.fromMe) {
      return String(message.to || message.from || '').trim();
    }
    return String(message.from || message.author || '').trim();
  }

  notePossibleManualReply(message) {
    const chatKey = this.chatKeyFromMessage(message);
    if (!chatKey) return;

    const altKeys = [
      chatKey,
      message.to,
      message.from,
      message.author,
      message.id?.remote,
    ]
      .map((k) => String(k || '').trim())
      .filter(Boolean);

    const now = Date.now();
    for (const key of altKeys) {
      const ignoreUntil = this._botOutboundIgnoreUntil.get(key) || 0;
      if (now < ignoreUntil) {
        // Likely our own automated send — not a manual takeover
        return;
      }
    }

    const at = now;
    for (const key of altKeys) this._manualReplyAt.set(key, at);
    console.log(
      `[WhatsApp] Manual/outbound fromMe noted in ${chatKey} — pending smart delays will stay silent if still waiting`
    );

    // If a smart delay is pending for this chat, cancel it immediately (human took over)
    for (const key of altKeys) {
      const pending = this._pendingSmartDelay.get(key);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        this._pendingSmartDelay.delete(key);
        console.log(
          `[WhatsApp] Smart delay cancelled for ${key} — manual reply detected`
        );
      }
    }
  }

  markBotOutbound(chatIdOrIds, ttlMs = 8000) {
    const until = Date.now() + ttlMs;
    const list = Array.isArray(chatIdOrIds) ? chatIdOrIds : [chatIdOrIds];
    for (const raw of list) {
      const key = String(raw || '').trim();
      if (!key) continue;
      this._botOutboundIgnoreUntil.set(key, until);
    }
  }

  getSmartDelayMs() {
    const fromEnv = Number(process.env.WA_SMART_DELAY_MS);
    if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
    try {
      const raw = Settings.get('smart_reply_delay_ms');
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    } catch (_) {}
    return 10000;
  }

  /**
   * Wait before access-code / form flow.
   * Exact common access code always proceeds (never aborted as "manual reply")
   * so every phone/LID can unlock universally.
   */
  scheduleSmartAccessDelay({ message, peerKey, body, chatId, msgId }) {
    const key = String(chatId || peerKey || '').trim();
    if (!key) {
      console.warn('[WhatsApp] Smart delay skipped — no chat key');
      return;
    }

    let isAccessCode = false;
    try {
      const { AccessGate } = require('../models');
      isAccessCode = !!AccessGate.tryUnlock(peerKey || key, body).ok;
    } catch (_) {}

    const delayMs = isAccessCode
      ? Math.min(this.getSmartDelayMs(), Number(process.env.WA_ACCESS_CODE_DELAY_MS) || 2500)
      : this.getSmartDelayMs();

    const existing = this._pendingSmartDelay.get(key);
    if (existing?.timer) clearTimeout(existing.timer);

    const inboundAt = Date.now();
    console.log(
      `[WhatsApp] Smart delay ${delayMs}ms for ${key}` +
        (isAccessCode ? ' [access-code — will not abort for manual-reply false positives]' : '') +
        ' — will check before access-code flow'
    );

    const payload = {
      message,
      peerKey,
      body,
      chatId: key,
      inboundAt,
      msgId,
      forceAccessCode: isAccessCode,
    };

    if (delayMs <= 0) {
      this.runAccessWorkflowAfterDelay(payload).catch((err) => {
        console.error('[WhatsApp] Smart delay process error:', err.message);
      });
      return;
    }

    const timer = setTimeout(() => {
      this._pendingSmartDelay.delete(key);
      this.runAccessWorkflowAfterDelay(payload).catch((err) => {
        console.error('[WhatsApp] Smart delay process error:', err.message);
      });
    }, delayMs);

    this._pendingSmartDelay.set(key, { timer, ...payload });
  }

  async hadManualReplySince(chatId, sinceMs) {
    const key = String(chatId || '').trim();
    if (!key) return false;

    const noted = this._manualReplyAt.get(key);
    if (noted && noted >= sinceMs) return true;

    try {
      if (!this.client) return false;
      const chat = await this.client.getChatById(key);
      if (!chat?.fetchMessages) return false;
      const recent = await chat.fetchMessages({ limit: 15 });
      const ignoreUntil = this._botOutboundIgnoreUntil.get(key) || 0;

      for (const m of recent) {
        if (!m?.fromMe) continue;
        const msgAt = Number(m.timestamp || 0) * 1000;
        if (!msgAt || msgAt < sinceMs - 500) continue;
        // Skip bot-initiated sends (ignore window covers from send time → send+ttl)
        if (ignoreUntil && msgAt <= ignoreUntil) continue;
        return true;
      }
    } catch (err) {
      console.warn('[WhatsApp] Manual-reply history check failed:', err.message);
    }
    return false;
  }

  async runAccessWorkflowAfterDelay({
    message,
    peerKey,
    body,
    chatId,
    inboundAt,
    forceAccessCode = false,
  }) {
    const key = String(chatId || peerKey || '').trim();
    console.log(`[WhatsApp] Smart delay elapsed for ${key} — checking manual replies…`);

    // Exact common access code must never be swallowed by manual-reply heuristics
    let isAccessCode = forceAccessCode;
    if (!isAccessCode) {
      try {
        const { AccessGate } = require('../models');
        isAccessCode = !!AccessGate.tryUnlock(peerKey || key, body).ok;
      } catch (_) {}
    }

    if (!isAccessCode) {
      const manual = await this.hadManualReplySince(key, inboundAt);
      if (manual) {
        console.log(
          `[WhatsApp] Manual reply detected in ${key} within smart-delay window — staying silent`
        );
        return { handled: true, reason: 'manual_reply_silent', silent: true };
      }

      const noted = this._manualReplyAt.get(key);
      if (noted && noted >= inboundAt) {
        console.log(`[WhatsApp] Manual reply map hit for ${key} — staying silent`);
        return { handled: true, reason: 'manual_reply_silent', silent: true };
      }
    } else {
      console.log(
        `[WhatsApp] Access code confirmed for ${key} — running unlock for any peer (no phone whitelist)`
      );
    }

    console.log(
      `[WhatsApp] Running access-code workflow for peer=${peerKey || '?'} chat=${key}`
    );

    try {
      const result = await this.engine.handleIncomingMessage({
        phone: peerKey,
        body,
        chatId: key || message.from,
        replyTo: message,
      });
      console.log(
        `[WhatsApp] Workflow result:`,
        result?.reason || result?.status || result?.handled || result
      );
      return result;
    } catch (err) {
      console.error('[Workflow] handleIncomingMessage:', err.message);
      console.error(err.stack);
      return { handled: false, error: err.message };
    }
  }

  /**
   * When WA delivers ciphertext, nudge decrypt then pull the plaintext message.
   */
  watchCiphertextMessage(message) {
    const run = async () => {
      const chatId = message.from;
      const origId =
        message.id?._serialized || message.id?.id || null;
      console.log(
        `[WhatsApp] Watching ciphertext decrypt chat=${chatId} id=${origId || '?'}`
      );

      try {
        const chat = await message.getChat();
        if (chat?.sendSeen) await chat.sendSeen().catch(() => {});
      } catch (_) {}

      for (let attempt = 1; attempt <= 20; attempt++) {
        await sleep(attempt <= 5 ? 800 : 1500);
        if (!this.client || !this.ready) return;

        try {
          // Prefer reloading the same Store model if id is known
          if (origId && this.client.pupPage) {
            const model = await this.client.pupPage.evaluate((serialized) => {
              try {
                const collections = window.require?.('WAWebCollections');
                const msg =
                  collections?.Msg?.get?.(serialized) ||
                  window.Store?.Msg?.get?.(serialized);
                if (!msg) return null;
                if (msg.type === 'ciphertext') return { type: 'ciphertext' };
                return window.WWebJS.getMessageModel(msg);
              } catch (e) {
                return { error: String(e?.message || e) };
              }
            }, origId);

            if (model && model.type && model.type !== 'ciphertext' && !model.error) {
              const decrypted = new Message(this.client, model);
              console.log(
                `[WhatsApp] Ciphertext decrypted (attempt ${attempt}): type=${model.type}`
              );
              this.enqueueIncomingMessage(decrypted);
              return;
            }
          }

          const chat = await this.client.getChatById(chatId).catch(() => null);
          if (!chat) continue;
          const recent = await chat.fetchMessages({ limit: 8 });
          for (const m of recent) {
            if (m.fromMe) continue;
            if (String(m.type || '') === 'ciphertext') continue;
            const mid = m.id?._serialized || m.id?.id;
            if (mid && this._seenIds.has(mid)) continue;
            if (origId && mid && mid !== origId) {
              // Still accept recent plaintext in this chat while waiting
              if ((m.timestamp || 0) + 5 < (message.timestamp || 0)) continue;
            }
            console.log(
              `[WhatsApp] Ciphertext recovered via fetchMessages (attempt ${attempt})`
            );
            this.enqueueIncomingMessage(m);
            return;
          }
        } catch (err) {
          if (attempt === 1 || attempt % 5 === 0) {
            console.warn(
              `[WhatsApp] Ciphertext watch attempt ${attempt}:`,
              err.message
            );
          }
        }
      }
      console.warn(
        `[WhatsApp] Ciphertext never decrypted for ${chatId} — unread poller may still catch it`
      );
    };

    run().catch((err) => {
      console.error('[WhatsApp] watchCiphertextMessage:', err.message);
    });
  }

  /**
   * Fallback when WA Web silently drops Msg.add events (common on 2.3000.x).
   * Polls unread private chats and feeds unseen messages into the same handler.
   */
  startUnreadPoller() {
    this.stopUnreadPoller();
    const intervalMs = Number(process.env.WA_UNREAD_POLL_MS);
    const ms = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 5000;
    if (ms === 0) {
      console.log('[WhatsApp] Unread poller disabled (WA_UNREAD_POLL_MS=0)');
      return;
    }

    console.log(`[WhatsApp] Unread poller every ${ms}ms`);
    this._unreadPollTimer = setInterval(() => {
      this.pollUnreadChats().catch((err) => {
        console.warn('[WhatsApp] Unread poll error:', err.message);
      });
    }, ms);
    // Kick once shortly after ready
    setTimeout(() => {
      this.pollUnreadChats().catch(() => {});
    }, 2500);
  }

  async pollUnreadChats() {
    if (!this.ready || !this.client) return;
    let chats;
    try {
      chats = await this.client.getChats();
    } catch (_) {
      return;
    }

    const candidates = (chats || []).filter(
      (c) =>
        c &&
        !c.isGroup &&
        Number(c.unreadCount || 0) > 0 &&
        c.id?._serialized !== 'status@broadcast'
    );

    if (!candidates.length) return;

    console.log(
      `[WhatsApp] Unread poll: ${candidates.length} chat(s) with unread`
    );

    for (const chat of candidates.slice(0, 12)) {
      try {
        const limit = Math.min(Math.max(Number(chat.unreadCount) || 1, 1), 15);
        const msgs = await chat.fetchMessages({ limit });
        let fed = 0;
        for (const m of msgs) {
          if (!m || m.fromMe) continue;
          if (String(m.type || '') === 'ciphertext') continue;
          const mid = m.id?._serialized || m.id?.id;
          if (mid && this._seenIds.has(mid)) continue;
          console.log(
            `Received message [unread_poll]: "${String(m.body || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120) || `[${m.type}]`}" from: ${m.from}`
          );
          this.enqueueIncomingMessage(m);
          fed += 1;
        }
        if (fed > 0) {
          this._lastInboundAt = Date.now();
          try {
            await chat.sendSeen();
          } catch (_) {}
        }
      } catch (err) {
        console.warn(
          `[WhatsApp] Unread poll chat ${chat?.id?._serialized || '?'}:`,
          err.message
        );
      }
    }
  }

  async destroy() {
    await this.destroyClient();
    this.status = 'disconnected';
    this.ready = false;
    this.emit('whatsapp:status', this.getPublicStatus());
  }

  enqueueIncomingMessage(message) {
    const maxDepth = Number(process.env.WA_MSG_QUEUE_MAX) || 40;
    if (this._msgQueueDepth >= maxDepth) {
      console.warn(
        `[WhatsApp] Inbound queue full — dropping message type=${message?.type || '?'} media=${isMediaLikeMessage(message)} from=${message?.from || '?'}`
      );
      return;
    }
    this._msgQueueDepth += 1;
    this._msgQueue = this._msgQueue
      .then(async () => {
        const yieldMs = Number(process.env.WA_MSG_YIELD_MS) || 40;
        if (yieldMs > 0) await sleep(yieldMs);
        await this.handleIncomingMessage(message);
      })
      .catch((err) => {
        console.error('[WhatsApp] Inbound handler error:', err.message);
        console.error(err.stack);
      })
      .finally(() => {
        this._msgQueueDepth = Math.max(0, this._msgQueueDepth - 1);
      });
  }

  normalizeIncomingMessageIds(message) {
    try {
      if (message?.id && !message.id._serialized && message.id.id) {
        message.id._serialized = String(message.id.id);
      }
    } catch (_) {}
  }

  async handleIncomingMessage(message) {
    if (!message) return;
    this.normalizeIncomingMessageIds(message);

    const msgId =
      message.id?._serialized || message.id?.id || `${message.from}:${message.timestamp}`;
    if (msgId && this._seenIds.has(msgId)) return;
    if (msgId) {
      this._seenIds.add(msgId);
      if (this._seenIds.size > 2000) {
        const drop = [...this._seenIds].slice(0, 500);
        drop.forEach((id) => this._seenIds.delete(id));
      }
    }

    if (message.fromMe) return;
    if (message.from?.endsWith('@g.us')) return;
    if (message.from === 'status@broadcast') return;

    // Wait for ciphertext decrypt — never treat encrypted stubs as empty text
    if (String(message.type || '').toLowerCase() === 'ciphertext') {
      console.log(
        `[WhatsApp] Skipping ciphertext stub from=${message.from} — waiting for decrypt`
      );
      this.watchCiphertextMessage(message);
      return;
    }

    const body = String(message.body || '').trim();
    console.log(
      `[WhatsApp] Processing inbound type=${message.type || '?'} from=${message.from} hasMedia=${!!message.hasMedia} mediaLike=${isMediaLikeMessage(message)} body="${body.slice(0, 80)}"`
    );

    const { phone, chatId } = await this.resolveIncomingPeer(message);

    // Stable peer key for DB rows when MSISDN can't be resolved (@lid)
    const peerKey =
      phone ||
      this.formatPhone(chatId) ||
      String(chatId || '')
        .replace(/@.+$/, '')
        .replace(/\D/g, '') ||
      String(chatId || 'unknown');

    try {
      MessageLog.add({
        direction: 'in',
        phone: peerKey || chatId,
        body: body || `[${message.type}]`,
        meta: {
          type: message.type,
          chatId,
          hasMedia: !!message.hasMedia,
          id: msgId,
          phoneResolved: !!phone,
        },
      });
    } catch (_) {}

    // 1) Exact common access code → always start form flow for THIS chat
    //    (never blocked by another user's bridge / waiter / whitelist leftovers)
    let isAccessCode = false;
    try {
      const { AccessGate } = require('../models');
      isAccessCode = !!AccessGate.tryUnlock(phone || peerKey, body).ok;
    } catch (_) {}

    if (isAccessCode) {
      console.log(
        `[WhatsApp] Common access code from peer=${peerKey} chatId=${chatId || '—'} — universal unlock (any number)`
      );
      this.scheduleSmartAccessDelay({
        message,
        peerKey,
        body,
        chatId: chatId || message.from,
        msgId,
      });
      return;
    }

    // 2) Active two-way bridge (non-code messages only)
    const mediaLike = isMediaLikeMessage(message);
    try {
      const bridged = await this.handleChatBridge(
        message,
        phone || peerKey,
        chatId,
        body
      );
      if (bridged) return;

      if (mediaLike) {
        console.error(
          `[ChatBridge] MEDIA DROPPED — no active bridge session type=${message.type || '?'} from=${message.from} phone=${phone || peerKey} chatId=${chatId || '—'}`
        );
        // Keep id seen to avoid spam, but log clearly — media cannot relay without a session
      }
    } catch (err) {
      console.error('[ChatBridge] handler error:', err.message);
      console.error(err.stack);
      if (mediaLike && msgId && this._seenIds.has(msgId)) {
        this._seenIds.delete(msgId);
        console.warn(
          `[ChatBridge] Un-saw ${msgId} after bridge error so media can retry`
        );
      }
      // Do not fall through to silent smart-delay for media failures
      if (mediaLike) return;
    }

    if (!chatId && !phone) {
      console.warn('[WhatsApp] No chatId/phone on inbound — cannot reply');
      return;
    }

    if (!phone) {
      console.warn(
        `[WhatsApp] MSISDN unresolved (likely @lid) — continuing with chatId=${chatId} peerKey=${peerKey}`
      );
    }

    // 3) Non-code chatter → smart delay then silent ignore (unless waiter resumes)
    this.scheduleSmartAccessDelay({
      message,
      peerKey,
      body,
      chatId: chatId || message.from,
      msgId,
    });
  }

  /**
   * Two-way live relay. Close/CLS from either side → silent session end.
   */
  async handleChatBridge(message, phone, chatId, body) {
    const digits = this.formatPhone(phone);
    const msgType = String(message.type || '').toLowerCase();
    // Never drop image/pdf/document — detect beyond fragile hasMedia/directPath
    const hasMedia = isMediaLikeMessage(message);

    // ── Customer side (phone match OR stored WhatsApp chat id / @lid) ──
    let customerSession =
      (digits && ChatSessions.findActiveByCustomer(digits)) ||
      (chatId && ChatSessions.findActiveByCustomerChatId(chatId)) ||
      null;

    if (customerSession) {
      // Close only on plain text keywords — never treat media captions as close
      if (!hasMedia && body && isCloseCommand(body)) {
        await this.closeChatSession(customerSession, {
          closedBy: 'customer',
          silent: true,
        });
        return true;
      }

      ChatSessions.touch(customerSession.id, {
        customer_chat_id: chatId,
        side: 'customer',
      });
      console.log(
        `[ChatBridge] Customer→Desk session #${customerSession.id}[${customerSession.session_code}] media=${hasMedia} type=${msgType || 'text'} hasMediaFlag=${!!message.hasMedia}`
      );
      await this.relayMessageAcrossBridge(
        message,
        customerSession,
        'customer_to_desk',
        body,
        hasMedia
      );
      return true;
    }

    // ── Desk side ──
    const deskCandidates =
      (digits && ChatSessions.listActiveByDesk(digits)) || [];
    const deskByChat =
      chatId && ChatSessions.findActiveByDeskChatId
        ? ChatSessions.findActiveByDeskChatId(chatId)
        : null;

    if (
      !deskCandidates.length &&
      !deskByChat &&
      !(digits && ChatSessions.isDeskPhone(digits))
    ) {
      return false;
    }

    let quotedWaId = null;
    try {
      if (message.hasQuotedMsg) {
        const quoted = await message.getQuotedMessage();
        quotedWaId =
          quoted?.id?._serialized || quoted?.id?.id || null;
      }
    } catch (err) {
      console.warn('[ChatBridge] getQuotedMessage failed:', err.message);
    }

    const resolved = ChatSessions.resolveDeskInbound(digits || phone, {
      quotedWaId,
      body,
      chatId,
    });
    // resolveDeskInbound returns { session, method } — unwrap carefully
    const deskSession = resolved?.session || null;
    if (!deskSession?.id) {
      if (deskByChat?.id) {
        // Fall back to desk chat id match
        return this._relayDeskSession(message, deskByChat, chatId, body, hasMedia);
      }
      console.warn(
        `[ChatBridge] Desk inbound unmatched phone=${digits || '?'} chatId=${chatId || '?'} method=${resolved?.method || 'none'}`
      );
      return false;
    }

    console.log(
      `[ChatBridge] Desk→Customer session #${deskSession.id}[${deskSession.session_code}] via ${resolved.method || 'resolve'}`
    );
    return this._relayDeskSession(message, deskSession, chatId, body, hasMedia);
  }

  async _relayDeskSession(message, deskSession, chatId, body, hasMedia) {
    const media = !!(hasMedia || isMediaLikeMessage(message));

    if (!media && body && isCloseCommand(body)) {
      await this.closeChatSession(deskSession, {
        closedBy: 'desk',
        silent: true,
      });
      return true;
    }

    ChatSessions.touch(deskSession.id, {
      desk_chat_id: chatId,
      side: 'desk',
    });
    console.log(
      `[ChatBridge] Desk→Customer session #${deskSession.id}[${deskSession.session_code}] media=${!!media} type=${message?.type || 'text'} hasMediaFlag=${!!message?.hasMedia} bodyLen=${String(body || '').length}`
    );
    await this.relayMessageAcrossBridge(
      message,
      deskSession,
      'desk_to_customer',
      body,
      media
    );
    return true;
  }

  /**
   * Close bridge. Desk gets a red status dot only — no long text notices.
   */
  async closeChatSession(session, { closedBy = 'system', silent = true } = {}) {
    if (!session?.id) return;
    try {
      ChatSessions.close(session.id);
      console.log(
        `[ChatBridge] Session #${session.id}[${session.session_code}] closed by ${closedBy}` +
          (silent ? ' (customer silent)' : '')
      );
    } catch (err) {
      console.error('[ChatBridge] close failed:', err.message);
      return;
    }

    // Company status: red dot only
    try {
      await this.sendMessage(session.desk_phone, '🔴', {
        chatId: session.desk_chat_id || undefined,
        skipTyping: true,
        skipPacing: true,
        skipLimiter: true,
        skipCaps: true,
      });
    } catch (err) {
      console.warn('[ChatBridge] Red-dot status failed:', err.message);
    }
  }

  async resolveBridgeDestChatIds(destPhone, preferredChatId = null) {
    const candidates = [];
    const push = (id) => {
      const s = String(id || '').trim();
      if (s && !candidates.includes(s)) candidates.push(s);
    };

    // Prefer stored chat id (@lid or @c.us) — critical for desk→customer media
    push(preferredChatId);
    if (preferredChatId) {
      const user = String(preferredChatId).replace(/@.+$/, '');
      if (user) {
        if (String(preferredChatId).endsWith('@lid')) {
          push(`${user}@lid`);
        } else {
          push(`${user}@c.us`);
          push(`${user}@lid`);
        }
      }
    }

    const digits = this.formatPhone(destPhone);
    if (digits) {
      push(`${digits}@c.us`);
      try {
        const resolved = await this.resolveOutboundChatId(digits);
        push(resolved);
      } catch (err) {
        console.warn(
          `[ChatBridge] resolveOutboundChatId(${digits}):`,
          err.message
        );
      }
    }

    console.log(
      `[ChatBridge] dest candidates phone=${digits || destPhone || '—'} → ${candidates.join(' | ') || '(none)'}`
    );
    return candidates;
  }

  /**
   * Download inbound media as MessageMedia (images, PDFs, docs, audio, video, stickers).
   */
  async prepareRelayMedia(message) {
    return this.pm.prepareRelayMedia(message);
  }

  async relayMessageAcrossBridge(message, session, direction, body, hasMediaFlag = null) {
    try {
      this.normalizeIncomingMessageIds(message);

      const toCustomer = direction === 'desk_to_customer';
      const destPhone = toCustomer ? session.customer_phone : session.desk_phone;
      const preferredChatId = toCustomer
        ? session.customer_chat_id
        : session.desk_chat_id;
      const msgType = String(message.type || '').toLowerCase();
      const hasMedia =
        hasMediaFlag != null ? !!hasMediaFlag : isMediaLikeMessage(message);

      const destCandidates = await this.resolveBridgeDestChatIds(
        destPhone,
        preferredChatId
      );
      if (!destCandidates.length) {
        console.error(
          `[ChatBridge] No dest chat ids for ${direction} phone=${destPhone} preferred=${preferredChatId || '—'}`
        );
        return;
      }

      const destChatId = preferredChatId || destCandidates[0];
      const waId = message.id?._serialized || message.id?.id || null;
      if (waId) {
        try {
          ChatSessions.trackMessage(
            session.id,
            direction,
            String(waId),
            body || `[${msgType || 'msg'}]`
          );
        } catch (err) {
          console.warn('[ChatBridge] trackMessage:', err.message);
        }
      }

      const cleanBody = antiBan.cleanRelayText(body);
      console.log(
        `[ChatBridge] ${direction} media=${hasMedia} type=${msgType || 'text'} dest=${destChatId} candidates=${destCandidates.length} captionLen=${String(cleanBody || '').length}`
      );

      const bindDest = (bound) => {
        const id = bound || destChatId;
        if (!id) return;
        try {
          if (toCustomer) ChatSessions.bindCustomerChatId(session.id, id);
          else ChatSessions.bindDeskChatId(session.id, id);
        } catch (err) {
          console.warn('[ChatBridge] bindDest:', err.message);
        }
      };

      // ── MEDIA PATH: download FIRST (before 1–30s typing) so CDN keys don't go stale ──
      if (hasMedia) {
        let media = null;
        try {
          console.log(
            `[ChatBridge] Downloading media BEFORE presence delay (${direction}) type=${msgType}…`
          );
          media = await this.prepareRelayMedia(message);
        } catch (err) {
          console.error('[ChatBridge] prepareRelayMedia:', err.message);
          console.error(err.stack);
        }

        const delayMs = antiBan.nextVariableDelayMs();
        const isVoice =
          msgType === 'ptt' ||
          msgType === 'audio' ||
          /^audio\//i.test(String(media?.mimetype || ''));
        console.log(
          `[ChatBridge] Media buffer=${media?.data ? String(media.data).length : 0} → ${isVoice ? 'recording' : 'typing'} ${delayMs}ms → ${destChatId}`
        );
        try {
          if (isVoice) {
            await this.pm.showRecordingFor(destChatId, delayMs);
          } else {
            await this.showTypingFor(destChatId, delayMs);
          }
        } catch (err) {
          console.error('[ChatBridge] presence delay error:', err.message);
          console.error(err.stack);
          await antiBan.sleep(delayMs);
        }

        const markMediaFailedForRetry = (reason) => {
          console.error(
            `[ChatBridge] MEDIA RELAY FAILED (${msgType}) ${direction}: ${reason}`
          );
          if (waId && this._seenIds?.has(waId)) {
            this._seenIds.delete(waId);
            console.warn(
              `[ChatBridge] Un-saw ${waId} so media can retry on next event`
            );
          }
        };

        if (media?.data) {
          let sentOk = false;
          for (const candidate of destCandidates) {
            try {
              if (isVoice) await this.pm.sendRecordingPresence(candidate);
              else await this.sendTypingPresence(candidate);

              console.log(
                `[ChatBridge] sendMedia → ${candidate} mime=${media.mimetype} file=${media.filename || '—'} type=${msgType}`
              );
              const sent = await this.sendMedia(destPhone, media, {
                caption: cleanBody || undefined,
                chatId: candidate,
                skipTyping: true,
                skipPacing: true,
                skipLimiter: true,
                msgType,
              });
              bindDest(sent?._outboundChatId || candidate);
              console.log(
                `[ChatBridge] Media relay OK (${direction}) → ${candidate}`
              );
              sentOk = true;
              return;
            } catch (err) {
              console.error(
                `[ChatBridge] sendMedia to ${candidate} failed:`,
                err.message
              );
              console.error(err.stack);
            }
          }
          if (!sentOk) {
            console.error(
              `[ChatBridge] All sendMedia candidates failed (${direction}) — trying forward`
            );
          }
        } else {
          console.error(
            `[ChatBridge] Media download empty (${direction}) type=${msgType} — trying native/page forward`
          );
        }

        // Fallback 1: message.forward / page forward (still after presence)
        try {
          console.log('[ChatBridge] Trying native/page forward fallback…');
          const forwarded = await this.nativeForwardToChat(
            message,
            destCandidates,
            { skipTyping: true }
          );
          if (forwarded) {
            bindDest(forwarded._outboundChatId);
            console.log(`[ChatBridge] Forward OK (${direction})`);
            return;
          }
        } catch (err) {
          console.error('[ChatBridge] native forward error:', err.message);
          console.error(err.stack);
        }

        // Fallback 2: one more download attempt after forward failure
        if (!media?.data) {
          try {
            console.log('[ChatBridge] Retry prepareRelayMedia after forward fail…');
            media = await this.prepareRelayMedia(message);
            if (media?.data) {
              if (isVoice) await this.pm.sendRecordingPresence(destChatId);
              else await this.sendTypingPresence(destChatId);
              const sent = await this.sendMedia(destPhone, media, {
                caption: cleanBody || undefined,
                chatId: destChatId,
                skipTyping: true,
                skipPacing: true,
                skipLimiter: true,
                msgType,
              });
              bindDest(sent?._outboundChatId || destChatId);
              console.log(`[ChatBridge] Media retry OK (${direction})`);
              return;
            }
          } catch (err) {
            console.error('[ChatBridge] media retry failed:', err.message);
            console.error(err.stack);
          }
        }

        if (cleanBody) {
          console.warn(
            `[ChatBridge] Media failed (${direction}) — sending caption text only (media still missing)`
          );
          try {
            await this.sendTypingPresence(destChatId);
            await this.sendMessage(destPhone, cleanBody, {
              chatId: destChatId,
              skipTyping: true,
              skipPacing: true,
              skipLimiter: true,
            });
          } catch (err) {
            console.error('[ChatBridge] caption-only send failed:', err.message);
            console.error(err.stack);
          }
          markMediaFailedForRetry('send/forward failed; caption-only sent');
        } else {
          markMediaFailedForRetry('no buffer, forward, or caption');
        }
        return;
      }

      // ── TEXT PATH ──
      if (!cleanBody) {
        console.warn(
          `[ChatBridge] empty text body (${direction}) type=${msgType} — nothing to relay`
        );
        return;
      }

      const delayMs = antiBan.nextVariableDelayMs();
      await this.showTypingFor(destChatId, delayMs);

      if (antiBan.shouldChunkMessage(cleanBody)) {
        const chunks = antiBan.splitIntoNaturalChunks(cleanBody);
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) {
            await this.showTypingFor(destChatId, antiBan.nextVariableDelayMs());
          } else {
            await this.sendTypingPresence(destChatId);
          }
          await this.sendMessage(destPhone, chunks[i], {
            chatId: destChatId,
            skipTyping: true,
            skipPacing: true,
            skipLimiter: true,
          });
        }
        return;
      }

      await this.sendTypingPresence(destChatId);
      await this.sendMessage(destPhone, cleanBody, {
        chatId: destChatId,
        skipTyping: true,
        skipPacing: true,
        skipLimiter: true,
      });
    } catch (err) {
      console.error('[ChatBridge] relayMessageAcrossBridge FATAL:', err.message);
      console.error(err.stack);
    }
  }

  async nativeForwardToChat(message, destChatIds, opts = {}) {
    if (!message) {
      console.warn('[ChatBridge] nativeForward: no message');
      return null;
    }

    const msgId = message.id?._serialized || message.id?.id || null;

    for (const chatId of destChatIds) {
      try {
        if (!opts.skipTyping) {
          await this.showTypingFor(chatId, antiBan.nextVariableDelayMs());
        } else {
          await this.sendTypingPresence(chatId);
        }

        // Prefer page-level forward (stable after delays / LID chats)
        if (msgId) {
          const ok = await this.pm.forwardMessageById(msgId, chatId);
          if (ok) {
            this._lastOutboundChatId = chatId;
            this.markBotOutbound(chatId, 20000);
            console.log(`[ChatBridge] Page forward OK → ${chatId}`);
            return { ok: true, _outboundChatId: chatId };
          }
        }

        if (typeof message.forward === 'function') {
          console.log(`[ChatBridge] message.forward → ${chatId}`);
          await message.forward(chatId);
          this._lastOutboundChatId = chatId;
          this.markBotOutbound(chatId, 20000);
          console.log(`[ChatBridge] Native forward OK → ${chatId}`);
          return { ok: true, _outboundChatId: chatId };
        }

        console.warn('[ChatBridge] nativeForward: no forward API available');
      } catch (err) {
        console.error(`[ChatBridge] forward to ${chatId} failed:`, err.message);
        console.error(err.stack);
      }
    }
    return null;
  }

  async downloadMediaWithRetry(message, tries = 8) {
    return this.pm.downloadMediaWithRetry(message, tries);
  }

  async downloadMediaFromMessageMeta(message) {
    return this.pm.downloadMediaFromMessageMeta(message);
  }

  async simulatePresenceTyping(chatId, text, planned) {
    const timing = planned || antiBan.planOutboundTiming(text || '');
    await this.showTypingFor(chatId, timing.typingMs);
    return timing;
  }

  /**
   * Outbound text with rate caps  /**
   * Outbound text with rate caps, unique jitter, typing (24/7 — no hours gate).
   */
  async sendMessage(phoneOrChat, text, options = {}) {
    if (!this.client || !this.ready) {
      throw new Error('WhatsApp client not ready');
    }

    const rawText = String(text || '').trim();
    if (!rawText && !options.media) {
      throw new Error('Empty message');
    }

    const digits = this.formatPhone(
      String(phoneOrChat || '').includes('@')
        ? String(phoneOrChat).replace(/@.+$/, '')
        : phoneOrChat
    );

    // Prefer inbound chat / reply target — critical for @lid peers
    let chatId =
      options.chatId ||
      options.replyTo?.from ||
      options.replyTo?.author ||
      null;

    if (!options.skipCaps && digits) {
      const caps = antiBan.checkSendCaps(digits);
      if (!caps.ok) {
        const err = new Error(caps.reason || 'rate_capped');
        err.code = caps.reason;
        throw err;
      }
    }

    if (!options.skipLimiter) {
      await antiBan.outboundLimiter.waitTurn();
    } else {
      // Tiny breath so two bubbles in a pair don't collide on the WA socket
      await sleep(antiBan.randInt(120, 400));
    }

    if (!chatId) {
      try {
        chatId = await this.resolveOutboundChatId(phoneOrChat);
      } catch (err) {
        if (options.replyTo && typeof options.replyTo.reply === 'function') {
          chatId = options.replyTo.from || null;
        } else {
          throw err;
        }
      }
    }

    const timing = antiBan.planOutboundTiming(rawText, {
      forcedTotalMs: options.forcedDelayMs ?? null,
    });

    if (!options.skipPacing) {
      if (options.inboundText) {
        await sleep(antiBan.readingDelayMs(options.inboundText));
      } else if (options.forcedDelayMs != null) {
        await sleep(Number(options.forcedDelayMs) || 0);
      } else {
        await sleep(timing.thinkMs);
      }
    }

    if (!options.skipTyping && chatId) {
      await this.simulatePresenceTyping(chatId, rawText, timing);
      // Refresh composing immediately before send (WA expires ~25s)
      await this.sendTypingPresence(chatId);
    }

    // Mark before send so fromMe echo is not treated as a manual takeover
    this.markBotOutbound(
      [
        chatId,
        options.replyTo?.from,
        options.replyTo?.to,
        options.replyTo?.author,
        options.replyTo?.id?.remote,
      ],
      25000
    );

    const canReply =
      options.replyTo && typeof options.replyTo.reply === 'function';    // preferChat: send as a normal bubble (no quote) — needed for bare form URLs
    const preferChat = !!options.preferChat;

    let result;
    const tryChatSend = async (id) => {
      if (!id) throw new Error('No chat id for send');
      // client.sendMessage is more reliable than getChatById for some @lid peers
      if (typeof this.client.sendMessage === 'function') {
        return this.client.sendMessage(id, rawText);
      }
      const chat = await this.client.getChatById(id);
      return chat.sendMessage(rawText);
    };

    try {
      if (preferChat || !canReply) {
        console.log(`[WhatsApp] Sending via chat → ${chatId}`);
        result = await tryChatSend(chatId);
      } else {
        console.log(
          `[WhatsApp] Sending via msg.reply → ${options.replyTo.from || chatId}`
        );
        result = await options.replyTo.reply(rawText);
      }
    } catch (err) {
      console.warn('[WhatsApp] send retry:', err.message);
      const errors = [err.message];
      result = null;

      // Fallback order: reply (works for @lid) → client.sendMessage → getChatById
      if (canReply) {
        try {
          console.log('[WhatsApp] Fallback: msg.reply');
          result = await options.replyTo.reply(rawText);
        } catch (e2) {
          errors.push(e2.message);
        }
      }

      if (!result) {
        const fallbackId =
          chatId ||
          options.replyTo?.from ||
          (digits ? await this.resolveOutboundChatId(digits).catch(() => null) : null) ||
          phoneOrChat;
        this.markBotOutbound(fallbackId, 25000);
        try {
          console.log(`[WhatsApp] Fallback: chat → ${fallbackId}`);
          result = await tryChatSend(fallbackId);
          chatId = fallbackId;
        } catch (e3) {
          errors.push(e3.message);
          throw new Error(`WhatsApp send failed: ${errors.join(' | ')}`);
        }
      }
    }

    // Capture chat id from WA message model when possible
    const resultChat =
      result?.id?.remote ||
      result?.to ||
      result?._data?.to ||
      chatId;
    chatId = resultChat || chatId;

    this._lastOutboundChatId = chatId;
    if (result) result._outboundChatId = chatId;
    this.markBotOutbound(
      [chatId, options.replyTo?.from, options.replyTo?.to, result?.to],
      25000
    );

    try {
      MessageLog.add({
        direction: 'out',
        phone: digits || chatId,
        body: rawText,
        meta: { chatId, id: result?.id?._serialized },
      });
    } catch (_) {}

    return result;
  }

  async sendMedia(phoneOrChat, media, options = {}) {
    if (!this.client || !this.ready) {
      throw new Error('WhatsApp client not ready');
    }
    if (!media) throw new Error('No media');

    // Ensure real MessageMedia instance (instanceof check inside wweb.js)
    let payload = media;
    try {
      if (!(payload instanceof MessageMedia)) {
        if (!payload?.data) throw new Error('Media has empty data buffer');
        let rawData = String(payload.data);
        const dataUrl = rawData.match(/^data:[^;]+;base64,(.+)$/i);
        if (dataUrl) rawData = dataUrl[1];
        payload = new MessageMedia(
          payload.mimetype || 'application/octet-stream',
          rawData,
          payload.filename || undefined,
          payload.filesize
        );
        console.log('[Media] wrapped plain object into MessageMedia instance');
      }
    } catch (err) {
      console.error('[Media] MessageMedia normalize failed:', err.message);
      console.error(err.stack);
      throw err;
    }

    if (!payload.data) throw new Error('Media has empty data buffer');

    const digits = this.formatPhone(
      String(phoneOrChat || '').includes('@')
        ? String(phoneOrChat).replace(/@.+$/, '')
        : phoneOrChat
    );

    if (!options.skipLimiter) {
      await antiBan.outboundLimiter.waitTurn();
    }

    let chatId =
      options.chatId ||
      (await this.resolveOutboundChatId(phoneOrChat).catch((err) => {
        console.error('[Media] resolveOutboundChatId:', err.message);
        console.error(err.stack);
        return null;
      }));
    if (!chatId) throw new Error('No chat id for media send');

    this.markBotOutbound(chatId, 25000);

    const msgType = String(options.msgType || '').toLowerCase();
    const isVoice =
      msgType === 'ptt' ||
      msgType === 'audio' ||
      /^audio\//i.test(String(payload.mimetype || ''));

    if (!options.skipTyping) {
      const timing = antiBan.planOutboundTiming(options.caption || '(media)');
      try {
        if (isVoice) await this.pm.showRecordingFor(chatId, timing.typingMs);
        else await this.showTypingFor(chatId, timing.typingMs);
      } catch (err) {
        console.error('[Media] presence before send failed:', err.message);
      }
    } else {
      try {
        if (isVoice) await this.pm.sendRecordingPresence(chatId);
        else await this.sendTypingPresence(chatId);
      } catch (err) {
        console.warn('[Media] presence pulse failed:', err.message);
      }
    }

    // Prefer explicit option, else try typed option sets (voice/pdf/image/…)
    let optionSets;
    if (options.sendAsDocument || options.sendAudioAsVoice || options.sendMediaAsSticker) {
      optionSets = [
        {
          caption: options.caption || undefined,
          sendMediaAsDocument: !!options.sendAsDocument,
          sendAudioAsVoice: !!options.sendAudioAsVoice,
          sendMediaAsSticker: !!options.sendMediaAsSticker,
          sendVideoAsGif: !!options.sendVideoAsGif,
          _label: 'explicit',
        },
      ];
    } else {
      optionSets = buildMediaSendOptionSets(
        msgType || payload.mimetype,
        payload,
        options.caption
      );
    }

    console.log(
      `[Media] sending → ${chatId} mime=${payload.mimetype} file=${payload.filename || '—'} b64=${String(payload.data).length} attempts=${optionSets.map((s) => s._label).join(',')}`
    );

    const errors = [];
    for (const sendOpts of optionSets) {
      const label = sendOpts._label || 'attempt';
      const opts = { ...sendOpts };
      delete opts._label;
      try {
        console.log(`[Media] attempt=${label} opts=${JSON.stringify(opts)}`);
        let result;
        try {
          result = await this.client.sendMessage(chatId, payload, opts);
        } catch (err) {
          console.error(
            `[Media] client.sendMessage (${label}) failed:`,
            err.message
          );
          console.error(err.stack);
          const chat = await this.client.getChatById(chatId);
          result = await chat.sendMessage(payload, opts);
        }

        if (!result) {
          console.warn(`[Media] attempt=${label} returned null/undefined`);
          errors.push(`${label}:null_result`);
          continue;
        }

        this._lastOutboundChatId = chatId;
        result._outboundChatId = chatId;
        this.markBotOutbound(chatId, 25000);

        try {
          MessageLog.add({
            direction: 'out',
            phone: digits || chatId,
            body: options.caption || `[media:${payload.mimetype || 'file'}]`,
            meta: {
              chatId,
              media: true,
              mimetype: payload.mimetype,
              filename: payload.filename,
              attempt: label,
            },
          });
        } catch (_) {}

        console.log(`[Media] send OK → ${chatId} via ${label}`);
        return result;
      } catch (err) {
        console.error(`[Media] attempt=${label} FAILED:`, err.message);
        console.error(err.stack);
        errors.push(`${label}:${err.message}`);
      }
    }

    const summary = errors.join(' | ') || 'unknown';
    console.error(`[Media] sendMedia ALL attempts failed → ${chatId}: ${summary}`);
    throw new Error(`sendMedia failed: ${summary}`);
  }

  async showTypingFor(chatId, durationMs) {
    return this.pm.showTypingFor(chatId, durationMs);
  }

  async sendTypingPresence(chatId) {
    return this.pm.sendTypingPresence(chatId);
  }

  /**
   * Human-like form share:
   * 1) typing → natural text
   * 2) pause
   * 3) typing → bare clickable form URL (separate message)
   *
   * Important: never drop replyTo fallback — @lid peers often fail getChatById
   * after the first bubble if we only rely on phone/@c.us resolution.
   */
  async sendNaturalFormPair(phone, formLink, opts = {}) {
    const { buildNaturalFormParts } = require('../utils/naturalReply');
    const { getBaseUrl } = require('../config/baseUrl');
    // Never run scrubForbidden on URLs — only sanitize format
    const link = sanitizeFormLink(String(formLink || '').trim());
    if (!link || !/^https?:\/\//i.test(link)) {
      throw new Error(`Empty/invalid form link: ${formLink || '(blank)'}`);
    }

    const customTemplate = String(
      opts.customTemplate != null
        ? opts.customTemplate
        : Settings.get('form_link_message') || ''
    ).trim();

    const { text } = buildNaturalFormParts({
      name: opts.name || '',
      formLink: link,
      customTemplate: customTemplate === '{{form_link}}' ? '' : customTemplate,
    });

    let chatId =
      opts.chatId ||
      opts.replyTo?.from ||
      opts.replyTo?.author ||
      null;
    if (!chatId) {
      try {
        chatId = await this.resolveOutboundChatId(phone);
      } catch (_) {}
    }

    this.markBotOutbound(
      [chatId, opts.replyTo?.from, opts.replyTo?.to, opts.replyTo?.author],
      60000
    );

    const pairOpts = {
      chatId,
      replyTo: opts.replyTo,
      skipTyping: true,
      skipPacing: true,
      skipCaps: true,
      skipLimiter: true, // pair already has typing + gap; don't stack anti-ban queue waits
    };

    const sendBubble = async (body, { preferChat = false, label = 'msg' } = {}) => {
      console.log(
        `[WhatsApp] Form flow send ${label}: preferChat=${preferChat} chatId=${chatId || '—'} body="${String(body).slice(0, 80)}"`
      );
      try {
        const result = await this.sendMessage(phone, body, {
          ...pairOpts,
          chatId,
          preferChat,
          // Keep replyTo always — sendMessage uses it as fallback when preferChat fails
          replyTo: opts.replyTo,
        });
        if (result?._outboundChatId) {
          chatId = result._outboundChatId;
          pairOpts.chatId = chatId;
        }
        return result;
      } catch (err) {
        console.error(`[WhatsApp] Form flow ${label} failed:`, err.message);
        throw err;
      }
    };

    // 1) Typing 1–30s, then human text (no URL)
    const typing1 = antiBan.nextVariableDelayMs();
    console.log(`[WhatsApp] Form flow: typing ${typing1}ms → text`);
    await this.showTypingFor(chatId, typing1);
    await sendBubble(text, { preferChat: false, label: 'text' });

    // 2–3) Keep composing visible through the gap + second typing window, then bare URL
    const typing2 = antiBan.nextVariableDelayMs();
    console.log(`[WhatsApp] Form flow: typing ${typing2}ms → link`);
    await this.showTypingFor(chatId, typing2);
    await sendBubble(link, { preferChat: true, label: 'link' });

    console.log(
      `[WhatsApp] Form pair OK → ${phone}: "${text}" + ${link} (base=${getBaseUrl()})`
    );
    return { text, link };
  }

  /**
   * Create/reuse submission then send natural text + separate form URL.
   */
  async sendFormLinkOnly(phone, opts = {}) {
    const existing = Submissions.findLatestOpen(phone);
    let submission =
      !opts.forceNew && existing && existing.status === 'awaiting_form'
        ? existing
        : null;
    if (!submission) {
      submission = Submissions.create({
        token: newToken(),
        customer_phone: phone,
        customer_chat_id: opts.chatId || null,
      });
    }
    if (opts.chatId) {
      try {
        Submissions.setCustomerChatId(submission.token, opts.chatId);
      } catch (_) {}
    }

    const formLink = this.buildFormUrl(submission.token);
    await this.sendNaturalFormPair(phone, formLink, {
      chatId: opts.chatId,
      replyTo: opts.replyTo,
      name: opts.name || '',
      customTemplate: opts.customTemplate,
    });
    return true;
  }

  async notifyFormSubmitted(submission) {
    return engineNotifyForm(submission);
  }

  async resetSession() {
    await this.destroyClient();
    this.clearSessionFiles();
    this._initAttempt = 0;
    await this.init({ force: true });
  }

  async logout() {
    try {
      if (this.client) await this.client.logout();
    } catch (_) {}
    await this.destroyClient();
    this.clearSessionFiles();
    this.status = 'disconnected';
    this.ready = false;
    this.emit('whatsapp:status', this.getPublicStatus());
  }
}

const whatsapp = new WhatsAppService();
module.exports = whatsapp;
