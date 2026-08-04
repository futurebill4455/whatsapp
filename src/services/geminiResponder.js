/**
 * Trigger-based Gemini AI insurance assistant (WhatsApp).
 *
 * Flow:
 *  1. User sends trigger (default PLAN) → session starts + varied Malayalam greeting (voice)
 *  2. User asks plan details (text or voice note) → Gemini → Malayalam voice-note reply
 *  3. User sends CLS / close → session ends, chat returns to normal
 *
 * Never intercepts access-code unlock, live desk bridge, or campaigns.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MessageMedia } = require('whatsapp-web.js');
const { Settings } = require('../models');
const logger = require('../utils/logger');

const HISTORY_TURNS = 10;
const HISTORY_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_PEERS = 400;

/** Malayalam opener pool — pick randomly so greetings never feel scripted. */
const GREETING_POOL = [
  'നമസ്കാരം! ഏത് പ്ലാനിന്റെ ഡീറ്റെയിൽസ് ആണ് വേണ്ടത്? ഉദാഹരണത്തിന് സ്റ്റാർ ഹെൽത്ത് അഷ്വർ പോലെ പറയൂ.',
  'ഹായ്! ഇൻഷുറൻസ് പ്ലാൻ വിവരം വേണമെങ്കിൽ പറയൂ — ഏത് പ്ലാനിന്റെ വിശദാംശങ്ങൾ ആണ് നോക്കേണ്ടത്?',
  'സ്വാഗതം. ഏതു പ്ലാനിനെക്കുറിച്ചാണ് അറിയേണ്ടത്? പേരോ കമ്പനിയോ പറഞ്ഞാൽ മതി.',
  'നമസ്കാരം — ഏത് പ്ലാനിന്റെ ഡീറ്റെയിൽസ് വേണം? വോയ്സ് നോട്ടോ ടെക്സ്റ്റോ അയച്ചോളൂ.',
  'ഹലോ! പ്ലാൻ ഡീറ്റെയിൽസ് ചോദിക്കാം. ഏതാണ് വേണ്ടത് എന്ന് പറയൂ.',
  'സുഖമാണോ? ഏത് ഇൻഷുറൻസ് പ്ലാനിന്റെ വിവരമാണ് വേണ്ടത് എന്ന് ഒന്ന് പറയൂ.',
  'നമസ്കാരം! ഏത് പ്ലാനിന്റെ വിശദാംശങ്ങൾ ആണ് വേണ്ടത്? ഉദാ: സ്റ്റാർ ഹെൽത്ത് അഷ്വർ.',
  'ഹായ്, പ്ലാൻ അസിസ്റ്റന്റ് റെഡി. ഏതു പ്ലാനിനെക്കുറിച്ച് വിശദീകരിക്കണം?',
];

const CLOSE_ACK_POOL = [
  'ശരി, അസിസ്റ്റന്റ് സെഷൻ അടച്ചു. വീണ്ടും തുടങ്ങാൻ *PLAN* അയക്കുക.',
  'OK — AI സെഷൻ ക്ലോസ് ചെയ്തു. വീണ്ടും വേണമെങ്കിൽ *PLAN* അയക്കൂ.',
  'സെഷൻ അവസാനിപ്പിച്ചു. പിന്നീട് പ്ലാൻ വിവരം വേണമെങ്കിൽ *PLAN* അയക്കുക.',
];

/** @type {Map<string, { active: boolean, startedAt: number, updatedAt: number }>} */
const _sessions = new Map();
/** @type {Map<string, { turns: {role:string,text:string}[], updatedAt: number }>} */
const _history = new Map();
/** @type {Map<string, number>} */
const _lastReplyAt = new Map();
/** @type {Map<string, number>} */
const _lastGreetingIdx = new Map();

function enabled() {
  const flag = Settings.get('gemini_enabled');
  if (flag === '0' || flag === 'false') return false;
  return !!getApiKey();
}

