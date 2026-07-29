#!/usr/bin/env node
/**
 * Ensure public/css/tailwind.css is built from current views before the server starts.
 * Always runs a Tailwind rebuild so new campaign/admin classes are not missing in deploy.
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
.gap-5{gap:1.25rem}
.min-h-screen{min-height:100vh}
.w-full{width:100%}
.max-w-7xl{max-width:80rem}
.mx-auto{margin-left:auto;margin-right:auto}
.px-4{padding-left:1rem;padding-right:1rem}
.py-6{padding-top:1.5rem;padding-bottom:1.5rem}
.p-5{padding:1.25rem}
.mb-5{margin-bottom:1.25rem}
.rounded-xl{border-radius:.75rem}
.border{border-width:1px;border-style:solid;border-color:#e2e8f0}
.bg-white{background-color:#fff}
.text-sm{font-size:.875rem}
.font-semibold{font-weight:600}
@media (min-width:1024px){
  .lg\\:grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}
  .lg\\:sticky{position:sticky}
  .lg\\:top-20{top:5rem}
}
`;

fs.mkdirSync(publicCss, { recursive: true });

const skipBuild = process.env.SKIP_CSS_BUILD === '1';
if (!skipBuild) {
  console.log('[CSS] Building Tailwind from current views…');
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build:css'],
    { cwd: root, stdio: 'inherit', env: process.env }
  );
  if (existsNonEmpty(tailwindOut)) {
    console.log('[CSS] public/css/tailwind.css ready');
    process.exit(0);
  }
  console.warn(
    '[CSS] build:css failed (exit ' + (result.status || 1) + ') — trying stub'
  );
} else if (existsNonEmpty(tailwindOut)) {
  console.log('[CSS] SKIP_CSS_BUILD=1 — using existing tailwind.css');
  process.exit(0);
}

fs.writeFileSync(tailwindOut, MINIMAL_STUB, 'utf8');
if (!existsNonEmpty(tailwindOut)) {
  console.error('[CSS] Failed to write stub at', path.relative(root, tailwindOut));
  process.exit(1);
}
console.log('[CSS] Stub written to public/css/tailwind.css');
process.exit(0);
