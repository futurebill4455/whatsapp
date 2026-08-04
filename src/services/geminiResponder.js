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
const { toWhatsAppVoiceMedia, pcmToWav, convertAudioForStt, normalizeBase64Audio } = require('./waVoiceMedia');
const antiBan = require('./antiBan');

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

/** Heavier model for plan-detail explanations (default: gemini-2.5-flash). */
function getPlanModelName() {
  return (
    String(process.env.GEMINI_PLAN_MODEL || '').trim() ||
    String(Settings.get('gemini_plan_model') || '').trim() ||
    'gemini-2.5-flash'
  );
}

/** Plan-detail API wait budget (ms). Default 60s; clamp 30s–120s. */
function getPlanTimeoutMs() {
  const fromEnv = Number(process.env.GEMINI_PLAN_TIMEOUT_MS);
  const fromSettings = Number(Settings.get('gemini_plan_timeout_ms'));
  const n = Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : Number.isFinite(fromSettings) && fromSettings > 0
      ? fromSettings
      : 60000;
  return Math.max(30000, Math.min(120000, n));
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

function sleep(ms) {
  return antiBan.sleep(Math.max(0, Number(ms) || 0));
}

function isRetryableGeminiError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status || err?.statusCode || err?.code;
  if (status === 429 || status === 503 || status === 500 || status === 502) {
    return true;
  }
  return /429|503|500|502|RESOURCE_EXHAUSTED|rate.?limit|quota|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|gemini_timeout|stt_timeout|Too Many Requests|Unavailable|internal error|empty_reply/i.test(
    msg
  );
}

function classifyGeminiFailure(err) {
  const msg = String(err?.message || err || '');
  if (/429|RESOURCE_EXHAUSTED|rate.?limit|Too Many Requests|quota/i.test(msg)) {
    return 'rate_limit';
  }
  if (/timeout|gemini_timeout|stt_timeout|ETIMEDOUT/i.test(msg)) {
    return 'timeout';
  }
  if (/503|502|500|Unavailable|internal error|ECONNRESET|fetch failed/i.test(msg)) {
    return 'transient';
  }
  return 'other';
}

/**
 * Run an async Gemini call with timeout + exponential backoff retries.
 * For long plan-detail calls, pass a higher timeoutMs (e.g. 60000+).
 * @returns {{ ok: true, value } | { ok: false, error, reason }}
 */
async function withGeminiRetry(
  fn,
  { label = 'gemini', attempts = 3, timeoutMs = 28000 } = {}
) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const started = Date.now();
    let timer = null;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => fn(i, { timeoutMs })),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label}_timeout`)),
            timeoutMs
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      logger.info(
        `[Gemini] ${label} OK in ${Date.now() - started}ms (attempt ${i + 1})`
      );
      return { ok: true, value };
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      const reason = classifyGeminiFailure(err);
      const retryable = isRetryableGeminiError(err);
      logger.warn(
        `[Gemini] ${label} attempt ${i + 1}/${attempts} failed after ${Date.now() - started}ms (${reason}): ${err.message}`
      );
      if (!retryable || i >= attempts - 1) break;

      const base =
        reason === 'rate_limit'
          ? 3000
          : reason === 'timeout'
            ? 1500
            : 1200;
      const backoff = Math.round(base * Math.pow(2, i) + Math.random() * 400);
      logger.info(`[Gemini] ${label} retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  return {
    ok: false,
    error: lastErr,
    reason: classifyGeminiFailure(lastErr),
  };
}

function softNormalizeGeminiMime(mimeHint, buf) {
  const raw = String(mimeHint || '').toLowerCase();
  const magic = Buffer.isBuffer(buf) ? buf.slice(0, 4).toString('ascii') : '';
  if (magic === 'OggS' || /ogg|opus/i.test(raw)) return 'audio/ogg';
  if (magic === 'RIFF' || /wav/i.test(raw)) return 'audio/wav';
  if (/mpeg|mp3/i.test(raw)) return 'audio/mp3';
  if (/webm/i.test(raw)) return 'audio/webm';
  if (/mp4|m4a/i.test(raw)) return 'audio/mp4';
  // Default WhatsApp PTT
  return 'audio/ogg';
}

