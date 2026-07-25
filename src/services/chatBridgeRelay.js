/**
 * Two-Way Chat Bridge Relay Controller
 * ------------------------------------
 * Owns customer ↔ company proxying for text + ALL media types
 * (image, PDF, document, voice/audio, video, sticker).
 *
 * Pipeline (every media relay — exactly once per message id):
 *   1. Claim dedupe key (skip if already relayed / in-flight)
 *   2. Download buffer (before human delay — CDN keys stay fresh)
 *   3. Human delay 1–45s with live typing/recording presence
 *   4. ONE buffer sendMessage → if fail, ONE native forward → stop
 *
 * All failures are try/caught and logged — never crash the PM2 process.
 */
const { ChatSessions, Settings } = require('../models');
const antiBan = require('./antiBan');
const {
  isMediaLikeMessage,
} = require('./waPresenceMedia');

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

function isCloseCommand(text) {
  const n = normalizeMsg(text);
  return getCloseKeywords().some((k) => n === k);
}

function isVoiceType(msgType, media) {
  const t = String(msgType || '').toLowerCase();
  return (
    t === 'ptt' ||
    t === 'audio' ||
    /^audio\//i.test(String(media?.mimetype || ''))
  );
}

class ChatBridgeRelay {
  /**
   * @param {import('./whatsapp')} wa
   */
  constructor(wa) {
    this.wa = wa;
    /** @type {Map<string|number, Promise>} */
    this._sessionQueues = new Map();
    /** Inbound media message keys already relayed (dedupe) */
    this._relayedMediaIds = new Set();
    /** In-flight media keys (prevent concurrent double relay) */
    this._inflightMediaIds = new Set();
  }

  mediaDedupeKey(message, direction = '') {
    const sid =
      (this.wa.pm?.getSerializedMsgId &&
        this.wa.pm.getSerializedMsgId(message)) ||
      message?.id?._serialized ||
      null;
    const hash = message?.id?.id != null ? String(message.id.id) : null;
    const ts = message?.timestamp || message?._data?.t || '';
    const from = message?.from || '';
    const type = message?.type || '';
    const base = sid || hash || `${from}:${ts}:${type}`;
    return `${direction}:${base}`;
  }

  /**
   * Claim exclusive rights to relay this media once.
   * @returns {boolean} false if already relayed / in-flight
   */
  claimMediaRelay(key) {
    if (!key) return true;
    if (this._relayedMediaIds.has(key)) {
      console.warn(
        `[BridgeRelay] DEDUPE skip — media already relayed: ${key}`
      );
      return false;
    }
    if (this._inflightMediaIds.has(key)) {
      console.warn(
        `[BridgeRelay] DEDUPE skip — media already in-flight: ${key}`
      );
      return false;
    }
    this._inflightMediaIds.add(key);
    return true;
  }

  /**
   * Continue an already-claimed in-flight relay (claimed at handleInbound).
   */
  continueMediaClaim(key) {
    if (!key) return true;
    if (this._relayedMediaIds.has(key)) {
      console.warn(
        `[BridgeRelay] DEDUPE skip — already completed: ${key}`
      );
      return false;
    }
    if (!this._inflightMediaIds.has(key)) {
      this._inflightMediaIds.add(key);
    }
    return true;
  }

  markMediaRelayed(key) {
    if (!key) return;
    this._inflightMediaIds.delete(key);
    this._relayedMediaIds.add(key);
    // Bound set size
    if (this._relayedMediaIds.size > 3000) {
      const drop = [...this._relayedMediaIds].slice(0, 800);
      drop.forEach((k) => this._relayedMediaIds.delete(k));
    }
    console.log(`[BridgeRelay] DEDUPE marked relayed: ${key}`);
  }

  releaseMediaClaim(key) {
    if (!key) return;
    this._inflightMediaIds.delete(key);
  }

  /**
   * Serialize work per session so typing indicators don't overlap chaotically.
   */
  enqueueSession(sessionId, task) {
    const key = sessionId || 'global';
    const prev = this._sessionQueues.get(key) || Promise.resolve();
    const next = prev
      .then(() => task())
      .catch((err) => {
        console.error(`[BridgeRelay] session#${key} task error:`, err.message);
        console.error(err.stack);
      });
    this._sessionQueues.set(
      key,
      next.finally(() => {
        if (this._sessionQueues.get(key) === next) {
          this._sessionQueues.delete(key);
        }
      })
    );
    return next;
  }

