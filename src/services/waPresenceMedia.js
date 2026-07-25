/**
 * Reliable typing presence + media download helpers for whatsapp-web.js.
 * Prefer WWebJS.sendChatstate / Store downloads over fragile Chat.getChatById paths.
 */
const { MessageMedia } = require('whatsapp-web.js');
const antiBan = require('./antiBan');

function sleep(ms) {
  return antiBan.sleep(ms);
}

/**
 * @param {import('./whatsapp')} wa - WhatsAppService instance
 */
function createPresenceMediaHelpers(wa) {
  async function sendTypingPresence(chatId) {
    const id = String(chatId || '').trim();
    if (!id || !wa.client?.pupPage) {
      console.warn('[Typing] skip — missing chatId or pupPage', {
        id: id || null,
      });
      return false;
    }
    try {
      const ok = await wa.client.pupPage.evaluate(async (cid) => {
        try {
          if (window.WWebJS?.sendChatstate) {
            await window.WWebJS.sendChatstate('typing', cid);
            return { ok: true, via: 'WWebJS.sendChatstate' };
          }
          const wid = window.require?.('WAWebWidFactory')?.createWid?.(cid);
          const ChatState = window.require?.('WAWebChatStateBridge');
          if (wid && ChatState?.sendChatStateComposing) {
            await ChatState.sendChatStateComposing(wid);
            return { ok: true, via: 'ChatState.sendChatStateComposing' };
          }
          return { ok: false, via: 'missing_api' };
        } catch (e) {
          return { ok: false, error: String(e?.message || e) };
        }
      }, id);
      if (ok?.ok) {
        console.log(`[Typing] composing → ${id} (${ok.via})`);
        return true;
      }
      console.warn(`[Typing] failed → ${id}:`, ok?.error || ok?.via || ok);
      return false;
    } catch (err) {
      console.error(`[Typing] evaluate error → ${id}:`, err.message);
      console.error(err.stack);
      return false;
    }
  }

  async function showTypingFor(chatId, durationMs) {
    const ms = Math.max(1000, Math.min(30000, Number(durationMs) || 2000));
    const id = String(chatId || '').trim();
    console.log(`[Typing] start ${ms}ms for ${id || '(none)'}`);

    if (!id || !wa.client) {
      console.warn('[Typing] no chatId/client — sleeping without indicator');
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
      console.warn('[Typing] openChatWindow:', err.message);
    }

    while (Date.now() - started < ms) {
      lastOk = await sendTypingPresence(id);
      if (!lastOk) {
        try {
          const chat = await wa.client.getChatById(id);
          if (chat?.sendStateTyping) {
            await chat.sendStateTyping();
            lastOk = true;
            pulses += 1;
            console.log(`[Typing] Chat.sendStateTyping OK → ${id}`);
          } else {
            console.warn(`[Typing] chat has no sendStateTyping → ${id}`);
          }
        } catch (err) {
          console.warn(
            `[Typing] getChatById/sendStateTyping → ${id}:`,
            err.message
          );
        }
      } else {
        pulses += 1;
      }
      const remaining = ms - (Date.now() - started);
      // Refresh before WhatsApp's ~25s composing expiry
      await sleep(Math.min(12000, Math.max(500, remaining)));
    }

    lastOk = (await sendTypingPresence(id)) || lastOk;
    console.log(
      `[Typing] done ${ms}ms → ${id} pulses=${pulses} lastOk=${lastOk}`
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
          `[Media] reloaded ${msgId} hasMedia=${!!fresh.hasMedia} type=${fresh.type || '?'}`
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

          if (msg.mediaData && msg.mediaData.mediaStage !== 'RESOLVED') {
            try {
              await msg.downloadMedia({
                downloadEvenIfExpensive: true,
                rmrReason: 1,
              });
            } catch (_) {}
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
            return { error: 'decrypt_failed:' + (e?.message || e) };
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
          };
        } catch (e) {
          return { error: String(e?.message || e) };
        }
      }, serialized);

      if (result?.error || !result?.data) {
        console.error(
          '[Media] meta download result:',
          result?.error || 'empty'
        );
        return null;
      }
      return new MessageMedia(
        result.mimetype || 'application/octet-stream',
        result.data,
        result.filename || undefined
      );
    } catch (err) {
      console.error('[Media] meta download evaluate failed:', err.message);
      console.error(err.stack);
      return null;
    }
  }

  async function downloadMediaWithRetry(message, tries = 8) {
    let msg = message;
    for (let i = 1; i <= tries; i++) {
      try {
        if (i === 1 || i === 3 || i === 5) {
          msg = await reloadMessageForMedia(msg);
        }

        if (!msg.hasMedia) {
          console.warn(
            `[Media] hasMedia=false try ${i}/${tries} type=${msg.type || '?'} — forcing Store resolve`
          );
          await forceResolveMediaOnPage(msg);
          msg = await reloadMessageForMedia(msg);
        }

        if (typeof msg.downloadMedia === 'function' && msg.hasMedia) {
          const media = await msg.downloadMedia();
          if (media?.data) {
            console.log(
              `[Media] downloadMedia OK try ${i} mime=${media.mimetype || '?'} b64len=${String(media.data).length}`
            );
            return media;
          }
          console.warn(`[Media] downloadMedia empty try ${i}`);
        }
      } catch (err) {
        console.error(`[Media] downloadMedia try ${i}/${tries}:`, err.message);
        console.error(err.stack);
      }
      await sleep(400 * i);
    }

    try {
      const media = await downloadMediaFromMessageMeta(message);
      if (media?.data) {
        console.log('[Media] Store meta download OK');
        return media;
      }
    } catch (err) {
      console.error('[Media] meta download failed:', err.message);
      console.error(err.stack);
    }

    console.error('[Media] all download attempts failed');
    return null;
  }

  async function prepareRelayMedia(message) {
    if (!message) {
      console.error('[Media] prepareRelayMedia: no message');
      return null;
    }
    try {
      const media = await downloadMediaWithRetry(message, 8);
      if (!media?.data) {
        console.error('[Media] prepareRelayMedia: empty buffer');
        return null;
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
          filename = 'image.jpg';
        } else if (type === 'video' || /^video\//i.test(mimetype)) {
          filename = 'video.mp4';
        } else if (
          type === 'ptt' ||
          type === 'audio' ||
          /^audio\//i.test(mimetype)
        ) {
          filename = 'audio.ogg';
        }
      }

      const out = new MessageMedia(mimetype, media.data, filename || undefined);
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

  return {
    sendTypingPresence,
    showTypingFor,
    reloadMessageForMedia,
    forceResolveMediaOnPage,
    downloadMediaFromMessageMeta,
    downloadMediaWithRetry,
    prepareRelayMedia,
  };
}

module.exports = { createPresenceMediaHelpers };