function sanitizeTranscript(text) {
  let t = String(text || '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^\s*transcript\s*:\s*/i, '')
    .trim();
  // Model sometimes returns refusals / explanations instead of speech text
  if (
    !t ||
    /^(i('m| am) (sorry|unable)|cannot (transcribe|hear)|no (speech|audio)|empty audio)/i.test(
      t
    ) ||
    t.length < 2
  ) {
    return null;
  }
  return t.slice(0, 2000);
}

async function downloadInboundAudio(whatsapp, message) {
  let media = null;
  const errors = [];
  try {
    media = await whatsapp.downloadMediaWithRetry?.(message, 8);
  } catch (err) {
    errors.push(`retry:${err.message}`);
    console.error('[Gemini] STT downloadMediaWithRetry:', err.message);
  }
  if (!media?.data) {
    try {
      media = await message.downloadMedia?.();
    } catch (err) {
      errors.push(`direct:${err.message}`);
      console.error('[Gemini] STT downloadMedia:', err.message);
    }
  }
  if (!media?.data) {
    try {
      media = await whatsapp.pm?.downloadMediaFromMessageMeta?.(message);
    } catch (err) {
      errors.push(`meta:${err.message}`);
    }
  }
  if (!media?.data) {
    logger.warn(`[Gemini] voice download empty (${errors.join(' | ') || 'no data'})`);
    return null;
  }

  const b64 = normalizeBase64Audio(media.data);
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (err) {
    logger.warn('[Gemini] voice base64 decode failed:', err.message);
    return null;
  }
  if (!buf || buf.length < 64) {
    logger.warn(`[Gemini] voice buffer too small bytes=${buf?.length || 0}`);
    return null;
  }

  return {
    buffer: buf,
    base64: b64,
    mime: softNormalizeGeminiMime(media.mimetype, buf),
    rawMime: media.mimetype || '',
  };
}

async function geminiTranscribeOnce(apiKey, base64, mime, prompt) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: getModelName() });
  const result = await model.generateContent([
    {
      inlineData: {
        data: base64,
        mimeType: mime,
      },
    },
    { text: prompt },
  ]);
  return sanitizeTranscript(result?.response?.text?.());
}

/**
 * Transcribe inbound WhatsApp PTT with Gemini:
 *  1) original OGG (normalized mime)
 *  2) ffmpeg → WAV 16k
 *  3) ffmpeg → MP3
 * Each step uses timeout + exponential backoff retries.
 */
async function transcribeInboundVoice(whatsapp, message) {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('[Gemini] STT skipped — no API key');
    return { text: null, reason: 'no_key' };
  }

  const downloaded = await downloadInboundAudio(whatsapp, message);
  if (!downloaded) return { text: null, reason: 'download' };

  logger.info(
    `[Gemini] STT input mime=${downloaded.mime} raw=${downloaded.rawMime || '—'} bytes=${downloaded.buffer.length}`
  );

  const prompt =
    'Transcribe this WhatsApp voice note. ' +
    'Output ONLY the spoken words. Prefer Malayalam (മലയാളം) script when the speaker uses Malayalam; ' +
    'keep English/Hinglish as spoken. No commentary, no quotes, no "transcript:" label.';

  const attempts = [];

  // 1) Native ogg/opus with clean mime
  attempts.push({
    label: 'ogg',
    base64: downloaded.base64,
    mime: downloaded.mime === 'audio/ogg' ? 'audio/ogg' : downloaded.mime,
  });

  // 2) WAV fallback (most reliable for Gemini)
  try {
    const wav = await convertAudioForStt(
      downloaded.buffer,
      downloaded.rawMime || downloaded.mime,
      'wav'
    );
    attempts.push({ label: 'wav', base64: wav.base64, mime: wav.mime });
  } catch (err) {
    logger.warn('[Gemini] STT wav convert skipped:', err.message);
  }

  // 3) MP3 fallback
  try {
    const mp3 = await convertAudioForStt(
      downloaded.buffer,
      downloaded.rawMime || downloaded.mime,
      'mp3'
    );
    attempts.push({ label: 'mp3', base64: mp3.base64, mime: mp3.mime });
  } catch (err) {
    logger.warn('[Gemini] STT mp3 convert skipped:', err.message);
  }

  let lastReason = 'other';
  for (const att of attempts) {
    const ran = await withGeminiRetry(
      async () => {
        const text = await geminiTranscribeOnce(
          apiKey,
          att.base64,
          att.mime,
          prompt
        );
        if (!text) throw new Error('empty_transcript');
        return text;
      },
      {
        label: `stt-${att.label}`,
        attempts: 3,
        timeoutMs: 32000,
      }
    );

    if (ran.ok && ran.value) {
      logger.info(
        `[Gemini] STT OK via ${att.label} → "${String(ran.value).slice(0, 80)}"`
      );
      return { text: ran.value, reason: null };
    }

    lastReason = ran.reason || lastReason;
    // empty_transcript is not retryable across formats if truly silent — still try next format
    if (ran.error && !isRetryableGeminiError(ran.error) && /empty_transcript/i.test(ran.error.message)) {
      continue;
    }
  }

  logger.warn(`[Gemini] STT all formats failed reason=${lastReason}`);
  return { text: null, reason: lastReason || 'other' };
}