  unsee(waId) {
    // Do NOT unsee media after a failed relay — that re-queues duplicates.
    // Only clear for debugging when explicitly needed.
    if (!waId || !this.wa._seenIds) return;
    console.warn(
      `[BridgeRelay] unsee suppressed for ${waId} (prevents duplicate media relay)`
    );
  }

  /**
   * Entry: route inbound message into customer→desk or desk→customer.
   * @returns {Promise<boolean>} true if handled by bridge
   */
  async handleInbound(message, phone, chatId, body) {
    try {
      this.wa.normalizeIncomingMessageIds?.(message);
      const digits = this.wa.formatPhone(phone);
      const msgType = String(message?.type || '').toLowerCase();
      const hasMedia = isMediaLikeMessage(message);

      console.log(
        `[BridgeRelay] inbound type=${msgType || 'text'} media=${hasMedia} hasMediaFlag=${!!message?.hasMedia} from=${message?.from || '?'} phone=${digits || phone || '—'} chatId=${chatId || '—'}`
      );

      // ── Customer side ──
      const customerSession =
        (digits && ChatSessions.findActiveByCustomer(digits)) ||
        (chatId && ChatSessions.findActiveByCustomerChatId(chatId)) ||
        null;

      if (customerSession) {
        if (!hasMedia && body && isCloseCommand(body)) {
          await this.wa.closeChatSession(customerSession, {
            closedBy: 'customer',
            silent: true,
          });
          return true;
        }

        try {
          ChatSessions.touch(customerSession.id, {
            customer_chat_id: chatId,
            side: 'customer',
          });
        } catch (err) {
          console.warn('[BridgeRelay] touch customer:', err.message);
        }

        console.log(
          `[BridgeRelay] Customer→Desk #${customerSession.id}[${customerSession.session_code}] media=${hasMedia} type=${msgType || 'text'}`
        );

        if (hasMedia) {
          const key = this.mediaDedupeKey(message, 'customer_to_desk');
          if (!this.claimMediaRelay(key)) return true;
        }

        await this.enqueueSession(customerSession.id, () =>
          this.relay(message, customerSession, 'customer_to_desk', body, hasMedia)
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
          quotedWaId = quoted?.id?._serialized || quoted?.id?.id || null;
        }
      } catch (err) {
        console.warn('[BridgeRelay] getQuotedMessage:', err.message);
      }

      const resolved = ChatSessions.resolveDeskInbound(digits || phone, {
        quotedWaId,
        body,
        chatId,
      });
      const deskSession = resolved?.session || deskByChat || null;

      if (!deskSession?.id) {
        console.warn(
          `[BridgeRelay] Desk inbound unmatched phone=${digits || '?'} chatId=${chatId || '?'} method=${resolved?.method || 'none'}`
        );
        if (hasMedia) {
          console.error(
            '[BridgeRelay] MEDIA from desk but no session — cannot relay'
          );
        }
        return false;
      }

      if (!hasMedia && body && isCloseCommand(body)) {
        await this.wa.closeChatSession(deskSession, {
          closedBy: 'desk',
          silent: true,
        });
        return true;
      }

      try {
        ChatSessions.touch(deskSession.id, {
          desk_chat_id: chatId,
          side: 'desk',
        });
      } catch (err) {
        console.warn('[BridgeRelay] touch desk:', err.message);
      }

      console.log(
        `[BridgeRelay] Desk→Customer #${deskSession.id}[${deskSession.session_code}] via ${resolved?.method || 'desk_chat'} media=${hasMedia} type=${msgType || 'text'}`
      );

      if (hasMedia) {
        const key = this.mediaDedupeKey(message, 'desk_to_customer');
        if (!this.claimMediaRelay(key)) return true;
      }

      await this.enqueueSession(deskSession.id, () =>
        this.relay(message, deskSession, 'desk_to_customer', body, hasMedia)
      );
      return true;
    } catch (err) {
      console.error('[BridgeRelay] handleInbound FATAL:', err.message);
      console.error(err.stack);
      return false;
    }
  }