function getApiKey() {
  const fromEnv = String(process.env.GEMINI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return String(Settings.get('gemini_api_key') || '').trim();
}

function getModelName() {
  return (
    String(process.env.GEMINI_MODEL || '').trim() ||
    String(Settings.get('gemini_model') || '').trim() ||
    'gemini-2.0-flash'
  );
}

function getTtsModel() {
  return (
    String(process.env.GEMINI_TTS_MODEL || '').trim() ||
    String(Settings.get('gemini_tts_model') || '').trim() ||
    'gemini-2.5-flash-preview-tts'
  );
}

function getTtsVoice() {
  return (
    String(Settings.get('gemini_tts_voice') || '').trim() || 'Kore'
  );
}

function getTriggerCode() {
  return (
    String(Settings.get('gemini_trigger_code') || '').trim().toUpperCase() ||
    'PLAN'
  );
}

function getCloseKeywords() {
  const raw = Settings.get('close_keywords') || 'close,cls';
  return String(raw)
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeMsg(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

function isCloseCommand(text) {
  const n = normalizeMsg(text);
  if (!n) return false;
  return getCloseKeywords().some((k) => n === k);
}

function isTrigger(text) {
  const n = String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toUpperCase();
  if (!n) return false;
  return n === getTriggerCode();
}

function peerKey(phoneOrChat) {
  return (
    String(phoneOrChat || '')
      .replace(/\D/g, '')
      .slice(-15) || String(phoneOrChat || '').trim()
  );
}

function pruneMaps() {
  const now = Date.now();
  for (const [k, v] of _sessions) {
    if (!v?.active || now - (v.updatedAt || v.startedAt) > SESSION_TTL_MS) {
      _sessions.delete(k);
      _history.delete(k);
    }
  }
  for (const [k, v] of _history) {
    if (!v || now - v.updatedAt > HISTORY_TTL_MS) _history.delete(k);
  }
  while (_sessions.size > MAX_PEERS) {
    const oldest = _sessions.keys().next().value;
    _sessions.delete(oldest);
    _history.delete(oldest);
  }
}

function hasSession(phoneOrChat) {
  pruneMaps();
  const key = peerKey(phoneOrChat);
  const row = _sessions.get(key);
  return !!(row && row.active);
}

function startSession(phoneOrChat) {
  const key = peerKey(phoneOrChat);
  const now = Date.now();
  _sessions.set(key, { active: true, startedAt: now, updatedAt: now });
  _history.delete(key);
  logger.info(`[Gemini] session START peer=${key}`);
  return key;
}

function endSession(phoneOrChat) {
  const key = peerKey(phoneOrChat);
  _sessions.delete(key);
  _history.delete(key);
  _lastReplyAt.delete(key);
  logger.info(`[Gemini] session END peer=${key}`);
  return key;
}

function touchSession(key) {
  const row = _sessions.get(key);
  if (row) {
    row.updatedAt = Date.now();
    _sessions.set(key, row);
  }
}

function getHistory(key) {
  pruneMaps();
  const row = _history.get(key);
  return row?.turns ? [...row.turns] : [];
}

function pushHistory(key, role, text) {
  const t = String(text || '').trim();
  if (!t || !key) return;
  const prev = _history.get(key)?.turns || [];
  const turns = [...prev, { role, text: t.slice(0, 2000) }].slice(
    -HISTORY_TURNS
  );
  _history.set(key, { turns, updatedAt: Date.now() });
}

function pickGreeting(key) {
  const last = _lastGreetingIdx.get(key);
  let idx = Math.floor(Math.random() * GREETING_POOL.length);
  if (GREETING_POOL.length > 1 && idx === last) {
    idx = (idx + 1) % GREETING_POOL.length;
  }
  _lastGreetingIdx.set(key, idx);
  return GREETING_POOL[idx];
}

function pickCloseAck() {
  return CLOSE_ACK_POOL[Math.floor(Math.random() * CLOSE_ACK_POOL.length)];
}

function getPlanSystemPrompt(businessName) {
  const custom = String(Settings.get('gemini_system_prompt') || '').trim();
  if (custom) {
    return custom.replace(/\{\{\s*business_name\s*\}\}/gi, businessName);
  }
  return (
    `You are a warm insurance plan advisor for ${businessName} on WhatsApp voice notes.\n` +
    `Reply ONLY in clear spoken Malayalam (മലയാളം script). Keep it conversational for listening — short sentences, no markdown, no bullet symbols, no emoji spam.\n` +
    `When the user names a plan (e.g. Star Health Assure), explain coverage themes, who it suits, waiting periods, typical benefits, and what to verify with an agent — in 45–90 seconds of speech (~120–220 words).\n` +
    `Do NOT invent exact premiums, policy numbers, claim approvals, or guarantee eligibility.\n` +
    `If the plan name is unclear, ask one short clarifying question in Malayalam.\n` +
    `If they ask to buy / fill a form, tell them to send the team's access code.\n` +
    `To end the AI chat they can send CLS.`
  );
}

function rateLimited(key) {
  const minGap = Number(Settings.get('gemini_min_gap_ms')) || 2500;
  const last = _lastReplyAt.get(key) || 0;
  return Date.now() - last < minGap;
}

function isVoiceMessage(message) {
  const t = String(message?.type || '').toLowerCase();
  return t === 'ptt' || t === 'audio';
}

/**
 * Whether this inbound belongs to the AI session pipeline (trigger, active turn, or voice in session).
 */
function ownsInbound({ body, message, phone, chatId } = {}) {
  if (!enabled()) return false;
  const key = peerKey(phone || chatId);
  const text = String(body || '').trim();

  if (isTrigger(text)) return true;
  if (!hasSession(key)) return false;

  if (text && isCloseCommand(text)) return true;
  if (text) return true;
  if (isVoiceMessage(message)) return true;
  return false;
}

function pcmToWav(pcmBuf, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const pcm = Buffer.isBuffer(pcmBuf) ? pcmBuf : Buffer.from(pcmBuf);
  const blockAlign = (numChannels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Gemini native TTS → WAV MessageMedia. Falls back to Google Translate TTS (mp3).
 */
async function synthesizeSpeech(text) {
  const clean = String(text || '')
    .replace(/\*+/g, '')
    .replace(/[_`#]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 3500);
  if (!clean) return null;

  const apiKey = getApiKey();
  if (apiKey) {
    try {
      const model = encodeURIComponent(getTtsModel());
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const prompt =
        `Say the following naturally in Malayalam, warm and clear, as a helpful insurance advisor voice note:\n\n${clean}`;
      const res = await Promise.race([
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: getTtsVoice() },
                },
              },
            },
          }),
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('tts_timeout')), 45000)
        ),
      ]);

      if (res.ok) {
        const json = await res.json();
        const part =
          json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData) ||
          json?.candidates?.[0]?.content?.parts?.[0];
        const b64 = part?.inlineData?.data;
        const mime = String(part?.inlineData?.mimeType || '');
        if (b64) {
          const raw = Buffer.from(b64, 'base64');
          // Gemini TTS returns raw PCM (s16le 24k) or occasionally wrapped audio
          if (/wav/i.test(mime)) {
            return new MessageMedia('audio/wav', b64, 'reply.wav');
          }
          if (/mpeg|mp3/i.test(mime)) {
            return new MessageMedia('audio/mpeg', b64, 'reply.mp3');
          }
          if (/ogg|opus/i.test(mime)) {
            return new MessageMedia('audio/ogg; codecs=opus', b64, 'reply.ogg');
          }
          const wav = pcmToWav(raw, 24000, 1, 16);
          return new MessageMedia(
            'audio/wav',
            wav.toString('base64'),
            'reply.wav'
          );
        }
      } else {
        const errText = await res.text().catch(() => '');
        logger.warn(
          `[Gemini] TTS HTTP ${res.status}: ${errText.slice(0, 200)}`
        );
      }
    } catch (err) {
      logger.warn('[Gemini] TTS failed:', err.message);
    }
  }

  // Fallback: Translate TTS mp3 (Malayalam)
  try {
    const chunks = [];
    const maxLen = 160;
    for (let i = 0; i < clean.length; i += maxLen) {
      chunks.push(clean.slice(i, i + maxLen));
    }
    const buffers = [];
    for (const chunk of chunks.slice(0, 8)) {
      const u = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ml&q=${encodeURIComponent(chunk)}`;
      const r = await fetch(u, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (!r.ok) throw new Error(`gtts_http_${r.status}`);
      buffers.push(Buffer.from(await r.arrayBuffer()));
      await new Promise((r2) => setTimeout(r2, 120));
    }
    if (!buffers.length) return null;
    const mp3 = Buffer.concat(buffers);
    return new MessageMedia('audio/mpeg', mp3.toString('base64'), 'reply.mp3');
  } catch (err) {
    logger.warn('[Gemini] fallback TTS failed:', err.message);
    return null;
  }
}

async function transcribeInboundVoice(whatsapp, message) {
  try {
    const media =
      (await whatsapp.downloadMediaWithRetry?.(message, 6)) ||
      (await message.downloadMedia?.());
    if (!media?.data) {
      logger.warn('[Gemini] voice download empty');
      return null;
    }
    let mime = String(media.mimetype || 'audio/ogg').split(';')[0].trim();
    if (mime === 'audio/ogg') mime = 'audio/ogg';
    const apiKey = getApiKey();
    if (!apiKey) return null;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: getModelName() });
    const result = await Promise.race([
      model.generateContent([
        {
          inlineData: {
            data: media.data,
            mimeType: media.mimetype || mime,
          },
        },
        {
          text:
            'Transcribe this WhatsApp voice note accurately. ' +
            'If spoken in Malayalam, write Malayalam script. ' +
            'If English/mixed, keep as spoken. Return ONLY the transcript text.',
        },
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stt_timeout')), 40000)
      ),
    ]);
    const text = String(result?.response?.text?.() || '')
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .trim();
    if (!text) return null;
    logger.info(`[Gemini] STT → "${text.slice(0, 80)}"`);
    return text.slice(0, 2000);
  } catch (err) {
    logger.warn('[Gemini] STT failed:', err.message);
    return null;
  }
}

async function generatePlanReply({ key, userText, businessName }) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const brand =
    businessName ||
    Settings.get('business_name', 'SecureLife Insurance') ||
    'SecureLife Insurance';

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: getModelName(),
      systemInstruction: getPlanSystemPrompt(brand),
      generationConfig: {
        temperature: 0.75,
        topP: 0.95,
        maxOutputTokens: 900,
      },
    });

    const history = getHistory(key);
    const contents = [];
    for (const turn of history) {
      contents.push({
        role: turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      });
    }
    contents.push({ role: 'user', parts: [{ text: userText }] });

    const result = await Promise.race([
      model.generateContent({ contents }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('gemini_timeout')), 35000)
      ),
    ]);

    const reply = String(result?.response?.text?.() || '')
      .replace(/\r\n/g, '\n')
      .replace(/^```[\s\S]*?```$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 2500);

    if (!reply) return null;

    pushHistory(key, 'user', userText);
    pushHistory(key, 'model', reply);
    _lastReplyAt.set(key, Date.now());
    touchSession(key);
    return reply;
  } catch (err) {
    logger.warn('[Gemini] plan generate failed:', err.message);
    return null;
  }
}

