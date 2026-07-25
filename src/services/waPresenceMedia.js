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
   * Resolve serialized message id from a Message-like object.
   */
  function getSerializedMsgId(message) {
    return (
      message?.id?._serialized ||
      (typeof message?.id === 'string' ? message.id : null) ||
      message?.id?.id ||
      null
    );
  }

  /**
   * Poll until the message exists in WA Store (fixes msg_not_found race).
   * Tries getMessageById → Msg.get/getMessagesById → chat.fetchMessages.
   */
  async function waitForMessageInStore(message, maxMs = 12000) {
    const msgId = getSerializedMsgId(message);
    if (!msgId) {
      console.warn('[Media] waitForMessageInStore: no message id');
      return message;
    }

    const chatId =
      message.from ||
      message.to ||
      message.id?.remote ||
      message._data?.id?.remote ||
      null;

    console.log(
      `[Media] waitForMessageInStore ${msgId} (max ${maxMs}ms) chat=${chatId || '—'}`
    );

    const started = Date.now();
    let attempt = 0;
    let current = message;

    while (Date.now() - started < maxMs) {
      attempt += 1;
      try {
        if (wa.client?.getMessageById) {
          try {
            const fresh = await wa.client.getMessageById(msgId);
            if (fresh) {
              console.log(
                `[Media] Store hit via getMessageById attempt=${attempt} hasMedia=${!!fresh.hasMedia} type=${fresh.type}`
              );
              return fresh;
            }
          } catch (err) {
            console.warn(
              `[Media] getMessageById attempt=${attempt}:`,
              err.message
            );
          }
        }

        if (wa.client?.pupPage) {
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
                type: msg.type || null,
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
            const fresh = await wa.client
              .getMessageById(msgId)
              .catch(() => null);
            if (fresh) return fresh;
            current.hasMedia =
              current.hasMedia ||
              !!(storeHit.hasDirectPath || storeHit.hasMediaKey);
            return current;
          }
        }

        if (chatId && wa.client?.getChatById && attempt >= 2) {
          try {
            const chat = await wa.client.getChatById(chatId);
            const recent = await chat.fetchMessages({ limit: 20 });
            const match = (recent || []).find((m) => {
              const id = m?.id?._serialized || m?.id?.id;
              return id && String(id) === String(msgId);
            });
            if (match) {
              console.log(
                `[Media] Found via chat.fetchMessages attempt=${attempt} hasMedia=${!!match.hasMedia}`
              );
              return match;
            }
            console.warn(
              `[Media] fetchMessages attempt=${attempt}: id not in last ${recent?.length || 0}`
            );
          } catch (err) {
            console.warn(
              `[Media] chat.fetchMessages attempt=${attempt}:`,
              err.message
            );
          }
        }
      } catch (err) {
        console.error(
          `[Media] waitForMessageInStore attempt=${attempt}:`,
          err.message
        );
        console.error(err.stack);
      }

      const waitMs = 1000 + Math.floor(Math.random() * 1000);
      console.log(
        `[Media] msg_not_found — waiting ${waitMs}ms before retry #${attempt + 1}`
      );
      await sleep(waitMs);
    }

    console.warn(
      `[Media] waitForMessageInStore timed out after ${Date.now() - started}ms for ${msgId}`
    );
    return current;
  }

  async function reloadMessageForMedia(message) {
    const msgId = getSerializedMsgId(message);
    if (!msgId || !wa.client?.getMessageById) {
      console.warn('[Media] cannot reload — missing message id');
      return message;
    }
    try {
      await sleep(800);
      let fresh = await wa.client.getMessageById(msgId);
      if (!fresh) {
        console.warn(
          `[Media] getMessageById null for ${msgId} — polling Store…`
        );
        fresh = await waitForMessageInStore(message, 6000);
      }
      if (fresh && fresh !== message) {
        console.log(
          `[Media] reloaded ${msgId} hasMedia=${!!fresh.hasMedia} type=${fresh.type || '?'} fp=${JSON.stringify(mediaFingerprint(fresh))}`
        );
        return fresh;
      }
      if (!fresh) {
        console.warn(`[Media] getMessageById still null for ${msgId}`);
      }
    } catch (err) {
      console.error('[Media] getMessageById failed:', err.message);
      console.error(err.stack);
    }
    return message;
  }

  /**
   * Poll Store until message exists AND directPath/mediaKey are present.
   */
  async function waitUntilMediaReady(message, maxMs = 15000) {
    const msgId = getSerializedMsgId(message);
    if (!msgId || !wa.client?.pupPage) return message;

    let current = await waitForMessageInStore(message, Math.min(maxMs, 10000));

    const started = Date.now();
    let attempt = 0;

    while (Date.now() - started < maxMs) {
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
            `[Media] waitReady #${attempt}: msg_not_found — keep polling`
          );
          current = await waitForMessageInStore(current, 3000);
        }
      } catch (err) {
        console.warn(`[Media] waitReady error #${attempt}:`, err.message);
      }

      await sleep(1000 + Math.floor(Math.random() * 1000));
      try {
        const fresh = await wa.client.getMessageById(msgId);
        if (fresh) current = fresh;
      } catch (_) {}
    }

    console.warn(
      `[Media] waitReady timed out after ${Date.now() - started}ms — proceeding with best message instance`
    );
    return current;
  }

  async function forceResolveMediaOnPage(message) {
    const page = wa.client?.pupPage;
    const msgId = getSerializedMsgId(message);
    if (!page || !msgId) return false;

    await waitForMessageInStore(message, 5000);

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
      console.warn('[Media] no serialized id for meta download');
      return null;
    }

    message = await waitForMessageInStore(message, 10000);
    serialized = getSerializedMsgId(message) || serialized;

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
          if (msgId && wa.client?.getMessageById) {
            const fresh = await wa.client.getMessageById(msgId);
            if (fresh) {
              msg = fresh;
              console.log(
                `[Media] try ${i}: refreshed via getMessageById hasMedia=${!!msg.hasMedia}`
              );
            } else {
              console.warn(
                `[Media] try ${i}: getMessageById null — waitForMessageInStore`
              );
              msg = await waitForMessageInStore(msg, 5000);
            }
          }
        } catch (err) {
          console.error(
            `[Media] try ${i}: getMessageById error:`,
            err.message
          );
          console.error(err.stack);
          msg = await waitForMessageInStore(msg, 4000);
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
   * Native WA forward via page (more reliable than message.forward after delays).
   */
  async function forwardMessageById(msgId, destChatId) {
    if (!wa.client?.pupPage || !msgId || !destChatId) return false;
    try {
      const result = await wa.client.pupPage.evaluate(
        async (messageId, chatId) => {
          try {
            if (window.WWebJS?.forwardMessage) {
              await window.WWebJS.forwardMessage(chatId, messageId);
              return { ok: true, via: 'WWebJS.forwardMessage' };
            }
            return { ok: false, error: 'no_forwardMessage' };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
        msgId,
        destChatId
      );
      if (result?.ok) {
        console.log(
          `[Media] page forward OK → ${destChatId} (${result.via})`
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