  async resolveDestChatIds(destPhone, preferredChatId = null) {
    const candidates = [];
    const push = (id) => {
      const s = String(id || '').trim();
      if (s && !candidates.includes(s)) candidates.push(s);
    };

    push(preferredChatId);
    if (preferredChatId) {
      const user = String(preferredChatId).replace(/@.+$/, '');
      if (user) {
        if (String(preferredChatId).endsWith('@lid')) push(`${user}@lid`);
        else {
          push(`${user}@c.us`);
          push(`${user}@lid`);
        }
      }
    }

    const digits = this.wa.formatPhone(destPhone);
    if (digits) {
      push(`${digits}@c.us`);
      try {
        const resolved = await this.wa.resolveOutboundChatId(digits);
        push(resolved);
      } catch (err) {
        console.warn(
          `[BridgeRelay] resolveOutboundChatId(${digits}):`,
          err.message
        );
      }
    }

    console.log(
      `[BridgeRelay] dest candidates → ${candidates.join(' | ') || '(none)'}`
    );
    return candidates;
  }

  /**
   * Full 1–45s human delay with live typing or recording presence.
   */
  async humanPresenceDelay(chatId, { voice = false } = {}) {
    const delayMs = antiBan.nextVariableDelayMs();
    const mode = voice ? 'recording' : 'typing';
    console.log(
      `[BridgeRelay] Human ${mode} window ${delayMs}ms → ${chatId || '(none)'}`
    );
    try {
      if (!chatId) {
        await antiBan.sleep(delayMs);
        return delayMs;
      }
      if (voice) {
        await this.wa.pm.showRecordingFor(chatId, delayMs);
      } else {
        await this.wa.showTypingFor(chatId, delayMs);
      }
    } catch (err) {
      console.error(`[BridgeRelay] presence ${mode} error:`, err.message);
      console.error(err.stack);
      try {
        await antiBan.sleep(delayMs);
      } catch (_) {}
    }
    return delayMs;
  }

  /**
   * Core relay: text + media, both directions.
   */
  async relay(message, session, direction, body, hasMediaFlag = null) {
    const waId = message?.id?._serialized || message?.id?.id || null;
    let mediaKey = null;
    try {
      if (!this.wa.client || !this.wa.ready) {
        console.error(
          `[BridgeRelay] Client not ready — cannot relay ${direction}`
        );
        return;
      }

      this.wa.normalizeIncomingMessageIds?.(message);

      const toCustomer = direction === 'desk_to_customer';
      const destPhone = toCustomer ? session.customer_phone : session.desk_phone;
      const preferredChatId = toCustomer
        ? session.customer_chat_id
        : session.desk_chat_id;
      const msgType = String(message.type || '').toLowerCase();
      const hasMedia =
        hasMediaFlag != null ? !!hasMediaFlag : isMediaLikeMessage(message);

      // Strict media dedupe — continue claim from handleInbound (or claim now)
      if (hasMedia) {
        mediaKey = this.mediaDedupeKey(message, direction);
        if (!this.continueMediaClaim(mediaKey)) {
          return;
        }
      }

      const destCandidates = await this.resolveDestChatIds(
        destPhone,
        preferredChatId
      );
      if (!destCandidates.length) {
        console.error(
          `[BridgeRelay] No dest chat ids ${direction} phone=${destPhone} preferred=${preferredChatId || '—'}`
        );
        if (mediaKey) this.releaseMediaClaim(mediaKey);
        return;
      }

      // Prefer a single destination to avoid multi-candidate duplicate sends
      const destChatId = preferredChatId || destCandidates[0];
      const primaryDests = [destChatId].filter(Boolean);

      if (waId) {
        try {
          ChatSessions.trackMessage(
            session.id,
            direction,
            String(waId),
            body || `[${msgType || 'msg'}]`
          );
        } catch (err) {
          console.warn('[BridgeRelay] trackMessage:', err.message);
        }
      }

      const cleanBody = antiBan.cleanRelayText(body);
      console.log(
        `[BridgeRelay] ${direction} media=${hasMedia} type=${msgType || 'text'} dest=${destChatId} (single-dest mode)`
      );

      const bindDest = (bound) => {
        const id = bound || destChatId;
        if (!id) return;
        try {
          if (toCustomer) ChatSessions.bindCustomerChatId(session.id, id);
          else ChatSessions.bindDeskChatId(session.id, id);
        } catch (err) {
          console.warn('[BridgeRelay] bindDest:', err.message);
        }
      };

      if (hasMedia) {
        await this.relayMedia({
          message,
          session,
          direction,
          destPhone,
          destChatId,
          destCandidates: primaryDests,
          msgType,
          cleanBody,
          waId,
          bindDest,
          mediaKey,
        });
        return;
      }

      await this.relayText({
        destPhone,
        destChatId,
        cleanBody,
        msgType,
        direction,
      });
    } catch (err) {
      console.error('[BridgeRelay] relay FATAL:', err.message);
      console.error(err.stack);
      if (mediaKey) this.releaseMediaClaim(mediaKey);
    }
  }

