/**
 * Two-Way Chat Bridge Relay Controller
 * ------------------------------------
 * Owns customer ↔ company proxying for text + ALL media types
 * (image, PDF, document, voice/audio, video, sticker).
 *
 * Pipeline (every relay):
 *   1. Detect media aggressively (never rely only on hasMedia/directPath)
 *   2. Download buffer FIRST (before human delay — CDN keys stay fresh)
 *   3. Human delay 1–45s with live typing/recording presence
 *   4. Send via MessageMedia (typed options) → page forward → caption fallback
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
    if (!waId || !this.wa._seenIds) return;
    if (this.wa._seenIds.has(waId)) {
      this.wa._seenIds.delete(waId);
      console.warn(`[BridgeRelay] Un-saw ${waId} for media retry`);
    }
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
    try {
      if (!this.wa.client || !this.wa.ready) {
        console.error(
          `[BridgeRelay] Client not ready — cannot relay ${direction}`
        );
        if (isMediaLikeMessage(message)) this.unsee(waId);
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

      const destCandidates = await this.resolveDestChatIds(
        destPhone,
        preferredChatId
      );
      if (!destCandidates.length) {
        console.error(
          `[BridgeRelay] No dest chat ids ${direction} phone=${destPhone} preferred=${preferredChatId || '—'}`
        );
        if (hasMedia) this.unsee(waId);
        return;
      }

      const destChatId = preferredChatId || destCandidates[0];
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
        `[BridgeRelay] ${direction} media=${hasMedia} type=${msgType || 'text'} dest=${destChatId} candidates=${destCandidates.length}`
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
          destCandidates,
          msgType,
          cleanBody,
          waId,
          bindDest,
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
      if (isMediaLikeMessage(message)) this.unsee(waId);
    }
  }

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
    } = ctx;

    let media = null;
    try {
      console.log(
        `[BridgeRelay] DOWNLOAD media first (${direction}) type=${msgType}…`
      );
      media = await this.wa.prepareRelayMedia(message);
      console.log(
        `[BridgeRelay] Download result buffer=${media?.data ? String(media.data).length : 0} mime=${media?.mimetype || '—'} file=${media?.filename || '—'}`
      );
    } catch (err) {
      console.error('[BridgeRelay] prepareRelayMedia:', err.message);
      console.error(err.stack);
    }

    const voice = isVoiceType(msgType, media);
    await this.humanPresenceDelay(destChatId, { voice });

    // Pulse presence right before send
    try {
      if (voice) await this.wa.pm.sendRecordingPresence(destChatId);
      else await this.wa.sendTypingPresence(destChatId);
    } catch (_) {}

    if (media?.data) {
      for (const candidate of destCandidates) {
        try {
          if (voice) await this.wa.pm.sendRecordingPresence(candidate);
          else await this.wa.sendTypingPresence(candidate);

          console.log(
            `[BridgeRelay] SEND media → ${candidate} type=${msgType} mime=${media.mimetype}`
          );
          const sent = await this.wa.sendMedia(destPhone, media, {
            caption: cleanBody || undefined,
            chatId: candidate,
            skipTyping: true,
            skipPacing: true,
            skipLimiter: true,
            msgType,
          });
          bindDest(sent?._outboundChatId || candidate);
          console.log(`[BridgeRelay] MEDIA OK (${direction}) → ${candidate}`);
          return;
        } catch (err) {
          console.error(
            `[BridgeRelay] sendMedia → ${candidate} failed:`,
            err.message
          );
          console.error(err.stack);
        }
      }
    } else {
      console.error(
        `[BridgeRelay] Empty media buffer (${direction}) type=${msgType}`
      );
    }

    // Native / page forward fallback
    try {
      console.log('[BridgeRelay] Trying page/native forward…');
      const forwarded = await this.nativeForward(message, destCandidates, {
        skipTyping: true,
      });
      if (forwarded) {
        bindDest(forwarded._outboundChatId);
        console.log(`[BridgeRelay] FORWARD OK (${direction})`);
        return;
      }
    } catch (err) {
      console.error('[BridgeRelay] forward error:', err.message);
      console.error(err.stack);
    }

    // One more download+send attempt
    if (!media?.data) {
      try {
        console.log('[BridgeRelay] Retry download after forward fail…');
        media = await this.wa.prepareRelayMedia(message);
        if (media?.data) {
          if (voice) await this.wa.pm.sendRecordingPresence(destChatId);
          else await this.wa.sendTypingPresence(destChatId);
          const sent = await this.wa.sendMedia(destPhone, media, {
            caption: cleanBody || undefined,
            chatId: destChatId,
            skipTyping: true,
            skipPacing: true,
            skipLimiter: true,
            msgType,
          });
          bindDest(sent?._outboundChatId || destChatId);
          console.log(`[BridgeRelay] MEDIA RETRY OK (${direction})`);
          return;
        }
      } catch (err) {
        console.error('[BridgeRelay] media retry failed:', err.message);
        console.error(err.stack);
      }
    }

    if (cleanBody) {
      console.warn(
        `[BridgeRelay] Media failed (${direction}) — caption text only`
      );
      try {
        await this.wa.sendTypingPresence(destChatId);
        await this.wa.sendMessage(destPhone, cleanBody, {
          chatId: destChatId,
          skipTyping: true,
          skipPacing: true,
          skipLimiter: true,
        });
      } catch (err) {
        console.error('[BridgeRelay] caption send failed:', err.message);
        console.error(err.stack);
      }
    }

    console.error(
      `[BridgeRelay] MEDIA RELAY FAILED (${msgType}) ${direction}`
    );
    this.unsee(waId);
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

  async nativeForward(message, destChatIds, opts = {}) {
    if (!message) {
      console.warn('[BridgeRelay] nativeForward: no message');
      return null;
    }
    const msgId = message.id?._serialized || message.id?.id || null;

    for (const chatId of destChatIds) {
      try {
        if (!opts.skipTyping) {
          await this.humanPresenceDelay(chatId, { voice: false });
        } else {
          await this.wa.sendTypingPresence(chatId);
        }

        if (msgId) {
          const ok = await this.wa.pm.forwardMessageById(msgId, chatId);
          if (ok) {
            this.wa._lastOutboundChatId = chatId;
            this.wa.markBotOutbound(chatId, 20000);
            return { ok: true, _outboundChatId: chatId };
          }
        }

        if (typeof message.forward === 'function') {
          await message.forward(chatId);
          this.wa._lastOutboundChatId = chatId;
          this.wa.markBotOutbound(chatId, 20000);
          return { ok: true, _outboundChatId: chatId };
        }
      } catch (err) {
        console.error(
          `[BridgeRelay] forward → ${chatId} failed:`,
          err.message
        );
        console.error(err.stack);
      }
    }
    return null;
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
