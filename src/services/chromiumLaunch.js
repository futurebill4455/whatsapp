/**
 * Chromium / Chrome launch options for whatsapp-web.js (puppeteer-core).
 *
 * Priority:
 *  1. Render / Lambda / USE_SPARTICUZ_CHROMIUM=1 → @sparticuz/chromium
 *  2. System Chrome/Chromium (preferred on 2GB Linux VPS + local Windows/macOS)
 *  3. Sparticuz fallback when no system browser is found
 *
 * Tuned for ~2GB VPS (not free-tier starvation): heap 768MB, multi-process Chrome,
 * faster protocol timeouts than serverless.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** True only when we must use the Sparticuz serverless binary */
function forceSparticuz() {
  return (
    process.env.USE_SPARTICUZ_CHROMIUM === '1' ||
    !!process.env.RENDER ||
    !!process.env.AWS_LAMBDA_FUNCTION_NAME ||
    !!process.env.AWS_EXECUTION_ENV
  );
}

/** Back-compat alias used by WhatsApp service logs */
function isRenderLike() {
  return forceSparticuz();
}

function isVpsLinux() {
  return process.platform === 'linux' && !forceSparticuz();
}

function getChromium() {
  const mod = require('@sparticuz/chromium');
  return mod.default || mod;
}

/**
 * @param {string[]} chromiumArgs
 * @param {{ mode?: 'system' | 'sparticuz' }} opts
 */
function buildArgs(chromiumArgs = [], opts = {}) {
  const mode = opts.mode || 'sparticuz';
  const heapMb = Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 768;
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

  // System Chrome on Linux VPS: multi-process is more stable; opt-in with PUPPETEER_SINGLE_PROCESS=1
  // Sparticuz / Render: single-process stays default unless PUPPETEER_NO_SINGLE_PROCESS=1
  let allowSingle = false;
  if (mode === 'system') {
    allowSingle = process.env.PUPPETEER_SINGLE_PROCESS === '1';
  } else {
    allowSingle = process.env.PUPPETEER_NO_SINGLE_PROCESS !== '1';
  }

  if (allowSingle && !base.includes('--single-process') && !extras.includes('--single-process')) {
    extras.push('--single-process');
  }

  const merged = [];
  const seen = new Set();
  for (const a of [...base, ...extras]) {
    if (!a) continue;
    if (String(a).startsWith('--headless')) continue;
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
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ];

  return candidates.filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

function systemLaunchOptions(executablePath) {
  const protocolTimeout = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 180000;
  const timeout = Number(process.env.PUPPETEER_TIMEOUT) || 120000;
  console.log(
    `[Chromium] System Chrome (${isVpsLinux() ? 'Linux VPS' : process.platform}): ${executablePath}` +
      ` heap=${Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 768}MB` +
      ` single-process=${process.env.PUPPETEER_SINGLE_PROCESS === '1' ? 'yes' : 'no'}`
  );
  return {
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : true,
    executablePath,
    args: buildArgs([], { mode: 'system' }),
    defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    protocolTimeout,
    timeout,
    ignoreHTTPSErrors: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

async function sparticuzLaunchOptions() {
  const chromium = getChromium();

  try {
    chromium.setGraphicsMode = false;
  } catch (_) {}

  console.log('[Chromium] Inflating @sparticuz/chromium binary (first boot can take ~30–90s)…');
  const started = Date.now();
  const executablePath = await chromium.executablePath();
  console.log(`[Chromium] Ready in ${Date.now() - started}ms → ${executablePath}`);

  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      `@sparticuz/chromium executable missing after inflate: ${executablePath || '(empty)'}`
    );
  }

  const args = buildArgs(chromium.args || [], { mode: 'sparticuz' });
  let headless = 'shell';
  if (process.env.PUPPETEER_HEADLESS === 'false') headless = false;
  else if (process.env.PUPPETEER_HEADLESS === 'true') headless = true;
  else if (process.env.PUPPETEER_HEADLESS === 'shell') headless = 'shell';

  // Serverless / free-tier needs longer timeouts; still allow env override
  const protocolTimeout = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 600000;
  const timeout = Number(process.env.PUPPETEER_TIMEOUT) || 300000;

  console.log(
    `[Chromium] Launching Sparticuz headless=${headless} args=${args.length} heap=${Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 768}MB`
  );

  return {
    headless,
    executablePath,
    args,
    defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    protocolTimeout,
    timeout,
    ignoreHTTPSErrors: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

/**
 * Options passed to whatsapp-web.js → puppeteer-core.launch().
 */
async function buildPuppeteerLaunchOptions() {
  require('puppeteer-core');

  const forced = forceSparticuz();
  console.log(
    `[Chromium] Platform=${process.platform} forceSparticuz=${forced} tmp=${os.tmpdir()}`
  );

  if (forced) {
    return sparticuzLaunchOptions();
  }

  // Prefer system Chrome/Chromium on Linux VPS and local desktops
  const system = findSystemChrome();
  if (system) {
    return systemLaunchOptions(system);
  }

  console.warn(
    '[Chromium] No system Chrome/Chromium found — falling back to @sparticuz/chromium'
  );
  return sparticuzLaunchOptions();
}

module.exports = {
  isRenderLike,
  forceSparticuz,
  isVpsLinux,
  findSystemChrome,
  buildPuppeteerLaunchOptions,
};