  /**
   * Media relay — exactly ONE successful outbound send per message.
   * Order: buffer send once → native forward once → stop.
   */
  async relayMedia(ctx) {
    const {
      message,
      direction,
      destPhone,
      destChatId,
      destCandidates,
      msgType,
      cleanBody,
      waId,
      bindDest,
      mediaKey,
    } = ctx;

    const finishOk = (how, dest) => {
      if (mediaKey) this.markMediaRelayed(mediaKey);
      console.log(
        `[BridgeRelay] MEDIA DONE once via=${how} dest=${dest || destChatId} key=${mediaKey || '—'}`
      );
    };

    const finishFail = () => {
      // Keep claim released but DO mark as relayed to stop further event loops
      // from re-sending the same inbound media repeatedly.
      if (mediaKey) this.markMediaRelayed(mediaKey);
      console.error(
        `[BridgeRelay] MEDIA RELAY FAILED (${msgType}) ${direction} — will not retry (dedupe)`
      );
    };

    try {
      this.wa.pm.logInboundMediaDetails(message, `relay:${direction}`);
    } catch (_) {}

    const voice = isVoiceType(msgType, null);
    let liveMessage = message;
    const singleDest = destChatId || (destCandidates && destCandidates[0]);
    if (!singleDest) {
      console.error('[BridgeRelay] relayMedia: no destination');
      finishFail();
      return;
    }

    console.log(
      `[BridgeRelay] Media ONE-SHOT relay type=${msgType} dest=${singleDest} (${direction})`
    );

    try {
      liveMessage =
        (await this.wa.pm.waitForMessageInStore(liveMessage, 4000)) ||
        liveMessage;
    } catch (err) {
      console.warn('[BridgeRelay] pre-download store wait:', err.message);
    }

    const downloadPromise = (async () => {
      try {
        const media = await this.wa.prepareRelayMedia(liveMessage);
        console.log(
          `[BridgeRelay] Download buffer=${media?.data ? String(media.data).length : 0} mime=${media?.mimetype || '—'}`
        );
        return media;
      } catch (err) {
        console.error('[BridgeRelay] prepareRelayMedia:', err.message);
        console.error(err.stack);
        return null;
      }
    })();

    await this.humanPresenceDelay(singleDest, { voice });

    try {
      if (voice) await this.wa.pm.sendRecordingPresence(singleDest);
      else await this.wa.sendTypingPresence(singleDest);
    } catch (_) {}

    // ── 1) Buffer send EXACTLY once to ONE dest ──
    let media = null;
    try {
      media = await downloadPromise;
    } catch (err) {
      console.error('[BridgeRelay] downloadPromise:', err.message);
    }

    if (media?.data) {
      try {
        console.log(
          `[BridgeRelay] ONE buffer sendMessage → ${singleDest} type=${msgType} mime=${media.mimetype}`
        );
        const sent = await this.wa.sendMedia(destPhone, media, {
          caption: cleanBody || undefined,
          chatId: singleDest,
          skipTyping: true,
          skipPacing: true,
          skipLimiter: true,
          msgType,
          once: true, // single option attempt — no image+document double send
        });
        // Treat non-throw as success even if WA returns null/undefined
        bindDest(sent?._outboundChatId || singleDest);
        finishOk('buffer', sent?._outboundChatId || singleDest);
        return;
      } catch (err) {
        console.error(
          '[BridgeRelay] ONE buffer send FAILED:',
          err.message
        );
        console.error(err.stack);
      }
    } else {
      console.warn('[BridgeRelay] No buffer — trying native forward once');
    }

    // ── 2) Native forward EXACTLY once (only if buffer failed) ──
    try {
      console.log(
        `[BridgeRelay] ONE native forward fallback → ${singleDest}`
      );
      const forwarded = await this.nativeForward(liveMessage, [singleDest], {
        skipTyping: true,
      });
      if (forwarded) {
        bindDest(forwarded._outboundChatId || singleDest);
        finishOk('native_forward', forwarded._outboundChatId || singleDest);
        return;
      }
      console.warn('[BridgeRelay] Native forward returned null');
    } catch (err) {
      console.error('[BridgeRelay] native forward error:', err.message);
      console.error(err.stack);
    }

    // ── 3) Caption only (still once) — then stop forever for this id ──
    if (cleanBody) {
      try {
        await this.wa.sendTypingPresence(singleDest);
        await this.wa.sendMessage(destPhone, cleanBody, {
          chatId: singleDest,
          skipTyping: true,
          skipPacing: true,
          skipLimiter: true,
        });
      } catch (err) {
        console.error('[BridgeRelay] caption send failed:', err.message);
      }
    }

    finishFail();
  }

