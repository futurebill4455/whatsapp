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

  async function reloadMessageForMedia(message) {
    const msgId =
      message?.id?._serialized ||
      (typeof message?.id === 'string' ? message.id : null);
    if (!msgId || !wa.client?.getMessageById) {
      console.warn('[Media] cannot reload — missing message id');
      return message;
    }
    try {
      const fresh = await wa.client.getMessageById(msgId);
      if (fresh) {
        console.log(
          `[Media] reloaded ${msgId} hasMedia=${!!fresh.hasMedia} type=${fresh.type || '?'} fp=${JSON.stringify(mediaFingerprint(fresh))}`
        );
        return fresh;
      }
      console.warn(`[Media] getMessageById null for ${msgId}`);
    } catch (err) {
      console.error('[Media] getMessageById failed:', err.message);
      console.error(err.stack);
    }
    return message;
  }

  /**
   * Poll Store until directPath/mediaKey exist (common right after inbound event).
   */
  async function waitUntilMediaReady(message, maxMs = 12000) {
    const msgId = message?.id?._serialized;
    if (!msgId || !wa.client?.pupPage) return message;

    const started = Date.now();
    let attempt = 0;
    let current = message;

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
              };
            }

            if (!msg.directPath && msg.downloadMedia) {
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

        console.log(
          `[Media] waitReady #${attempt}:`,
          JSON.stringify(state)
        );

        if (state?.ok) {
          current = await reloadMessageForMedia(current);
          return current;
        }
        if (state?.error === 'msg_not_found' && attempt > 3) break;
      } catch (err) {
        console.warn(`[Media] waitReady error #${attempt}:`, err.message);
      }
      await sleep(Math.min(400 * attempt, 1500));
      current = await reloadMessageForMedia(current);
    }

    console.warn(
      `[Media] waitReady timed out after ${Date.now() - started}ms — proceeding anyway`
    );
    return current;
  }

  async function forceResolveMediaOnPage(message) {
    const page = wa.client?.pupPage;
    const msgId = message?.id?._serialized;
    if (!page || !msgId) return false;
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
    const serialized = message.id?._serialized || message.id?.id || null;
    if (!serialized) {
      console.warn('[Media] no serialized id for meta download');
      return null;
    }

    try {
      const result = await page.evaluate(async (msgId) => {
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

          if (msg.mediaData && msg.mediaData.mediaStage !== 'RESOLVED') {
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

          let data = null;
          if (window.WWebJS?.arrayBufferToBase64Async) {
            data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
          } else if (decrypted instanceof ArrayBuffer) {
            const bytes = new Uint8Array(decrypted);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            data = btoa(binary);
          }
          if (!data) return { error: 'no_base64' };

          return {
            mimetype: msg.mimetype || 'application/octet-stream',
            data,
            filename: msg.filename || undefined,
            filesize: msg.size || undefined,
          };
        } catch (e) {
          return { error: String(e?.message || e) };
        }
      }, serialized);

      if (result?.error || !result?.data) {
        console.error(
          '[Media] meta download result:',
          JSON.stringify(result || { error: 'empty' })
        );
        return null;
      }
      console.log(
        `[Media] meta download OK mime=${result.mimetype} file=${result.filename || '—'} b64=${String(result.data).length}`
      );
      return new MessageMedia(
        result.mimetype || 'application/octet-stream',
        result.data,
        result.filename || undefined,
        result.filesize
      );
    } catch (err) {
      console.error('[Media] meta download evaluate failed:', err.message);
      console.error(err.stack);
      return null;
    }
  }

  /**
   * Bypass Message.hasMedia early-return: download via page even when flag is false.
   */
  async function downloadMediaBypassHasMediaFlag(message) {
    const media = await downloadMediaFromMessageMeta(message);
    return media;
  }

  async function downloadMediaWithRetry(message, tries = 10) {
    let msg = message;
    console.log(
      `[Media] download start fp=${JSON.stringify(mediaFingerprint(msg))}`
    );

    try {
      msg = await waitUntilMediaReady(msg, 10000);
    } catch (err) {
      console.warn('[Media] waitUntilMediaReady:', err.message);
    }

    for (let i = 1; i <= tries; i++) {
      try {
        if (i === 1 || i === 3 || i === 5 || i === 8) {
          msg = await reloadMessageForMedia(msg);
          await forceResolveMediaOnPage(msg);
          msg = await reloadMessageForMedia(msg);
        }

        // Official API path when hasMedia is true
        if (typeof msg.downloadMedia === 'function' && msg.hasMedia) {
          const media = await msg.downloadMedia();
          if (media?.data) {
            console.log(
              `[Media] downloadMedia OK try ${i} mime=${media.mimetype || '?'} b64len=${String(media.data).length}`
            );
            return media;
          }
          console.warn(`[Media] downloadMedia empty try ${i}`);
        } else {
          console.warn(
            `[Media] hasMedia=${!!msg.hasMedia} try ${i}/${tries} type=${msg.type || '?'} — using Store meta path`
          );
        }

        // Always try Store decrypt path (works even when hasMedia is false)
        const viaMeta = await downloadMediaBypassHasMediaFlag(msg);
        if (viaMeta?.data) {
          console.log(`[Media] Store meta OK on try ${i}`);
          return viaMeta;
        }
      } catch (err) {
        console.error(`[Media] download try ${i}/${tries}:`, err.message);
        console.error(err.stack);
      }
      await sleep(350 * i);
    }

    console.error(
      `[Media] all download attempts failed fp=${JSON.stringify(mediaFingerprint(message))}`
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
        `[Media] prepareRelayMedia fp=${JSON.stringify(mediaFingerprint(message))}`
      );
      const media = await downloadMediaWithRetry(message, 10);
      if (!media?.data) {
        console.error('[Media] prepareRelayMedia: empty buffer');
        return null;
      }

      // Strip accidental data-URL prefix if present
      let rawData = String(media.data);
      const dataUrl = rawData.match(/^data:[^;]+;base64,(.+)$/i);
      if (dataUrl) rawData = dataUrl[1];

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
        } else if (type === 'video' || /^video\//i.test(mimetype) || type === 'gif') {
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

      // PDFs must keep a .pdf name so WA treats them correctly as documents
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
        `[Media] prepared mime=${out.mimetype} file=${out.filename || '—'} b64=${String(out.data).length}`
      );
      return out;
    } catch (err) {
      console.error('[Media] prepareRelayMedia failed:', err.message);
      console.error(err.stack);
      return null;
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
    sendTypingPresence,
    sendRecordingPresence,
    showTypingFor,
    showRecordingFor,
    reloadMessageForMedia,
    waitUntilMediaReady,
    forceResolveMediaOnPage,
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
