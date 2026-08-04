/**
 * Convert TTS audio buffers to WhatsApp-compatible OGG/Opus PTT files
 * and build MessageMedia for sendAudioAsVoice.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { MessageMedia } = require('whatsapp-web.js');
const logger = require('../utils/logger');

function resolveFfmpegPath() {
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch (_) {}
  return process.env.FFMPEG_PATH || 'ffmpeg';
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

function runFfmpeg(args, { label = 'ffmpeg' } = {}) {
  const bin = resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    logger.info(`[VoiceMedia] ${label}: ${bin} ${args.join(' ')}`);
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      console.error(`[VoiceMedia] ${label} spawn error:`, err.message);
      console.error(err.stack);
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) return resolve(stderr);
      console.error(
        `[VoiceMedia] ${label} exit=${code} stderr:\n${stderr.slice(-2000)}`
      );
      reject(new Error(`ffmpeg_exit_${code}`));
    });
  });
}

function tmpPath(ext) {
  return path.join(
    os.tmpdir(),
    `wa-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  );
}

/**
 * Detect whether buffer looks like WAV / OGG / MP3 / raw PCM.
 */
function sniffAudioKind(buf, mimeHint = '') {
  const mime = String(mimeHint || '').toLowerCase();
  if (/ogg|opus/i.test(mime)) return 'ogg';
  if (/mpeg|mp3/i.test(mime)) return 'mp3';
  if (/wav|wave|x-wav/i.test(mime)) return 'wav';
  if (/l16|pcm|s16le/i.test(mime)) return 'pcm';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (buf.length >= 3 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  return 'pcm';
}

/**
 * Parse sample rate from Gemini-style mime like audio/L16;codec=pcm;rate=24000
 */
function parsePcmRate(mimeHint) {
  const m = String(mimeHint || '').match(/rate\s*=\s*(\d+)/i);
  if (m) return Number(m[1]) || 24000;
  return 24000;
}

/**
 * Convert any TTS buffer → OGG/Opus (mono, 48kHz, voip) for WhatsApp PTT.
 * Returns { media, filePath, cleanup } — caller should cleanup() after send.
 */
async function toWhatsAppVoiceMedia(inputBuf, mimeHint = '') {
  if (!inputBuf || !Buffer.isBuffer(inputBuf) || inputBuf.length < 64) {
    throw new Error('empty_audio_buffer');
  }

  const kind = sniffAudioKind(inputBuf, mimeHint);
  let workBuf = inputBuf;
  let inExt = '.bin';

  if (kind === 'ogg') {
    // Already Ogg — still re-encode to strip metadata / force WA-safe params
    inExt = '.ogg';
  } else if (kind === 'mp3') {
    inExt = '.mp3';
  } else if (kind === 'wav') {
    inExt = '.wav';
  } else {
    // Raw PCM from Gemini TTS (s16le mono @ 24k default)
    const rate = parsePcmRate(mimeHint);
    workBuf = pcmToWav(inputBuf, rate, 1, 16);
    inExt = '.wav';
    logger.info(
      `[VoiceMedia] wrapped PCM → WAV rate=${rate} bytes=${workBuf.length}`
    );
  }

  const inPath = tmpPath(inExt);
  const outPath = tmpPath('.ogg');

  try {
    fs.writeFileSync(inPath, workBuf);
    logger.info(
      `[VoiceMedia] wrote input ${inPath} kind=${kind} bytes=${workBuf.length} mimeHint=${mimeHint || '—'}`
    );

    // WhatsApp-compatible voice memo: mono Opus in Ogg, ~48 kHz, no metadata
    await runFfmpeg(
      [
        '-y',
        '-i',
        inPath,
        '-vn',
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-application',
        'voip',
        '-map_metadata',
        '-1',
        '-avoid_negative_ts',
        'make_zero',
        outPath,
      ],
      { label: 'ogg-opus' }
    );

    if (!fs.existsSync(outPath)) {
      throw new Error('ogg_output_missing');
    }
    const oggBuf = fs.readFileSync(outPath);
    if (oggBuf.length < 64) throw new Error('ogg_output_too_small');
    if (oggBuf.toString('ascii', 0, 4) !== 'OggS') {
      throw new Error('ogg_magic_missing');
    }

    const b64 = oggBuf.toString('base64');
    // Prefer fromFilePath — Puppeteer CDP base64 uploads often fail for PTT
    let media;
    try {
      media = MessageMedia.fromFilePath(outPath);
      // Ensure WA recognizes voice mime
      if (!/ogg/i.test(String(media.mimetype || ''))) {
        media.mimetype = 'audio/ogg; codecs=opus';
      } else if (!/codecs=opus/i.test(String(media.mimetype || ''))) {
        media.mimetype = 'audio/ogg; codecs=opus';
      }
      media.filename = media.filename || 'voice.ogg';
    } catch (err) {
      console.error(
        '[VoiceMedia] MessageMedia.fromFilePath failed:',
        err.message
      );
      console.error(err.stack);
      media = new MessageMedia(
        'audio/ogg; codecs=opus',
        b64,
        'voice.ogg',
        oggBuf.length
      );
    }

    logger.info(
      `[VoiceMedia] OGG ready bytes=${oggBuf.length} b64=${b64.length} mime=${media.mimetype} file=${outPath}`
    );

    const cleanup = () => {
      for (const p of [inPath, outPath]) {
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (err) {
          console.warn(`[VoiceMedia] cleanup ${p}:`, err.message);
        }
      }
    };

    return { media, filePath: outPath, cleanup, bytes: oggBuf.length };
  } catch (err) {
    for (const p of [inPath, outPath]) {
      try {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
    console.error('[VoiceMedia] conversion FAILED:', err.message);
    console.error(err.stack);
    throw err;
  }
}

module.exports = {
  resolveFfmpegPath,
  pcmToWav,
  toWhatsAppVoiceMedia,
  sniffAudioKind,
};