  async nativeForward(message, destChatIds, opts = {}) {
    if (!message) {
      console.warn('[BridgeRelay] nativeForward: no message');
      return null;
    }
    // Only first destination — never fan-out
    const chatId = (destChatIds || []).find(Boolean);
    if (!chatId) {
      console.warn('[BridgeRelay] nativeForward: no dest chat id');
      return null;
    }

    let msgId = null;
    try {
      msgId = this.wa.pm.getSerializedMsgId
        ? this.wa.pm.getSerializedMsgId(message)
        : null;
      if (
        msgId &&
        this.wa.pm.isValidSerializedMsgId &&
        !this.wa.pm.isValidSerializedMsgId(msgId)
      ) {
        msgId = null;
      }
    } catch (_) {
      msgId = null;
    }

    try {
      if (!opts.skipTyping) {
        await this.humanPresenceDelay(chatId, { voice: false });
      } else {
        await this.wa.sendTypingPresence(chatId);
      }

      if (msgId) {
        console.log(
          `[BridgeRelay] page forwardMessage ONCE → ${chatId} id=${msgId}`
        );
        const ok = await this.wa.pm.forwardMessageById(msgId, chatId);
        if (ok) {
          this.wa._lastOutboundChatId = chatId;
          this.wa.markBotOutbound(chatId, 20000);
          return { ok: true, _outboundChatId: chatId, via: 'page' };
        }
      }

      if (typeof message.forward === 'function') {
        console.log(`[BridgeRelay] message.forward ONCE → ${chatId}`);
        await message.forward(chatId);
        this.wa._lastOutboundChatId = chatId;
        this.wa.markBotOutbound(chatId, 20000);
        return { ok: true, _outboundChatId: chatId, via: 'message.forward' };
      }
    } catch (err) {
      console.error(`[BridgeRelay] forward → ${chatId} failed:`, err.message);
      console.error(err.stack);
    }
    return null;
  }

  async relayText({ destPhone, destChatId, cleanBody, msgType, direction }) {
    if (!cleanBody) {
      console.warn(
        `[BridgeRelay] empty text (${direction}) type=${msgType} — nothing to relay`
      );
      return;
    }

    await this.humanPresenceDelay(destChatId, { voice: false });

    try {
      await this.wa.sendTypingPresence(destChatId);
    } catch (_) {}

    if (antiBan.shouldChunkMessage(cleanBody)) {
      const chunks = antiBan.splitIntoNaturalChunks(cleanBody);
      for (let i = 0; i < chunks.length; i++) {
        try {
          if (i > 0) {
            await this.humanPresenceDelay(destChatId, { voice: false });
          } else {
            await this.wa.sendTypingPresence(destChatId);
          }
          await this.wa.sendMessage(destPhone, chunks[i], {
            chatId: destChatId,
            skipTyping: true,
            skipPacing: true,
            skipLimiter: true,
          });
        } catch (err) {
          console.error(
            `[BridgeRelay] chunk ${i + 1}/${chunks.length} failed:`,
            err.message
          );
          console.error(err.stack);
        }
      }
      return;
    }

    try {
      await this.wa.sendMessage(destPhone, cleanBody, {
        chatId: destChatId,
        skipTyping: true,
        skipPacing: true,
        skipLimiter: true,
      });
      console.log(`[BridgeRelay] TEXT OK (${direction}) → ${destChatId}`);
    } catch (err) {
      console.error('[BridgeRelay] text send failed:', err.message);
      console.error(err.stack);
    }
  }
}

function createChatBridgeRelay(wa) {
  return new ChatBridgeRelay(wa);
}

module.exports = {
  ChatBridgeRelay,
  createChatBridgeRelay,
  isCloseCommand,
  isMediaLikeMessage,
};
