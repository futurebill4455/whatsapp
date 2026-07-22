#!/usr/bin/env node
/**
 * Ensure production CSS assets exist before the server starts.
 * On Render, NODE_ENV=production used to skip Tailwind (devDependency) —
 * Tailwind is now a dependency; this still rebuilds if files are missing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const publicCss = path.join(root, 'public', 'css');
const required = [
  path.join(publicCss, 'tailwind.css'),
  path.join(publicCss, 'app.css'),
];

function existsNonEmpty(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

fs.mkdirSync(publicCss, { recursive: true });

const missing = required.filter((f) => !existsNonEmpty(f));
if (!missing.length) {
  console.log('[CSS] public/css assets OK:', required.map((f) => path.basename(f)).join(', '));
  process.exit(0);
}

console.warn('[CSS] Missing assets:', missing.map((f) => path.relative(root, f)).join(', '));
console.warn('[CSS] Running npm run build:css…');

const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build:css'],
  { cwd: root, stdio: 'inherit', env: process.env }
);

if (result.status !== 0) {
  console.error('[CSS] build:css failed — static styles may 404/502 until fixed');
  // Do not block boot if app.css already exists; tailwind may still be regenerable later
  if (!existsNonEmpty(path.join(publicCss, 'app.css'))) {
    process.exit(result.status || 1);
  }
  process.exit(0);
}

for (const file of required) {
  if (!existsNonEmpty(file)) {
    console.error('[CSS] Still missing after build:', path.relative(root, file));
  } else {
    console.log('[CSS] Built', path.relative(root, file));
  }
}
