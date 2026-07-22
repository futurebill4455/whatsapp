/**
 * Render / serverless Chromium launch for whatsapp-web.js.
 * Uses puppeteer-core + @sparticuz/chromium (no full Puppeteer Chrome download).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function isRenderLike() {
  return (
    process.env.USE_SPARTICUZ_CHROMIUM === '1' ||
    !!process.env.RENDER ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    !!process.env.AWS_EXECUTION_ENV ||
    process.platform === 'linux'
  );
}

function getChromium() {
  const mod = require('@sparticuz/chromium');
  return mod.default || mod;
}

/**
 * Sparticuz serverless args + a few WhatsApp/Render-safe extras.
 * Keep this lean — too many flags can hang headless-shell on free tier.
 */
function buildArgs(chromiumArgs = []) {
  const heapMb = Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 384;
  const base = Array.isArray(chromiumArgs) ? [...chromiumArgs] : [];

  const extras = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--no-default-browser-check',
    `--js-flags=--max-old-space-size=${heapMb}`,
    '--window-size=800,600',
  ];

  // single-process is already in chromium.args on Sparticuz; ensure it stays
  const allowSingle = process.env.PUPPETEER_NO_SINGLE_PROCESS !== '1';
  if (allowSingle && !base.includes('--single-process') && !extras.includes('--single-process')) {
    extras.push('--single-process');
  }

  const merged = [];
  const seen = new Set();
  for (const a of [...base, ...extras]) {
    if (!a) continue;
    // Launch options set headless separately
    if (String(a).startsWith('--headless')) continue;
    // Prefer our heap cap
    if (String(a).startsWith('--js-flags') && seen.has('js-flags')) continue;
    const key = String(a).startsWith('--js-flags') ? 'js-flags' : a;
    if (seen.has(key)) continue;
    if (!allowSingle && a === '--single-process') continue;
    seen.add(key);
    merged.push(a);
  }

  return merged;
}

function findSystemChrome() {
  const envPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    process.env.CHROMIUM_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates =
    process.platform === 'win32'
      ? [
          process.env.LOCALAPPDATA &&
            path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ];

  return candidates.filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

/**
 * Options passed to whatsapp-web.js → puppeteer-core.launch().
 */
async function buildPuppeteerLaunchOptions() {
  // Ensure puppeteer-core resolves (shim may map require('puppeteer') → core)
  require('puppeteer-core');

  const renderLike = isRenderLike();
  console.log(
    `[Chromium] Platform=${process.platform} renderLike=${renderLike} tmp=${os.tmpdir()}`
  );

  // Local Windows/macOS: system Chrome is more reliable for WhatsApp Web UI
  if (!renderLike) {
    const system = findSystemChrome();
    if (system) {
      console.log('[Chromium] Using system Chrome:', system);
      return {
        headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : true,
        executablePath: system,
        args: buildArgs([]),
        defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
        protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 300000,
        timeout: Number(process.env.PUPPETEER_TIMEOUT) || 180000,
        ignoreHTTPSErrors: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      };
    }
  }

  const chromium = getChromium();

  // Critical for free-tier RAM: skip SwiftShader / WebGL extraction
  try {
    chromium.setGraphicsMode = false;
  } catch (_) {}

  console.log('[Chromium] Inflating @sparticuz/chromium binary (first boot can take ~30–90s)…');
  const started = Date.now();
  const executablePath = await chromium.executablePath();
  console.log(
    `[Chromium] Ready in ${Date.now() - started}ms → ${executablePath}`
  );

  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      `@sparticuz/chromium executable missing after inflate: ${executablePath || '(empty)'}`
    );
  }

  const args = buildArgs(chromium.args || []);
  // Sparticuz chrome-headless-shell requires headless: 'shell' (or true on older APIs)
  let headless = 'shell';
  if (process.env.PUPPETEER_HEADLESS === 'false') headless = false;
  else if (process.env.PUPPETEER_HEADLESS === 'true') headless = true;
  else if (process.env.PUPPETEER_HEADLESS === 'shell') headless = 'shell';

  console.log(
    `[Chromium] Launching puppeteer-core headless=${headless} args=${args.length}`
  );

  return {
    headless,
    executablePath,
    args,
    defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    // Long timeouts: free-tier CPU is slow during WA Web sync
    protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 600000,
    timeout: Number(process.env.PUPPETEER_TIMEOUT) || 300000,
    ignoreHTTPSErrors: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

module.exports = {
  isRenderLike,
  buildPuppeteerLaunchOptions,
};
