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
    this.engine = bindEngine(this);
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
    client.on('qr', async (qr) => {
      try {
        this.qrDataUrl = await qrcode.toDataURL(qr);
        this.status = 'qr';
        this.ready = false;
        this.emit('whatsapp:qr', { qr: this.qrDataUrl });
        this.emit('whatsapp:status', this.getPublicStatus());
        console.log('[WhatsApp] QR ready — scan with phone');
      } catch (err) {
        console.error('[WhatsApp] QR encode failed:', err.message);
      }
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
    const bodyPreview = String(message.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    console.log(
      `Received message [${source}]: "${bodyPreview || `[${message.type || 'unknown'}]`}" from: ${from}` +
        (message.fromMe ? ' (fromMe)' : '')
    );
    this._lastInboundAt = Date.now();

    if (source === 'message_ciphertext') return; // wait for decrypt / poller
    if (message.fromMe) return;

    this.enqueueIncomingMessage(message);
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
    const ms = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : 10000;
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
      console.warn('[WhatsApp] Inbound queue full — dropping message');
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

    const body = String(message.body || '').trim();
    console.log(
      `[WhatsApp] Processing inbound type=${message.type || '?'} from=${message.from} body="${body.slice(0, 80)}"`
    );

    const { phone, chatId } = await this.resolveIncomingPeer(message);

    try {
      MessageLog.add({
        direction: 'in',
        phone: phone || chatId,
        body: body || `[${message.type}]`,
        meta: {
          type: message.type,
          chatId,
          hasMedia: !!message.hasMedia,
          id: msgId,
        },
      });
    } catch (_) {}

    // 1) Active bridge first
    try {
      const bridged = await this.handleChatBridge(message, phone, chatId, body);
      if (bridged) return;
    } catch (err) {
      console.error('[ChatBridge] error:', err.message);
    }

    if (!phone) {
      console.warn('[WhatsApp] Could not resolve inbound phone — silent');
      return;
    }

    // 2) Workflow engine (access-code gated) — responds 24/7
    try {
      await this.engine.handleIncomingMessage({
        phone,
        body,
        chatId,
        replyTo: message,
      });
    } catch (err) {
      console.error('[Workflow] handleIncomingMessage:', err.message);
    }
  }

  /**
   * Two-way live relay. Close/CLS from either side → silent session end.
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
          silent: true,
        });
        return true;
      }

      ChatSessions.touch(customerSession.id, {
        customer_chat_id: chatId,
        side: 'customer',
      });
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
    if (!ChatSessions.isDeskPhone(digits) && !ChatSessions.listActiveByDesk(digits).length) {
      // Also match by desk_chat_id for LID desks
      const byChat = ChatSessions.listActive().filter(
        (s) => s.desk_chat_id && s.desk_chat_id === chatId
      );
      if (!byChat.length) return false;
    }

    let quotedWaId = null;
    try {
      if (message.hasQuotedMsg) {
        const quoted = await message.getQuotedMessage();
        quotedWaId =
          quoted?.id?._serialized || quoted?.id?.id || null;
      }
    } catch (_) {}

    const deskSession = ChatSessions.resolveDeskInbound(digits, {
      quotedWaId,
      body,
      chatId,
    });

    if (!deskSession) return false;

    if (body && isCloseCommand(body)) {
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
    await this.relayMessageAcrossBridge(
      message,
      deskSession,
      'desk_to_customer',
      body,
      hasMedia
    );
    return true;
  }

  /**
   * Silent close — no notices to either party.
   */
  async closeChatSession(session, { closedBy = 'system', silent = true } = {}) {
    if (!session?.id) return;
    try {
      ChatSessions.close(session.id);
      console.log(
        `[ChatBridge] Session #${session.id}[${session.session_code}] closed by ${closedBy}` +
          (silent ? ' (silent)' : '')
      );
    } catch (err) {
      console.error('[ChatBridge] close failed:', err.message);
    }
  }

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
      } catch (_) {}
    }

    return candidates;
  }

  /**
   * Relay with native Forwarded tag when possible; chunk long text; media fallback.
   */
  async relayMessageAcrossBridge(message, session, direction, body, hasMediaFlag = null) {
    this.normalizeIncomingMessageIds(message);

    const toCustomer = direction === 'desk_to_customer';
    const destPhone = toCustomer ? session.customer_phone : session.desk_phone;
    const preferredChatId = toCustomer
      ? session.customer_chat_id
      : session.desk_chat_id;
    const msgType = String(message.type || '').toLowerCase();
    const hasMedia =
      hasMediaFlag != null
        ? hasMediaFlag
        : !!(
            message.hasMedia ||
            ['image', 'video', 'document', 'ptt', 'audio', 'sticker'].includes(msgType)
          );

    const destCandidates = await this.resolveBridgeDestChatIds(
      destPhone,
      preferredChatId
    );
    if (!destCandidates.length) {
      console.warn('[ChatBridge] No dest chat ids for', destPhone);
      return;
    }

    const waId =
      message.id?._serialized || message.id?.id || null;
    if (waId) {
      ChatSessions.trackMessage(
        session.id,
        direction,
        String(waId),
        body || `[${msgType}]`
      );
    }

    // Long text → natural chunks (no native forward of huge blobs)
    const cleanBody = antiBan.cleanRelayText(body);
    if (!hasMedia && antiBan.shouldChunkMessage(cleanBody)) {
      const chunks = antiBan.splitIntoNaturalChunks(cleanBody);
      console.log(
        `[ChatBridge] Chunking ${cleanBody.length} chars → ${chunks.length} parts (${direction})`
      );
      for (const chunk of chunks) {
        await this.sendMessage(destPhone, chunk, {
          chatId: preferredChatId || destCandidates[0],
          skipWorkingHours: true,
        });
      }
      return;
    }

    // Prefer native forward (shows Forwarded tag)
    const forwarded = await this.nativeForwardToChat(message, destCandidates);
    if (forwarded) {
      const boundChat = forwarded._outboundChatId;
      if (boundChat) {
        if (toCustomer) ChatSessions.bindCustomerChatId(session.id, boundChat);
        else ChatSessions.bindDeskChatId(session.id, boundChat);
      }
      return;
    }

    // Fallback: download + resend media, or plain text
    if (hasMedia) {
      const media = await this.downloadMediaWithRetry(message, 5);
      if (media) {
        const caption = cleanBody || undefined;
        await this.sendMedia(destPhone, media, {
          caption,
          chatId: preferredChatId || destCandidates[0],
          skipWorkingHours: true,
        });
        return;
      }
      console.warn('[ChatBridge] Media download failed — text fallback');
    }

    if (cleanBody) {
      await this.sendMessage(destPhone, cleanBody, {
        chatId: preferredChatId || destCandidates[0],
        skipWorkingHours: true,
      });
    }
  }

  async nativeForwardToChat(message, destChatIds) {
    if (!message || typeof message.forward !== 'function') return null;

    // Unique jitter + typing before native forward
    const timing = antiBan.planOutboundTiming('(forward)');
    await sleep(timing.thinkMs);

    for (const chatId of destChatIds) {
      try {
        try {
          const chat = await this.client.getChatById(chatId);
          if (chat?.sendStateTyping) {
            await chat.sendStateTyping();
            await sleep(Math.min(timing.typingMs, 8000));
          }
        } catch (_) {
          await sleep(antiBan.randInt(400, 1200));
        }

        await message.forward(chatId);
        this._lastOutboundChatId = chatId;
        console.log(`[ChatBridge] Native forward → ${chatId}`);
        return { ok: true, _outboundChatId: chatId };
      } catch (err) {
        console.warn(`[ChatBridge] forward to ${chatId} failed:`, err.message);
      }
    }
    return null;
  }

  async downloadMediaWithRetry(message, tries = 5) {
    for (let i = 1; i <= tries; i++) {
      try {
        const media = await message.downloadMedia();
        if (media?.data) return media;
      } catch (err) {
        console.warn(`[ChatBridge] downloadMedia try ${i}/${tries}:`, err.message);
      }
      await sleep(400 * i);
    }

    // Puppeteer page fallback via WAWebDownloadManager when available
    try {
      const media = await this.downloadMediaFromMessageMeta(message);
      if (media?.data) return media;
    } catch (err) {
      console.warn('[ChatBridge] meta download failed:', err.message);
    }
    return null;
  }

  async downloadMediaFromMessageMeta(message) {
    const page = this.client?.pupPage;
    if (!page) return null;
    const serialized =
      message.id?._serialized || message.id?.id || null;
    if (!serialized) return null;

    const result = await page.evaluate(async (msgId) => {
      try {
        const msg = window.Store?.Msg?.get(msgId) ||
          (await window.Store?.Msg?.getMessagesById?.([msgId]))?.[0];
        if (!msg) return null;
        if (window.Store?.DownloadManager?.downloadAndMaybeDecrypt) {
          const blob = await window.Store.DownloadManager.downloadAndMaybeDecrypt({
            directPath: msg.directPath,
            encFilehash: msg.encFilehash,
            mediaKey: msg.mediaKey,
            mediaKeyTimestamp: msg.mediaKeyTimestamp,
            type: msg.type,
            signal: new AbortController().signal,
          });
          // Convert to base64 in page if ArrayBuffer
          if (blob && blob instanceof ArrayBuffer) {
            const bytes = new Uint8Array(blob);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return {
              mimetype: msg.mimetype || 'application/octet-stream',
              data: btoa(binary),
              filename: msg.filename || undefined,
            };
          }
        }
        return null;
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    }, serialized);

    if (result?.error || !result?.data) return null;
    return new MessageMedia(
      result.mimetype || 'application/octet-stream',
      result.data,
      result.filename || undefined
    );
  }

  async simulatePresenceTyping(chatId, text, planned) {
    const timing =
      planned || antiBan.planOutboundTiming(text || '');
    try {
      const chat = await this.client.getChatById(chatId);
      if (chat?.sendStateTyping) {
        await chat.sendStateTyping();
        await sleep(timing.typingMs);
        try {
          await chat.clearState?.();
        } catch (_) {}
      } else {
        await sleep(timing.typingMs);
      }
    } catch (_) {
      await sleep(Math.min(timing.typingMs, 3000));
    }
    return timing;
  }

  /**
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

    if (!this.client) throw new Error('WhatsApp client not ready');

    const digits = this.formatPhone(
      String(phoneOrChat || '').includes('@')
        ? String(phoneOrChat).replace(/@.+$/, '')
        : phoneOrChat
    );

    if (!options.skipCaps) {
      const caps = antiBan.checkSendCaps(digits);
      if (!caps.ok) {
        const err = new Error(caps.reason || 'rate_capped');
        err.code = caps.reason;
        throw err;
      }
    }

    await antiBan.outboundLimiter.waitTurn();

    let chatId = options.chatId;
    if (!chatId) {
      chatId = await this.resolveOutboundChatId(phoneOrChat);
    }

    const timing = antiBan.planOutboundTiming(rawText, {
      forcedTotalMs: options.forcedDelayMs ?? null,
    });

    if (options.inboundText) {
      await sleep(antiBan.readingDelayMs(options.inboundText));
    } else {
      await sleep(timing.thinkMs);
    }

    if (!options.skipTyping) {
      await this.simulatePresenceTyping(chatId, rawText, timing);
    }

    let result;
    try {
      if (options.replyTo && typeof options.replyTo.reply === 'function') {
        result = await options.replyTo.reply(rawText);
      } else {
        const chat = await this.client.getChatById(chatId);
        result = await chat.sendMessage(rawText);
      }
    } catch (err) {
      // Retry once with fresh chat id resolution
      console.warn('[WhatsApp] send retry:', err.message);
      chatId = await this.resolveOutboundChatId(digits || phoneOrChat);
      const chat = await this.client.getChatById(chatId);
      result = await chat.sendMessage(rawText);
    }

    this._lastOutboundChatId = chatId;
    if (result) result._outboundChatId = chatId;

    try {
      MessageLog.add({
        direction: 'out',
        phone: digits,
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

    const digits = this.formatPhone(
      String(phoneOrChat || '').includes('@')
        ? String(phoneOrChat).replace(/@.+$/, '')
        : phoneOrChat
    );

    await antiBan.outboundLimiter.waitTurn();

    let chatId = options.chatId || (await this.resolveOutboundChatId(phoneOrChat));
    const timing = antiBan.planOutboundTiming(options.caption || '(media)');
    await sleep(timing.thinkMs);

    try {
      const chat = await this.client.getChatById(chatId);
      if (chat?.sendStateTyping) {
        await chat.sendStateTyping();
        await sleep(Math.min(timing.typingMs, 6000));
      }
      const result = await chat.sendMessage(media, {
        caption: options.caption || undefined,
      });
      this._lastOutboundChatId = chatId;
      if (result) result._outboundChatId = chatId;

      try {
        MessageLog.add({
          direction: 'out',
          phone: digits,
          body: options.caption || '[media]',
          meta: { chatId, media: true },
        });
      } catch (_) {}

      return result;
    } catch (err) {
      console.error('[WhatsApp] sendMedia failed:', err.message);
      throw err;
    }
  }

  /**
   * Send form URL using Settings.form_link_message (supports {{form_link}}).
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
    const { renderTemplate } = require('../utils/leadSummary');
    const template =
      String(Settings.get('form_link_message') || '').trim() || '{{form_link}}';
    const outbound =
      renderTemplate(template, {
        form_link: formLink,
        business_name: Settings.get('business_name') || '',
        phone,
      }).trim() || formLink;

    await this.sendMessage(phone, outbound, {
      chatId: opts.chatId,
      replyTo: opts.replyTo,
      inboundText: opts.inboundText,
    });
    console.log(`[WhatsApp] Form link → ${phone}: ${formLink}`);
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