async function generatePlanReply({ key, userText, businessName }) {
  const apiKey = getApiKey();
  if (!apiKey) return { text: null, reason: 'no_key' };

  const brand =
    businessName ||
    Settings.get('business_name', 'SecureLife Insurance') ||
    'SecureLife Insurance';

  const planModel = getPlanModelName();
  const planTimeoutMs = getPlanTimeoutMs();

  const history = getHistory(key);
  const contents = [];
  for (const turn of history) {
    contents.push({
      role: turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: turn.text }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: userText }] });

  logger.info(
    `[Gemini] plan-detail request model=${planModel} timeoutMs=${planTimeoutMs} peer=${key} text="${String(userText).slice(0, 60)}"`
  );

  // Heavy plan-detail generation: longer timeout, wait for full response.
  // 2 attempts max so a 60s+60s path cannot stall the chat forever.
  const ran = await withGeminiRetry(
    async (_attempt, { timeoutMs } = {}) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel(
        {
          model: planModel,
          systemInstruction: getPlanSystemPrompt(brand),
          generationConfig: {
            temperature: 0.7,
            topP: 0.95,
            maxOutputTokens: 1400,
          },
        },
        // SDK-level HTTP timeout so Puppeteer/chat can await completion
        { timeout: Math.max(timeoutMs || planTimeoutMs, planTimeoutMs) }
      );
      const result = await model.generateContent({ contents });
      const reply = String(result?.response?.text?.() || '')
        .replace(/\r\n/g, '\n')
        .replace(/^```[\s\S]*?```$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 2800);
      if (!reply) throw new Error('empty_reply');
      return reply;
    },
    {
      label: 'plan-reply',
      attempts: 2,
      timeoutMs: planTimeoutMs,
    }
  );

  if (!ran.ok) {
    logger.warn(
      `[Gemini] plan generate failed after retries (${ran.reason}): ${ran.error?.message}`
    );
    return { text: null, reason: ran.reason || 'other' };
  }

  pushHistory(key, 'user', userText);
  pushHistory(key, 'model', ran.value);
  _lastReplyAt.set(key, Date.now());
  touchSession(key);
  return { text: ran.value, reason: null };
}

function fallbackSttText(reason) {
  if (reason === 'rate_limit') {
    return 'വോയ്സ് ട്രാൻസ്ക്രൈബ് ചെയ്യാൻ സെർവർ തിരക്കിലാണ്. ഒരു നിമിഷം കഴിഞ്ഞ് വോയ്സ് വീണ്ടും അയക്കൂ, അല്ലെങ്കിൽ പ്ലാൻ പേര് ടൈപ്പ് ചെയ്യൂ.';
  }
  if (reason === 'timeout') {
    return 'വോയ്സ് പ്രോസസ് ചെയ്യാൻ കൂടുതൽ സമയമെടുത്തു. ചുരുങ്ങിയ വോയ്സ് അയക്കൂ അല്ലെങ്കിൽ ടൈപ്പ് ചെയ്യൂ.';
  }
  if (reason === 'download') {
    return 'വോയ്സ് നോട്ട് ഡൗൺലോഡ് ചെയ്യാൻ പറ്റിയില്ല. ഒന്നുകൂടി അയക്കൂ അല്ലെങ്കിൽ ടൈപ്പ് ചെയ്യൂ.';
  }
  return 'വോയ്സ് നോട്ട് വ്യക്തമായി മനസ്സിലായില്ല. ദയവായി ഒന്നുകൂടി പറയൂ, അല്ലെങ്കിൽ പ്ലാൻ പേര് ടൈപ്പ് ചെയ്ത് അയക്കൂ. (ഉദാ: Star Health Assure)';
}

