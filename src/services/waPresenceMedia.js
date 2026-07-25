/**
 * Reliable typing presence + media download helpers for whatsapp-web.js.
 * Prefer WWebJS.sendChatstate / Store downloads over fragile Chat.getChatById paths.
 */
const { MessageMedia } = require('whatsapp-web.js');
const antiBan = require('./antiBan');

function sleep(ms) {
  return antiBan.sleep(ms);
}

/** Types that always carry downloadable media in WA Web. */
const MEDIA_TYPES = new Set([
  'image',
  'video',
  'document',
  'ptt',
  'audio',
  'sticker',
  'gif',
]);

/**
 * Aggressive media detection — never rely only on message.hasMedia
 * (hasMedia === Boolean(directPath) and can be false until Store resolves).
 */
function isMediaLikeMessage(message) {
  if (!message) return false;
  const type = String(message.type || '').toLowerCase();
  if (MEDIA_TYPES.has(type)) return true;
  if (message.hasMedia) return true;
  const data = message._data || {};
  if (data.directPath || data.mediaKey || data.filehash || data.encFilehash) {
    return true;
  }
  if (data.mimetype || data.filename) return true;
  if (data.mediaData?.mediaStage) return true;
  return false;
}

function mediaFingerprint(message) {
  const data = message?._data || {};
  return {
    type: message?.type || null,
    hasMedia: !!message?.hasMedia,
    mimetype: data.mimetype || null,
    filename: data.filename || null,
    directPath: !!data.directPath,
    mediaKey: !!data.mediaKey,
    mediaStage: data.mediaData?.mediaStage || null,
    id: message?.id?._serialized || message?.id?.id || null,
  };
}

/**
 * Build ordered send-option attempts for image / pdf / doc / voice / video / sticker.
 * First matching set is preferred; callers should try each until one succeeds.
 */
function buildMediaSendOptionSets(msgType, media, caption) {
  const type = String(msgType || '').toLowerCase();
  const mime = String(media?.mimetype || '');
  const filename = String(media?.filename || '');
  const cap = caption || undefined;
  const sets = [];

  const push = (opts, label) => {
    sets.push({ ...opts, _label: label });
  };

  const isVoice =
    type === 'ptt' ||
    type === 'audio' ||
    /^audio\//i.test(mime) ||
    /\.(ogg|opus|m4a|mp3|wav)$/i.test(filename);
  const isDoc =
    type === 'document' ||
    /pdf|msword|sheet|zip|octet-stream|officedocument|ms-excel|ms-powerpoint/i.test(
      mime
    ) ||
    /\.pdf$/i.test(filename);
  const isSticker = type === 'sticker';
  const isGif = type === 'gif';
  const isImage = type === 'image' || /^image\//i.test(mime);
  const isVideo = type === 'video' || /^video\//i.test(mime);

  if (isVoice) {
    push({ caption: cap, sendAudioAsVoice: true }, 'voice');
    push({ caption: cap, sendAudioAsVoice: false }, 'audio_file');
    push({ caption: cap, sendMediaAsDocument: true }, 'audio_as_document');
  } else if (isSticker) {
    push({ sendMediaAsSticker: true }, 'sticker');
    push({ caption: cap, sendMediaAsDocument: true }, 'sticker_as_document');
  } else if (isGif) {
    push({ caption: cap, sendVideoAsGif: true }, 'gif');
    push({ caption: cap }, 'video');
  } else if (isDoc) {
    push({ caption: cap, sendMediaAsDocument: true }, 'document');
  } else if (isImage) {
    push({ caption: cap }, 'image');
    push({ caption: cap, sendMediaAsDocument: true }, 'image_as_document');
  } else if (isVideo) {
    push({ caption: cap }, 'video');
    push({ caption: cap, sendMediaAsDocument: true }, 'video_as_document');
  } else {
    push({ caption: cap }, 'generic');
    push({ caption: cap, sendMediaAsDocument: true }, 'generic_as_document');
  }

  return sets;
}

/**
 * @param {import('./whatsapp')} wa - WhatsAppService instance
 */
