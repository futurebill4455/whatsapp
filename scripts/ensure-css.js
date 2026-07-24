#!/usr/bin/env node
/**
 * Ensure public/css/tailwind.css exists before the server starts.
 * Runs the Tailwind build when missing; writes a minimal stub if build fails.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const publicCss = path.join(root, 'public', 'css');
const tailwindOut = path.join(publicCss, 'tailwind.css');

function existsNonEmpty(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

const MINIMAL_STUB = `/* auto-generated stub — run \`npm run build:css\` for full Tailwind */
*,::before,::after{box-sizing:border-box}
html{line-height:1.5;-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a}
a{color:inherit;text-decoration:inherit}
button,input,select,textarea{font:inherit}
.hidden{display:none!important}
.flex{display:flex}
.grid{display:grid}
.min-h-screen{min-height:100vh}
.w-full{width:100%}
.max-w-lg{max-width:32rem}
.mx-auto{margin-left:auto;margin-right:auto}
.px-4{padding-left:1rem;padding-right:1rem}
.py-8{padding-top:2rem;padding-bottom:2rem}
.p-4{padding:1rem}
.p-6{padding:1.5rem}
.mb-4{margin-bottom:1rem}
.rounded{border-radius:.25rem}
.rounded-lg{border-radius:.5rem}
.border{border-width:1px;border-style:solid;border-color:#e2e8f0}
.bg-white{background-color:#fff}
.text-sm{font-size:.875rem}
.text-xl{font-size:1.25rem}
.font-semibold{font-weight:600}
.shadow{box-shadow:0 1px 3px rgba(0,0,0,.1)}
`;

fs.mkdirSync(publicCss, { recursive: true });

if (existsNonEmpty(tailwindOut)) {
  console.log('[CSS] public/css/tailwind.css OK');
  process.exit(0);
}

console.warn('[CSS] Missing public/css/tailwind.css — running npm run build:css…');

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build:css'],
  { cwd: root, stdio: 'inherit', env: process.env }
);

if (existsNonEmpty(tailwindOut)) {
  console.log('[CSS] Built public/css/tailwind.css');
  process.exit(0);
}

console.warn('[CSS] build:css did not produce tailwind.css — writing minimal stub');
fs.writeFileSync(tailwindOut, MINIMAL_STUB, 'utf8');

if (!existsNonEmpty(tailwindOut)) {
  console.error('[CSS] Failed to write stub at', path.relative(root, tailwindOut));
  process.exit(result.status || 1);
}

console.log('[CSS] Stub written to public/css/tailwind.css');
process.exit(0);