async function sendVoiceNote(whatsapp, { phone, chatId, text, message }) {
  const media = await synthesizeSpeech(text);
  if (!media) {
    // Text fallback if TTS unavailable
    await whatsapp.sendMessage(phone || chatId, text, {
      chatId: chatId || undefined,
      replyTo: message || undefined,
      lane: 'core',
      skipPacing: false,
    });
    return { voice: false, text: true };
  }

  try {
    await whatsapp.sendMedia(phone || chatId, media, {
      chatId: chatId || undefined,
      sendAudioAsVoice: true,
      msgType: 'ptt',
      lane: 'core',
      once: true,
      caption: undefined,
    });
    return { voice: true, text: false };
  } catch (err) {
    logger.warn('[Gemini] voice send failed, text fallback:', err.message);
    await whatsapp.sendMessage(phone || chatId, text, {
      chatId: chatId || undefined,
      replyTo: message || undefined,
      lane: 'core',
    });
    return { voice: false, text: true };
  }
}

/**
 * Immediate CLS close for an active AI session.
 */
async function closeAndAck(whatsapp, { phone, chatId, message }) {
  const key = endSession(phone || chatId);
  const ack = pickCloseAck();
  try {
    await whatsapp.sendMessage(phone || chatId, ack, {
      chatId: chatId || undefined,
      replyTo: message || undefined,
      lane: 'core',
      skipPacing: true,
      skipTyping: false,
    });
  } catch (err) {
    logger.warn('[Gemini] close ack failed:', err.message);
  }
  return { handled: true, reason: 'gemini_cls', peer: key };
}