function createPresenceMediaHelpers(wa) {
  async function sendTypingPresence(chatId) {
    return sendChatState(chatId, 'typing');
  }

  async function sendRecordingPresence(chatId) {
    return sendChatState(chatId, 'recording');
  }

  async function sendChatState(chatId, state) {
    const id = String(chatId || '').trim();
    const kind = state === 'recording' ? 'recording' : 'typing';
    if (!id || !wa.client?.pupPage) {
      console.warn(`[Presence] skip ${kind} — missing chatId or pupPage`, {
        id: id || null,
      });
      return false;
    }
    try {
      const ok = await wa.client.pupPage.evaluate(
        async (cid, chatState) => {
          try {
            if (window.WWebJS?.sendChatstate) {
              await window.WWebJS.sendChatstate(chatState, cid);
              return { ok: true, via: 'WWebJS.sendChatstate' };
            }
            const wid = window.require?.('WAWebWidFactory')?.createWid?.(cid);
            const ChatState = window.require?.('WAWebChatStateBridge');
            if (wid && chatState === 'recording' && ChatState?.sendChatStateRecording) {
              await ChatState.sendChatStateRecording(wid);
              return { ok: true, via: 'ChatState.sendChatStateRecording' };
            }
            if (wid && ChatState?.sendChatStateComposing) {
              await ChatState.sendChatStateComposing(wid);
              return { ok: true, via: 'ChatState.sendChatStateComposing' };
            }
            return { ok: false, via: 'missing_api' };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
        id,
        kind
      );
      if (ok?.ok) {
        console.log(`[Presence] ${kind} → ${id} (${ok.via})`);
        return true;
      }
      console.warn(`[Presence] ${kind} failed → ${id}:`, ok?.error || ok?.via || ok);
      return false;
    } catch (err) {
      console.error(`[Presence] ${kind} evaluate error → ${id}:`, err.message);
      console.error(err.stack);
      return false;
    }
  }

  async function showTypingFor(chatId, durationMs) {
    return showPresenceFor(chatId, durationMs, 'typing');
  }

  async function showRecordingFor(chatId, durationMs) {
    return showPresenceFor(chatId, durationMs, 'recording');
  }

  async function showPresenceFor(chatId, durationMs, state = 'typing') {
    const ms = Math.max(1000, Math.min(45000, Number(durationMs) || 2000));
    const id = String(chatId || '').trim();
    const kind = state === 'recording' ? 'recording' : 'typing';
    console.log(`[Presence] start ${kind} ${ms}ms for ${id || '(none)'}`);

    if (!id || !wa.client) {
      console.warn(`[Presence] no chatId/client — sleeping without ${kind}`);
      await sleep(ms);
      return false;
    }

    const started = Date.now();
    let pulses = 0;
    let lastOk = false;

    try {
      if (wa.client.interface?.openChatWindow) {
        await wa.client.interface.openChatWindow(id);
      }
    } catch (err) {
      console.warn('[Presence] openChatWindow:', err.message);
    }

    while (Date.now() - started < ms) {
      lastOk = await sendChatState(id, kind);
      if (!lastOk) {
        try {
          const chat = await wa.client.getChatById(id);
          if (kind === 'recording' && chat?.sendStateRecording) {
            await chat.sendStateRecording();
            lastOk = true;
            pulses += 1;
            console.log(`[Presence] Chat.sendStateRecording OK → ${id}`);
          } else if (chat?.sendStateTyping) {
            await chat.sendStateTyping();
            lastOk = true;
            pulses += 1;
            console.log(`[Presence] Chat.sendStateTyping OK → ${id}`);
          } else {
            console.warn(`[Presence] chat has no state API → ${id}`);
          }
        } catch (err) {
          console.warn(`[Presence] getChatById/${kind} → ${id}:`, err.message);
        }
      } else {
        pulses += 1;
      }
      const remaining = ms - (Date.now() - started);
      await sleep(Math.min(12000, Math.max(500, remaining)));
    }

    lastOk = (await sendChatState(id, kind)) || lastOk;
    console.log(
      `[Presence] done ${kind} ${ms}ms → ${id} pulses=${pulses} lastOk=${lastOk}`
    );
    return lastOk;
  }

  /**
   * WhatsApp serialized ids look like: true_9199…@c.us_3EB0XXXX
   * (3 or 4 underscore-separated parts). Bare hash / object id is INVALID.
   */
  function isValidSerializedMsgId(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!s || s.includes(':') || s.includes('undefined')) return false;
    const parts = s.split('_');
    if (parts.length !== 3 && parts.length !== 4) return false;
    if (parts[0] !== 'true' && parts[0] !== 'false') return false;
    if (!parts[1] || !parts[1].includes('@')) return false;
    if (!parts[2]) return false;
    return true;
  }

  /**
   * Correctly extract/normalize msg.id._serialized for getMessageById.
   * Never returns bare msg.id.id (that causes "Invalid serialized message id").
   */
  function getSerializedMsgId(message) {
    try {
      if (!message) return null;

      const direct = message.id?._serialized;
      if (isValidSerializedMsgId(direct)) return String(direct).trim();

      if (typeof message.id === 'string' && isValidSerializedMsgId(message.id)) {
        return message.id.trim();
      }

      const idObj = message.id && typeof message.id === 'object' ? message.id : null;
      if (idObj) {
        const remote =
          idObj.remote ||
          message.from ||
          message.to ||
          message._data?.from ||
          message._data?.to ||
          null;
        const mid = idObj.id != null ? String(idObj.id) : null;
        const fromMe = idObj.fromMe === true || idObj.fromMe === 'true';
        if (remote && mid) {
          let built = `${fromMe}_${remote}_${mid}`;
          if (idObj.participant) {
            // Some group variants append participant as 4th segment
            const withPart = `${built}_${idObj.participant}`;
            if (isValidSerializedMsgId(withPart)) built = withPart;
          }
          if (isValidSerializedMsgId(built)) {
            try {
              message.id._serialized = built;
            } catch (_) {}
            console.log(`[Media] Built serialized id: ${built}`);
            return built;
          }
        }
      }

      // Last resort: _data.id._serialized
      const dataSer = message._data?.id?._serialized;
      if (isValidSerializedMsgId(dataSer)) return String(dataSer).trim();

      console.warn(
        '[Media] No valid serialized id — raw=',
        JSON.stringify({
          _serialized: message.id?._serialized || null,
          id: message.id?.id || (typeof message.id === 'string' ? message.id : null),
          remote: message.id?.remote || null,
          fromMe: message.id?.fromMe,
          from: message.from || null,
        })
      );
      return null;
    } catch (err) {
      console.error('[Media] getSerializedMsgId error:', err.message);
      return null;
    }
  }

  /**
   * Safe getMessageById — only with validated serialized string.
   * Returns null on invalid id / throw (never crashes).
   */
  async function safeGetMessageById(msgId) {
    if (!isValidSerializedMsgId(msgId)) {
      console.warn(
        `[Media] skip getMessageById — invalid serialized id: ${String(msgId || '').slice(0, 80)}`
      );
      return null;
    }
    if (!wa.client?.getMessageById) return null;
    try {
      const fresh = await wa.client.getMessageById(msgId);
      return fresh || null;
    } catch (err) {
      console.warn(
        `[Media] getMessageById failed (${msgId}):`,
        err.message
      );
      return null;
    }
  }

  /**
   * Fallback: fetch recent chat messages and match by id / timestamp / sender / type.
   */
  async function findMessageViaChatFetch(message, { limit = 5 } = {}) {
    const chatId =
      message.from ||
      message.to ||
      message.id?.remote ||
      message._data?.id?.remote ||
      null;
    if (!chatId || !wa.client?.getChatById) {
      console.warn('[Media] findMessageViaChatFetch: no chatId/client');
      return null;
    }

    const wantId = getSerializedMsgId(message);
    const wantHash =
      message.id?.id != null
        ? String(message.id.id)
        : wantId
          ? wantId.split('_').slice(2).join('_')
          : null;
    const wantTs = Number(message.timestamp || message.t || message._data?.t || 0);
    const wantType = String(message.type || '').toLowerCase();
    const wantFrom = String(message.from || '').trim();

    try {
      console.log(
        `[Media] fetchMessages fallback chat=${chatId} limit=${limit} type=${wantType || '?'} ts=${wantTs || '—'}`
      );
      const chat = await wa.client.getChatById(chatId);
      const recent = await chat.fetchMessages({ limit: Math.max(5, limit) });
      if (!recent?.length) {
        console.warn('[Media] fetchMessages returned empty');
        return null;
      }

      // 1) Exact serialized id
      if (wantId) {
        const byId = recent.find((m) => {
          const id = m?.id?._serialized;
          return id && String(id) === String(wantId);
        });
        if (byId) {
          console.log('[Media] fetchMessages match: exact _serialized');
          return byId;
        }
      }

      // 2) Same hash id segment
      if (wantHash) {
        const byHash = recent.find((m) => {
          const hid = m?.id?.id != null ? String(m.id.id) : null;
          const ser = m?.id?._serialized || '';
          return hid === wantHash || ser.endsWith(`_${wantHash}`);
        });
        if (byHash) {
          console.log('[Media] fetchMessages match: id hash');
          return byHash;
        }
      }

      // 3) Same sender + type + nearest timestamp (media)
      const mediaTypes = MEDIA_TYPES;
      const candidates = recent.filter((m) => {
        if (m.fromMe) return false;
        const t = String(m.type || '').toLowerCase();
        if (wantType && t !== wantType) return false;
        if (!wantType && !mediaTypes.has(t) && !m.hasMedia) return false;
        if (wantFrom && m.from && String(m.from) !== wantFrom) return false;
        return true;
      });

      if (candidates.length === 1) {
        console.log('[Media] fetchMessages match: single sender/type candidate');
        return candidates[0];
      }

      if (candidates.length > 1 && wantTs > 0) {
        candidates.sort(
          (a, b) =>
            Math.abs(Number(a.timestamp || 0) - wantTs) -
            Math.abs(Number(b.timestamp || 0) - wantTs)
        );
        const best = candidates[0];
        const delta = Math.abs(Number(best.timestamp || 0) - wantTs);
        if (delta <= 120) {
          console.log(
            `[Media] fetchMessages match: timestamp±${delta}s type=${best.type}`
          );
          return best;
        }
      }

      // 4) Latest media from same sender
      const latestMedia = recent.find(
        (m) =>
          !m.fromMe &&
          (m.hasMedia || mediaTypes.has(String(m.type || '').toLowerCase())) &&
          (!wantFrom || String(m.from) === wantFrom)
      );
      if (latestMedia) {
        console.log(
          `[Media] fetchMessages match: latest media type=${latestMedia.type}`
        );
        return latestMedia;
      }

      console.warn(
        `[Media] fetchMessages: no match among ${recent.length} message(s)`
      );
      return null;
    } catch (err) {
      console.error('[Media] findMessageViaChatFetch error:', err.message);
      console.error(err.stack);
      return null;
    }
  }

  /**
   * Poll until a usable message instance is available.
   * Never loops forever on invalid ids / msg_not_found.
   */
  async function waitForMessageInStore(message, maxMs = 10000) {
    const started = Date.now();
    let attempt = 0;
    let current = message;
    const maxAttempts = 5; // hard cap — no infinite loop

    // Prefer chat fetch early when id is already invalid
    let msgId = getSerializedMsgId(message);
    if (!msgId) {
      console.warn(
        '[Media] waitForMessageInStore: invalid/missing serialized id — using fetchMessages fallback'
      );
      const viaFetch = await findMessageViaChatFetch(message, { limit: 5 });
      return viaFetch || message;
    }

    console.log(
      `[Media] waitForMessageInStore id=${msgId} max=${maxMs}ms`
    );

    while (Date.now() - started < maxMs && attempt < maxAttempts) {
      attempt += 1;
      try {
        const fresh = await safeGetMessageById(msgId);
        if (fresh) {
          console.log(
            `[Media] Store hit getMessageById attempt=${attempt} hasMedia=${!!fresh.hasMedia}`
          );
          return fresh;
        }

        // Store probe only with valid id
        if (wa.client?.pupPage && isValidSerializedMsgId(msgId)) {
          const storeHit = await wa.client.pupPage.evaluate(async (id) => {
            try {
              const collections = window.require?.('WAWebCollections');
              if (!collections?.Msg) return { found: false, error: 'no_Msg' };
              let msg = collections.Msg.get(id);
              if (!msg) {
                const got = await collections.Msg.getMessagesById([id]);
                msg = got?.messages?.[0] || null;
              }
              if (!msg) return { found: false, error: 'msg_not_found' };
              return {
                found: true,
                hasDirectPath: !!msg.directPath,
                hasMediaKey: !!msg.mediaKey,
                stage: msg.mediaData?.mediaStage || null,
              };
            } catch (e) {
              return { found: false, error: String(e?.message || e) };
            }
          }, msgId);

          console.log(
            `[Media] Store poll #${attempt}:`,
            JSON.stringify(storeHit)
          );

          if (storeHit?.found) {
            const again = await safeGetMessageById(msgId);
            if (again) return again;
            current.hasMedia =
              current.hasMedia ||
              !!(storeHit.hasDirectPath || storeHit.hasMediaKey);
            return current;
          }
        }

        // Fallback every attempt (user asked limit: 5)
        const viaFetch = await findMessageViaChatFetch(current, { limit: 5 });
        if (viaFetch) {
          const fetchedId = getSerializedMsgId(viaFetch);
          if (fetchedId) msgId = fetchedId;
          return viaFetch;
        }
      } catch (err) {
        console.error(
          `[Media] waitForMessageInStore attempt=${attempt}:`,
          err.message
        );
        console.error(err.stack);
        // Invalid id → stop calling getMessageById, go fetch-only
        if (/invalid serialized message id/i.test(String(err.message || ''))) {
          console.warn(
            '[Media] Invalid serialized id — switching to fetchMessages only'
          );
          const viaFetch = await findMessageViaChatFetch(current, { limit: 5 });
          return viaFetch || current;
        }
      }

      const waitMs = 1000 + Math.floor(Math.random() * 500);
      console.log(
        `[Media] not ready — wait ${waitMs}ms (attempt ${attempt}/${maxAttempts})`
      );
      await sleep(waitMs);
    }

    console.warn(
      `[Media] waitForMessageInStore done attempts=${attempt} — final fetchMessages`
    );
    const last = await findMessageViaChatFetch(current, { limit: 5 });
    return last || current;
  }

  async function reloadMessageForMedia(message) {
    const msgId = getSerializedMsgId(message);
    try {
      await sleep(500);
      if (msgId) {
        const fresh = await safeGetMessageById(msgId);
        if (fresh) {
          console.log(
            `[Media] reloaded ${msgId} hasMedia=${!!fresh.hasMedia} type=${fresh.type || '?'}`
          );
          return fresh;
        }
      }
      console.warn(
        `[Media] reload via getMessageById unavailable — fetchMessages fallback`
      );
      const viaFetch = await findMessageViaChatFetch(message, { limit: 5 });
      if (viaFetch) return viaFetch;
      return await waitForMessageInStore(message, 4000);
    } catch (err) {
      console.error('[Media] reloadMessageForMedia failed:', err.message);
      console.error(err.stack);
      try {
        const viaFetch = await findMessageViaChatFetch(message, { limit: 5 });
        if (viaFetch) return viaFetch;
      } catch (_) {}
    }
    return message;
  }

  /**
   * Poll Store until message exists AND directPath/mediaKey are present.
   */
  async function waitUntilMediaReady(message, maxMs = 15000) {
    let msgId = getSerializedMsgId(message);
    if (!wa.client?.pupPage) return message;

    // Invalid id → skip Store poll loop, use fetch fallback
    if (!msgId) {
      console.warn(
        '[Media] waitUntilMediaReady: invalid id — fetchMessages fallback'
      );
      const viaFetch = await findMessageViaChatFetch(message, { limit: 5 });
      return viaFetch || message;
    }

    let current = await waitForMessageInStore(message, Math.min(maxMs, 8000));
    msgId = getSerializedMsgId(current) || msgId;

    if (!isValidSerializedMsgId(msgId)) {
      const viaFetch = await findMessageViaChatFetch(current, { limit: 5 });
      return viaFetch || current;
    }

    const started = Date.now();
    let attempt = 0;
    const maxAttempts = 6;

    while (Date.now() - started < maxMs && attempt < maxAttempts) {
      attempt += 1;
      try {
        const state = await wa.client.pupPage.evaluate(async (id) => {
          try {
            const collections = window.require?.('WAWebCollections');
            let msg =
              collections?.Msg?.get?.(id) ||
              (await collections?.Msg?.getMessagesById?.([id]))?.messages?.[0];
            if (!msg) return { ok: false, error: 'msg_not_found' };

            const stage = msg.mediaData?.mediaStage || null;
            if (stage === 'REUPLOADING' || stage === 'FETCHING') {
              return {
                ok: false,
                waiting: true,
                stage,
                hasDirectPath: !!msg.directPath,
                hasMediaKey: !!msg.mediaKey,
              };
            }

            if ((!msg.directPath || !msg.mediaKey) && msg.downloadMedia) {
              try {
                await msg.downloadMedia({
                  downloadEvenIfExpensive: true,
                  rmrReason: 1,
                });
              } catch (_) {}
            }

            return {
              ok: !!(msg.directPath && msg.mediaKey),
              stage: msg.mediaData?.mediaStage || null,
              hasDirectPath: !!msg.directPath,
              hasMediaKey: !!msg.mediaKey,
              mimetype: msg.mimetype || null,
              type: msg.type || null,
              filename: msg.filename || null,
            };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        }, msgId);

        console.log(`[Media] waitReady #${attempt}:`, JSON.stringify(state));

        if (state?.ok) {
          current = await reloadMessageForMedia(current);
          return current;
        }

        if (state?.error === 'msg_not_found') {
          console.warn(
            `[Media] waitReady #${attempt}: msg_not_found — fetchMessages`
          );
          const viaFetch = await findMessageViaChatFetch(current, { limit: 5 });
          if (viaFetch) {
            current = viaFetch;
            const nid = getSerializedMsgId(viaFetch);
            if (nid) msgId = nid;
          }
        }
      } catch (err) {
        console.warn(`[Media] waitReady error #${attempt}:`, err.message);
        if (/invalid serialized message id/i.test(String(err.message || ''))) {
          const viaFetch = await findMessageViaChatFetch(current, { limit: 5 });
          return viaFetch || current;
        }
      }

      await sleep(1000 + Math.floor(Math.random() * 500));
      const fresh = await safeGetMessageById(msgId);
      if (fresh) current = fresh;
    }

    console.warn(
      `[Media] waitReady timed out after ${Date.now() - started}ms — fetchMessages last resort`
    );
    const last = await findMessageViaChatFetch(current, { limit: 5 });
    return last || current;
  }

  async function forceResolveMediaOnPage(message) {
    const page = wa.client?.pupPage;
    let msgId = getSerializedMsgId(message);
    if (!page) return false;

    if (!msgId) {
      const viaFetch = await findMessageViaChatFetch(message, { limit: 5 });
      if (!viaFetch) return false;
      message = viaFetch;
      msgId = getSerializedMsgId(viaFetch);
      if (!msgId) return false;
    }

    await waitForMessageInStore(message, 4000);
    msgId = getSerializedMsgId(message) || msgId;
    if (!isValidSerializedMsgId(msgId)) return false;

    try {
      const result = await page.evaluate(async (id) => {
        try {
          const collections = window.require?.('WAWebCollections');
          let msg =
            collections?.Msg?.get?.(id) ||
            (await collections?.Msg?.getMessagesById?.([id]))?.messages?.[0];
          if (!msg) return { ok: false, error: 'msg_not_found' };
          if (msg.downloadMedia) {
            await msg.downloadMedia({
              downloadEvenIfExpensive: true,
              rmrReason: 1,
            });
          }
          return {
            ok: true,
            stage: msg.mediaData?.mediaStage || null,
            hasDirectPath: !!msg.directPath,
            mimetype: msg.mimetype || null,
            type: msg.type || null,
          };
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }, msgId);
      console.log('[Media] forceResolve:', JSON.stringify(result));
      if (result?.error === 'msg_not_found') {
        console.warn('[Media] forceResolve: msg_not_found after wait');
        return false;
      }
      return !!result?.ok;
    } catch (err) {
      console.error('[Media] forceResolve failed:', err.message);
      console.error(err.stack);
      return false;
    }
  }

  async function downloadMediaFromMessageMeta(message) {
    const page = wa.client?.pupPage;
    if (!page) {
      console.warn('[Media] no pupPage for meta download');
      return null;
    }
    let serialized = getSerializedMsgId(message);
    if (!serialized) {
      console.warn(
        '[Media] meta download: invalid serialized id — fetchMessages first'
      );
      const viaFetch = await findMessageViaChatFetch(message, { limit: 5 });
      if (!viaFetch) return null;
      message = viaFetch;
      serialized = getSerializedMsgId(viaFetch);
      if (!serialized) {
        console.warn(
          '[Media] meta download: still no valid serialized id after fetch'
        );
        return null;
      }
    }

    message = await waitForMessageInStore(message, 8000);
    serialized = getSerializedMsgId(message) || serialized;
    if (!isValidSerializedMsgId(serialized)) {
      console.warn('[Media] meta download aborted — invalid id', serialized);
      return null;
    }

    console.log(`[Media] Store meta download starting for ${serialized}`);

    const maxMetaTries = 4;
    for (let metaTry = 1; metaTry <= maxMetaTries; metaTry++) {
      try {
        const result = await page.evaluate(async (msgId) => {
          async function toBase64(decrypted) {
            if (!decrypted) return null;
            if (typeof decrypted === 'string') {
              const m = decrypted.match(/^data:[^;]+;base64,(.+)$/i);
              return m ? m[1] : decrypted;
            }

            let ab = null;
            try {
              if (typeof decrypted.arrayBuffer === 'function') {
                ab = await decrypted.arrayBuffer();
              } else if (ArrayBuffer.isView(decrypted)) {
                ab = decrypted.buffer.slice(
                  decrypted.byteOffset,
                  decrypted.byteOffset + decrypted.byteLength
                );
              } else if (decrypted instanceof ArrayBuffer) {
                ab = decrypted;
              } else if (decrypted?.data) {
                return toBase64(decrypted.data);
              }
            } catch (e) {
              return { __error: 'toBase64_cast:' + (e?.message || e) };
            }

            if (!ab) return null;

            if (window.WWebJS?.arrayBufferToBase64Async) {
              try {
                return await window.WWebJS.arrayBufferToBase64Async(ab);
              } catch (_) {}
            }
            if (window.WWebJS?.arrayBufferToBase64) {
              try {
                return window.WWebJS.arrayBufferToBase64(ab);
              } catch (_) {}
            }

            const bytes = new Uint8Array(ab);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + chunk)
              );
            }
            return btoa(binary);
          }

          try {
            const collections = window.require('WAWebCollections');
            let msg = collections.Msg.get(msgId);
            if (!msg) {
              const got = await collections.Msg.getMessagesById([msgId]);
              msg = got?.messages?.[0] || null;
            }
            if (!msg) return { error: 'msg_not_found' };

            const stage = msg.mediaData?.mediaStage || '';
            if (stage === 'REUPLOADING') {
              return { error: 'reuploading', stage };
            }

            if (typeof msg.downloadMedia === 'function') {
              try {
                await msg.downloadMedia({
                  downloadEvenIfExpensive: true,
                  rmrReason: 1,
                });
              } catch (_) {}
            }

            if (!msg.directPath || !msg.mediaKey) {
              return {
                error: 'missing_media_keys',
                hasDirectPath: !!msg.directPath,
                hasMediaKey: !!msg.mediaKey,
                stage: msg.mediaData?.mediaStage || null,
                type: msg.type || null,
                mimetype: msg.mimetype || null,
              };
            }

            let decrypted = null;
            try {
              decrypted = await window
                .require('WAWebDownloadManager')
                .downloadManager.downloadAndMaybeDecrypt({
                  directPath: msg.directPath,
                  encFilehash: msg.encFilehash,
                  filehash: msg.filehash,
                  mediaKey: msg.mediaKey,
                  mediaKeyTimestamp: msg.mediaKeyTimestamp,
                  type: msg.type,
                  signal: new AbortController().signal,
                  downloadQpl: {
                    addAnnotations() {
                      return this;
                    },
                    addPoint() {
                      return this;
                    },
                  },
                });
            } catch (e) {
              return {
                error: 'decrypt_failed:' + (e?.message || e),
                status: e?.status || null,
              };
            }

            if (!decrypted) return { error: 'empty_download' };

            const data = await toBase64(decrypted);
            if (data && data.__error) return { error: data.__error };
            if (!data) {
              return {
                error: 'no_base64',
                ctor: decrypted?.constructor?.name || typeof decrypted,
              };
            }

            return {
              mimetype: msg.mimetype || 'application/octet-stream',
              data,
              filename: msg.filename || undefined,
              filesize: msg.size || undefined,
              dataLen: String(data).length,
            };
          } catch (e) {
            return {
              error: String(e?.message || e),
              stack: String(e?.stack || ''),
            };
          }
        }, serialized);

        if (result?.data) {
          console.log(
            `[Media] meta download OK (try ${metaTry}) mime=${result.mimetype} file=${result.filename || '—'} b64=${result.dataLen || String(result.data).length}`
          );
          return new MessageMedia(
            result.mimetype || 'application/octet-stream',
            result.data,
            result.filename || undefined,
            result.filesize
          );
        }

        const errCode = result?.error || 'empty';
        console.error(
          `[Media] meta download FAILED try ${metaTry}/${maxMetaTries}:`,
          JSON.stringify(result || { error: 'empty' })
        );

        if (
          errCode === 'msg_not_found' ||
          errCode === 'missing_media_keys' ||
          errCode === 'reuploading'
        ) {
          const waitMs = 1000 + Math.floor(Math.random() * 1000);
          console.warn(
            `[Media] ${errCode} — reload + wait ${waitMs}ms then retry meta`
          );
          await sleep(waitMs);
          message = await waitForMessageInStore(message, 5000);
          serialized = getSerializedMsgId(message) || serialized;
          continue;
        }

        return null;
      } catch (err) {
        console.error(
          `[Media] meta download evaluate failed try ${metaTry}:`,
          err.message
        );
        console.error(err.stack);
        await sleep(1200);
        message = await waitForMessageInStore(message, 4000);
        serialized = getSerializedMsgId(message) || serialized;
      }
    }

    return null;
  }

  /**
   * Force hasMedia=true when Store already has directPath (wwebjs early-returns otherwise).
   */
  async function forceHasMediaFlag(message) {
    let msg = message;
    try {
      msg = await reloadMessageForMedia(msg);
      const data = msg._data || {};
      if (!msg.hasMedia && (data.directPath || data.mediaKey)) {
        msg.hasMedia = true;
        console.log(
          '[Media] Forced message.hasMedia=true (directPath/mediaKey on _data)'
        );
      }
      if (!msg.hasMedia) {
        await forceResolveMediaOnPage(msg);
        msg = await reloadMessageForMedia(msg);
        const d2 = msg._data || {};
        if (d2.directPath || d2.mediaKey) {
          msg.hasMedia = true;
          console.log(
            '[Media] Forced message.hasMedia=true after Store resolve'
          );
        }
      }
      const type = String(msg.type || '').toLowerCase();
      if (!msg.hasMedia && MEDIA_TYPES.has(type)) {
        msg.hasMedia = true;
        console.log(
          `[Media] Forced message.hasMedia=true for media type=${type}`
        );
      }
      console.log(
        `[Media] forceHasMedia → hasMedia=${!!msg.hasMedia} type=${msg.type} fp=${JSON.stringify(mediaFingerprint(msg))}`
      );
    } catch (err) {
      console.error('[Media] forceHasMediaFlag:', err.message);
      console.error(err.stack);
    }
    return msg;
  }

  async function downloadMediaWithRetry(message, tries = 8) {
    let msg = message;
    const minTries = Math.max(3, Number(tries) || 8);
    console.log(
      `[Media] ========== DOWNLOAD START ==========\n[Media] fp=${JSON.stringify(mediaFingerprint(msg))}`
    );

    try {
      console.log('[Media] Initial 1.5s settle before first download…');
      await sleep(1500);
      msg = await waitForMessageInStore(msg, 10000);
      msg = await waitUntilMediaReady(msg, 12000);
    } catch (err) {
      console.warn('[Media] pre-download wait failed:', err.message);
      console.warn(err.stack);
    }

    for (let i = 1; i <= minTries; i++) {
      try {
        console.log(`[Media] --- try ${i}/${minTries} ---`);

        try {
          const msgId = getSerializedMsgId(msg);
          if (msgId) {
            const fresh = await safeGetMessageById(msgId);
            if (fresh) {
              msg = fresh;
              console.log(
                `[Media] try ${i}: refreshed via getMessageById hasMedia=${!!msg.hasMedia}`
              );
            } else {
              console.warn(
                `[Media] try ${i}: getMessageById miss — fetchMessages fallback`
              );
              const viaFetch = await findMessageViaChatFetch(msg, { limit: 5 });
              if (viaFetch) msg = viaFetch;
              else msg = await waitForMessageInStore(msg, 4000);
            }
          } else {
            console.warn(
              `[Media] try ${i}: no valid serialized id — fetchMessages only`
            );
            const viaFetch = await findMessageViaChatFetch(msg, { limit: 5 });
            if (viaFetch) msg = viaFetch;
          }
        } catch (err) {
          console.error(
            `[Media] try ${i}: refresh error:`,
            err.message
          );
          console.error(err.stack);
          const viaFetch = await findMessageViaChatFetch(msg, { limit: 5 });
          if (viaFetch) msg = viaFetch;
        }

        msg = await forceHasMediaFlag(msg);

        if (typeof msg.downloadMedia === 'function') {
          if (!msg.hasMedia) {
            msg.hasMedia = true;
            console.warn(
              `[Media] try ${i}: forcing hasMedia=true before downloadMedia()`
            );
          }
          try {
            console.log(`[Media] try ${i}: calling message.downloadMedia()…`);
            const media = await msg.downloadMedia();
            if (media?.data) {
              console.log(
                `[Media] downloadMedia() OK try ${i} mime=${media.mimetype || '?'} b64len=${String(media.data).length} file=${media.filename || '—'}`
              );
              return media;
            }
            console.warn(
              `[Media] downloadMedia() empty try ${i} — will reload + retry`
            );
          } catch (err) {
            const errMsg = String(err?.message || err);
            console.error(`[Media] downloadMedia() threw try ${i}:`, errMsg);
            console.error(err.stack);
            if (/msg_not_found|not found|null/i.test(errMsg)) {
              console.warn(
                `[Media] try ${i}: msg_not_found — reloading from store`
              );
              msg = await waitForMessageInStore(msg, 6000);
            }
          }
        } else {
          console.warn(
            `[Media] try ${i}: message.downloadMedia is not a function`
          );
        }

        console.log(`[Media] try ${i}: Store meta / decrypt path…`);
        const viaMeta = await downloadMediaFromMessageMeta(msg);
        if (viaMeta?.data) {
          console.log(`[Media] Store meta OK on try ${i}`);
          return viaMeta;
        }
        console.warn(
          `[Media] try ${i}: Store meta empty — reload before next attempt`
        );
        msg = await waitForMessageInStore(msg, 4000);
      } catch (err) {
        console.error(
          `[Media] download try ${i}/${minTries} FATAL:`,
          err.message
        );
        console.error(err.stack);
        try {
          msg = await waitForMessageInStore(msg, 4000);
        } catch (_) {}
      }

      const gap = 1000 + Math.floor(Math.random() * 1000);
      console.log(`[Media] backoff ${gap}ms before try ${i + 1}`);
      await sleep(gap);
    }

    console.error(
      `[Media] ========== ALL ${minTries} DOWNLOAD ATTEMPTS FAILED ==========\n[Media] fp=${JSON.stringify(mediaFingerprint(message))}`
    );
    return null;
  }

  async function prepareRelayMedia(message) {
    if (!message) {
      console.error('[Media] prepareRelayMedia: no message');
      return null;
    }
    try {
      console.log(
        `[Media] prepareRelayMedia START type=${message.type} hasMedia=${!!message.hasMedia} id=${message.id?._serialized || '?'}`
      );
      console.log(
        `[Media] prepareRelayMedia fp=${JSON.stringify(mediaFingerprint(message))}`
      );
      const media = await downloadMediaWithRetry(message, 12);
      if (!media?.data) {
        console.error('[Media] prepareRelayMedia: empty buffer after retries');
        return null;
      }

      // Strip accidental data-URL prefix if present
      let rawData = String(media.data);
      const dataUrl = rawData.match(/^data:[^;]+;base64,(.+)$/i);
      if (dataUrl) {
        rawData = dataUrl[1];
        console.log('[Media] stripped data-URL prefix from base64');
      }

      // Validate base64-ish
      if (!/^[A-Za-z0-9+/=\s]+$/.test(rawData.slice(0, 200))) {
        console.error(
          '[Media] prepareRelayMedia: data does not look like base64 (first 40):',
          rawData.slice(0, 40)
        );
      }

      const data = message._data || {};
      const mimetype =
        media.mimetype ||
        data.mimetype ||
        message.mimetype ||
        'application/octet-stream';
      let filename =
        media.filename || data.filename || message.filename || undefined;
      const type = String(message.type || '').toLowerCase();
      if (!filename) {
        if (type === 'document' || /pdf/i.test(mimetype)) {
          filename = /pdf/i.test(mimetype) ? 'document.pdf' : 'file.bin';
        } else if (type === 'image' || /^image\//i.test(mimetype)) {
          filename = /^image\/png/i.test(mimetype) ? 'image.png' : 'image.jpg';
        } else if (
          type === 'video' ||
          /^video\//i.test(mimetype) ||
          type === 'gif'
        ) {
          filename = 'video.mp4';
        } else if (
          type === 'ptt' ||
          type === 'audio' ||
          /^audio\//i.test(mimetype)
        ) {
          filename = 'audio.ogg';
        } else if (type === 'sticker') {
          filename = 'sticker.webp';
        }
      }

      if (/pdf/i.test(mimetype) && filename && !/\.pdf$/i.test(filename)) {
        filename = `${filename}.pdf`;
      }

      const out = new MessageMedia(
        mimetype,
        rawData,
        filename || undefined,
        media.filesize
      );
      console.log(
        `[Media] prepareRelayMedia READY mime=${out.mimetype} file=${out.filename || '—'} b64=${String(out.data).length} instanceof=${out instanceof MessageMedia}`
      );
      return out;
    } catch (err) {
      console.error('[Media] prepareRelayMedia failed:', err.message);
      console.error(err.stack);
      return null;
    }
  }

  /**
   * Verbose inbound media dump for the message listener / relay.
   */
  function logInboundMediaDetails(message, source = 'listener') {
    try {
      const data = message?._data || {};
      console.log(`[Media] ===== INBOUND MEDIA (${source}) =====`);
      console.log(`[Media] type=${message?.type}`);
      console.log(`[Media] hasMedia=${!!message?.hasMedia}`);
      console.log(`[Media] id=${message?.id?._serialized || message?.id?.id || '?'}`);
      console.log(`[Media] from=${message?.from}`);
      console.log(`[Media] mimetype=${data.mimetype || message?.mimetype || '—'}`);
      console.log(`[Media] filename=${data.filename || message?.filename || '—'}`);
      console.log(`[Media] directPath=${!!data.directPath}`);
      console.log(`[Media] mediaKey=${!!data.mediaKey}`);
      console.log(`[Media] filehash=${!!data.filehash}`);
      console.log(`[Media] encFilehash=${!!data.encFilehash}`);
      console.log(`[Media] mediaStage=${data.mediaData?.mediaStage || '—'}`);
      console.log(`[Media] size=${data.size || data.fileLength || '—'}`);
      console.log(`[Media] caption/body="${String(message?.body || '').slice(0, 80)}"`);
      console.log(`[Media] downloadMedia typeof=${typeof message?.downloadMedia}`);
      console.log(`[Media] mediaLike=${isMediaLikeMessage(message)}`);
      console.log(`[Media] ===== END INBOUND MEDIA =====`);
    } catch (err) {
      console.error('[Media] logInboundMediaDetails error:', err.message);
    }
  }

  /**
   * Native WA forward via page — primary path for image/PDF/document relay.
   * Retries once after a short Store hydrate if the first attempt fails.
   */
  async function forwardMessageById(msgId, destChatId) {
    if (!wa.client?.pupPage || !destChatId) {
      console.warn('[Media] forwardMessageById: missing pupPage/destChatId');
      return false;
    }

    // Normalize / validate id (never pass bare hash)
    let id = msgId;
    if (!isValidSerializedMsgId(id)) {
      // Soft skip — callers prefer buffer send; do not throw
      console.warn(
        `[Media] forwardMessageById skipped (invalid id): ${String(msgId || '').slice(0, 80)}`
      );
      return false;
    }
    id = String(id).trim();

    async function attempt(label) {
      console.log(
        `[Media] page forward attempt (${label}) → ${destChatId} id=${id}`
      );
      const result = await wa.client.pupPage.evaluate(
        async (messageId, chatId) => {
          try {
            // Ensure message is present in Store before forward
            const collections = window.require?.('WAWebCollections');
            let msg = collections?.Msg?.get?.(messageId);
            if (!msg) {
              const got = await collections?.Msg?.getMessagesById?.([
                messageId,
              ]);
              msg = got?.messages?.[0] || null;
            }
            if (!msg) {
              return { ok: false, error: 'msg_not_found_before_forward' };
            }

            if (window.WWebJS?.forwardMessage) {
              await window.WWebJS.forwardMessage(chatId, messageId);
              return { ok: true, via: 'WWebJS.forwardMessage' };
            }

            // Fallback: chat.forwardMessages if available
            try {
              const chat =
                (await window.WWebJS.getChat?.(chatId, {
                  getAsModel: false,
                })) || null;
              if (chat?.forwardMessages) {
                await chat.forwardMessages([msg], chat);
                return { ok: true, via: 'chat.forwardMessages' };
              }
            } catch (_) {}

            return { ok: false, error: 'no_forwardMessage' };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
        id,
        destChatId
      );
      return result;
    }

    try {
      let result = await attempt('1');
      if (result?.ok) {
        console.log(
          `[Media] page forward OK → ${destChatId} (${result.via})`
        );
        return true;
      }

      console.warn(
        `[Media] page forward failed try1:`,
        result?.error || result
      );

      // Brief wait + one retry (Store race)
      await sleep(1000 + Math.floor(Math.random() * 500));
      result = await attempt('2');
      if (result?.ok) {
        console.log(
          `[Media] page forward OK (retry) → ${destChatId} (${result.via})`
        );
        return true;
      }

      console.error(
        `[Media] page forward failed → ${destChatId}:`,
        result?.error || result
      );
      return false;
    } catch (err) {
      console.error('[Media] page forward evaluate:', err.message);
      console.error(err.stack);
      return false;
    }
  }

  return {
    MEDIA_TYPES,
    isMediaLikeMessage,
    mediaFingerprint,
    buildMediaSendOptionSets,
    logInboundMediaDetails,
    getSerializedMsgId,
    isValidSerializedMsgId,
    sendTypingPresence,
    sendRecordingPresence,
    showTypingFor,
    showRecordingFor,
    waitForMessageInStore,
    reloadMessageForMedia,
    waitUntilMediaReady,
    forceResolveMediaOnPage,
    forceHasMediaFlag,
    downloadMediaFromMessageMeta,
    downloadMediaWithRetry,
    prepareRelayMedia,
    forwardMessageById,
  };
}

module.exports = {
  createPresenceMediaHelpers,
  MEDIA_TYPES,
  isMediaLikeMessage,
  buildMediaSendOptionSets,
};