function fallbackTextForReason(reason) {
  if (reason === 'rate_limit') {
    return 'സെർവർ ഇപ്പോൾ തിരക്കിലാണ് (rate limit). ഒരു നിമിഷം കഴിഞ്ഞ് വീണ്ടും അയക്കൂ — സെഷൻ തുറന്നിരിക്കും.';
  }
  if (reason === 'timeout') {
    return 'പ്ലാൻ വിവരം തയ്യാറാക്കാൻ കൂടുതൽ സമയമെടുക്കുന്നു. ദയവായി ഒരു നിമിഷം കഴിഞ്ഞ് വീണ്ടും ചോദ്യം അയക്കൂ — സെഷൻ തുറന്നിരിക്കും.';
  }
  return 'ക്ഷമിക്കണം, ഇപ്പോൾ മറുപടി തയ്യാറാക്കാൻ പറ്റിയില്ല. അല്പസമയം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കൂ. (CLS അയച്ചാൽ സെഷൻ അടയ്ക്കാം)';
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

/**
 * Gemini / fallback TTS → raw audio buffer + mime (not yet WA-encoded).
 * @returns {Promise<{ buffer: Buffer, mime: string }|null>}
 */
async function synthesizeSpeechRaw(text) {
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
          setTimeout(() => reject(new Error('tts_timeout')), 60000)
        ),
      ]);

      if (res.ok) {
        const json = await res.json();
        const part =
          json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData) ||
          json?.candidates?.[0]?.content?.parts?.[0];
        const b64 = part?.inlineData?.data;
        const mime = String(part?.inlineData?.mimeType || 'audio/L16;codec=pcm;rate=24000');
        if (b64) {
          const raw = Buffer.from(b64, 'base64');
          logger.info(
            `[Gemini] TTS raw mime=${mime} bytes=${raw.length}`
          );
          return { buffer: raw, mime };
        }
        logger.warn('[Gemini] TTS response missing inlineData');
      } else {
        const errText = await res.text().catch(() => '');
        logger.warn(
          `[Gemini] TTS HTTP ${res.status}: ${errText.slice(0, 200)}`
        );
      }
    } catch (err) {
      logger.warn('[Gemini] TTS failed:', err.message);
      console.error(err.stack);
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
    logger.info(`[Gemini] fallback TTS mp3 bytes=${mp3.length}`);
    return { buffer: mp3, mime: 'audio/mpeg' };
  } catch (err) {
    logger.warn('[Gemini] fallback TTS failed:', err.message);
    console.error(err.stack);
    return null;
  }
}

/**
 * Full pipeline: text → TTS → OGG/Opus MessageMedia for PTT.
 */
async function synthesizeSpeech(text) {
  const raw = await synthesizeSpeechRaw(text);
  if (!raw?.buffer) return null;
  try {
    const converted = await toWhatsAppVoiceMedia(raw.buffer, raw.mime);
    // Attach cleanup so sendVoiceNote can remove temp files
    converted.media._waVoiceCleanup = converted.cleanup;
    converted.media._waVoiceFilePath = converted.filePath;
    return converted.media;
  } catch (err) {
    logger.warn('[Gemini] OGG conversion failed:', err.message);
    console.error(err.stack);
    // Last resort: expose WAV so sendMedia can still attempt (usually fails as PTT)
    try {
      const wav = /wav|pcm|l16/i.test(raw.mime)
        ? (/RIFF/.test(raw.buffer.slice(0, 4).toString('ascii'))
            ? raw.buffer
            : pcmToWav(raw.buffer, 24000, 1, 16))
        : raw.buffer;
      return new MessageMedia(
        /mpeg|mp3/i.test(raw.mime) ? 'audio/mpeg' : 'audio/wav',
        wav.toString('base64'),
        /mpeg|mp3/i.test(raw.mime) ? 'reply.mp3' : 'reply.wav'
      );
    } catch (_) {
      return null;
    }
  }
}