/**
 * Run one session turn after smart delay: trigger greeting OR plan voice reply.
 */
async function handleSessionTurn(
  whatsapp,
  { phone, chatId, body, message } = {}
) {
  if (!whatsapp?.ready || !enabled()) return false;

  const key = peerKey(phone || chatId);
  const text = String(body || '').trim();

  // CLS (also handled early, but keep as safety)
  if (hasSession(key) && isCloseCommand(text)) {
    await closeAndAck(whatsapp, { phone, chatId, message });
    return true;
  }

  // Trigger → start + varied greeting (voice)
  if (isTrigger(text)) {
    startSession(key);
    const greeting = pickGreeting(key);
    pushHistory(key, 'model', greeting);
    _lastReplyAt.set(key, Date.now());

    try {
      if (chatId && whatsapp.pm?.sendRecordingPresence) {
        await whatsapp.pm.sendRecordingPresence(chatId);
      }
    } catch (_) {}

    await sendVoiceNote(whatsapp, {
      phone,
      chatId,
      text: greeting,
      message,
    });
    return true;
  }

  if (!hasSession(key)) return false;
  if (rateLimited(key)) {
    logger.debug(`[Gemini] rate-limited peer=${key}`);
    return true; // still "ours" — stay silent briefly
  }

  let userText = text;
  if (isVoiceMessage(message) && !userText) {
    userText = await transcribeInboundVoice(whatsapp, message);
    if (!userText) {
      await sendVoiceNote(whatsapp, {
        phone,
        chatId,
        text: 'ക്ഷമിക്കണം, വോയ്സ് കൃത്യമായി കേൾക്കാൻ പറ്റിയില്ല. ഒന്നുകൂടി പറയാമോ, അല്ലെങ്കിൽ ടൈപ്പ് ചെയ്യാം.',
        message,
      });
      return true;
    }
  }

  if (!userText) return false;

  try {
    if (chatId && whatsapp.pm?.sendRecordingPresence) {
      await whatsapp.pm.sendRecordingPresence(chatId);
    }
  } catch (_) {}

  const reply = await generatePlanReply({
    key,
    userText,
    businessName: Settings.get('business_name', 'SecureLife Insurance'),
  });

  if (!reply) {
    await whatsapp.sendMessage(
      phone || chatId,
      'ക്ഷമിക്കണം, ഇപ്പോൾ മറുപടി തയ്യാറാക്കാൻ പറ്റിയില്ല. അല്പസമയം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കൂ.',
      { chatId: chatId || undefined, lane: 'core', skipPacing: true }
    );
    return true;
  }

  await sendVoiceNote(whatsapp, { phone, chatId, text: reply, message });
  return true;
}

module.exports = {
  enabled,
  getApiKey,
  getModelName,
  getTriggerCode,
  hasSession,
  startSession,
  endSession,
  ownsInbound,
  isTrigger,
  isCloseCommand,
  closeAndAck,
  handleSessionTurn,
  sendVoiceNote,
  // legacy aliases (unused after refactor)
  shouldRespond: () => false,
  replyViaWhatsApp: async () => false,
  looksLikeGreeting: () => false,
  pushHistory,
};
