/**
 * Chromium / Chrome launch options for whatsapp-web.js (puppeteer-core).
 *
 * Priority:
 *  1. Render / Lambda / USE_SPARTICUZ_CHROMIUM=1 → @sparticuz/chromium
 *  2. System Chrome/Chromium (preferred on 2GB Linux VPS + local Windows/macOS)
 *  3. Sparticuz fallback when no system browser is found
 *
 * Always includes Linux-safe headless flags so Chromium does not crash
 * under root / Docker / low-/dev/shm environments.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Required for stable Chromium on Linux servers (also fine on Windows/macOS). */
const REQUIRED_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
];

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
  // Default 512MB heap — safer on 1–2GB VPS; override with CHROMIUM_MAX_OLD_SPACE_MB
  const heapMb = Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 512;
  const base = Array.isArray(chromiumArgs) ? [...chromiumArgs] : [];

  const extras = [
    ...REQUIRED_CHROME_ARGS,
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--renderer-process-limit=1',
    '--disable-hang-monitor',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-breakpad',
    '--no-first-run',
    '--no-zygote',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--no-default-browser-check',
    '--metrics-recording-only',
    '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor,TranslateUI,BlinkGenPropertyTrees,AudioServiceOutOfProcess',
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

  if (
    allowSingle &&
    !base.includes('--single-process') &&
    !extras.includes('--single-process')
  ) {
    extras.push('--single-process');
  }

  const merged = [];
  const seen = new Set();
  for (const a of [...REQUIRED_CHROME_ARGS, ...base, ...extras]) {
    if (!a) continue;
    if (String(a).startsWith('--headless')) continue;
    if (String(a).startsWith('--js-flags') && seen.has('js-flags')) continue;
    const key = String(a).startsWith('--js-flags') ? 'js-flags' : a;
    if (seen.has(key)) continue;
    if (!allowSingle && a === '--single-process') continue;
    seen.add(key);
    merged.push(a);
  }

  // Hard guarantee — never ship a launch without the Linux crash-prevention flags
  for (const req of REQUIRED_CHROME_ARGS) {
    if (!merged.includes(req)) merged.unshift(req);
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
            path.join(
              process.env.LOCALAPPDATA,
              'Google',
              'Chrome',
              'Application',
              'chrome.exe'
            ),
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
  const protocolTimeout =
    Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 180000;
  const timeout = Number(process.env.PUPPETEER_TIMEOUT) || 120000;
  const args = buildArgs([], { mode: 'system' });
  console.log(
    `[Chromium] System Chrome (${isVpsLinux() ? 'Linux VPS' : process.platform}): ${executablePath}` +
      ` heap=${Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 512}MB` +
      ` single-process=${process.env.PUPPETEER_SINGLE_PROCESS === '1' ? 'yes' : 'no'}` +
      ` flags=${REQUIRED_CHROME_ARGS.join(',')}`
  );
  return {
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : true,
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

async function sparticuzLaunchOptions() {
  const chromium = getChromium();

  try {
    chromium.setGraphicsMode = false;
  } catch (_) {}

  console.log(
    '[Chromium] Inflating @sparticuz/chromium binary (first boot can take ~30–90s)…'
  );
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

  const args = buildArgs(chromium.args || [], { mode: 'sparticuz' });
  let headless = 'shell';
  if (process.env.PUPPETEER_HEADLESS === 'false') headless = false;
  else if (process.env.PUPPETEER_HEADLESS === 'true') headless = true;
  else if (process.env.PUPPETEER_HEADLESS === 'shell') headless = 'shell';

  const protocolTimeout =
    Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT) || 600000;
  const timeout = Number(process.env.PUPPETEER_TIMEOUT) || 300000;

  console.log(
    `[Chromium] Launching Sparticuz headless=${headless} args=${args.length}` +
      ` heap=${Number(process.env.CHROMIUM_MAX_OLD_SPACE_MB) || 512}MB` +
      ` flags=${REQUIRED_CHROME_ARGS.join(',')}`
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
  REQUIRED_CHROME_ARGS,
  buildArgs,
};