async function sendVoiceNote(whatsapp, { phone, chatId, text, message }) {
  const media = await synthesizeSpeech(text);
  if (!media) {
    logger.warn('[Gemini] no audio media — text fallback');
    await whatsapp.sendMessage(phone || chatId, text, {
      chatId: chatId || undefined,
      replyTo: message || undefined,
      lane: 'core',
      skipPacing: false,
    });
    return { voice: false, text: true };
  }

  const cleanup = typeof media._waVoiceCleanup === 'function'
    ? media._waVoiceCleanup
    : null;
  delete media._waVoiceCleanup;
  delete media._waVoiceFilePath;

  try {
    logger.info(
      `[Gemini] sending PTT mime=${media.mimetype} file=${media.filename || '—'} b64=${String(media.data || '').length}`
    );
    await whatsapp.sendMedia(phone || chatId, media, {
      chatId: chatId || undefined,
      sendAudioAsVoice: true,
      msgType: 'ptt',
      lane: 'core',
      // allow sendMedia voice fallbacks (file-path / alternate mime) before giving up
      once: false,
      preferFilePath: true,
      caption: undefined,
    });
    return { voice: true, text: false };
  } catch (err) {
    logger.warn('[Gemini] voice send failed, text fallback:', err.message);
    console.error(err.stack);
    await whatsapp.sendMessage(phone || chatId, text, {
      chatId: chatId || undefined,
      replyTo: message || undefined,
      lane: 'core',
    });
    return { voice: false, text: true };
  } finally {
    try {
      cleanup?.();
    } catch (err) {
      console.warn('[Gemini] voice temp cleanup:', err.message);
    }
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

  // Soft local pacing — wait briefly instead of dropping the turn silently
  if (rateLimited(key)) {
    const minGap = Number(Settings.get('gemini_min_gap_ms')) || 2500;
    const wait = Math.max(
      0,
      minGap - (Date.now() - (_lastReplyAt.get(key) || 0))
    );
    logger.info(`[Gemini] peer pacing ${wait}ms before reply peer=${key}`);
    if (wait > 0) await sleep(Math.min(wait, 4000));
  }

  let userText = text;
  if (isVoiceMessage(message) && !userText) {
    const stt = await transcribeInboundVoice(whatsapp, message);
    userText = stt?.text || null;
    if (!userText) {
      // Text (not voice) — avoid another TTS/API call when STT already failed
      await whatsapp.sendMessage(
        phone || chatId,
        fallbackSttText(stt?.reason),
        {
          chatId: chatId || undefined,
          replyTo: message || undefined,
          lane: 'core',
          skipPacing: true,
        }
      );
      return true;
    }
    logger.info(`[Gemini] voice→text peer=${key}: "${userText.slice(0, 100)}"`);
  }

  if (!userText) return false;

  try {
    if (chatId && whatsapp.pm?.showRecordingFor) {
      // Keep recording presence up while the heavy plan-detail call runs
      whatsapp.pm
        .showRecordingFor(chatId, Math.min(getPlanTimeoutMs(), 55000))
        .catch(() => {});
    } else if (chatId && whatsapp.pm?.sendRecordingPresence) {
      await whatsapp.pm.sendRecordingPresence(chatId);
    }
  } catch (_) {}

  const generated = await generatePlanReply({
    key,
    userText,
    businessName: Settings.get('business_name', 'SecureLife Insurance'),
  });

  if (!generated?.text) {
    const msg = fallbackTextForReason(generated?.reason);
    await whatsapp.sendMessage(phone || chatId, msg, {
      chatId: chatId || undefined,
      lane: 'core',
      skipPacing: true,
    });
    return true;
  }

  await sendVoiceNote(whatsapp, {
    phone,
    chatId,
    text: generated.text,
    message,
  });
  return true;
}

module.exports = {
  enabled,
  getApiKey,
  getModelName,
  getPlanModelName,
  getPlanTimeoutMs,
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
