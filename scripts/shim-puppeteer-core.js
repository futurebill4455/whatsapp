#!/usr/bin/env node
/**
 * Ensure whatsapp-web.js (which does require('puppeteer')) resolves to puppeteer-core.
 * Runs after npm install so Render never needs the full puppeteer Chrome download.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const puppeteerDir = path.join(root, 'node_modules', 'puppeteer');
const corePkg = path.join(root, 'node_modules', 'puppeteer-core', 'package.json');

if (!fs.existsSync(corePkg)) {
  console.warn('[postinstall] puppeteer-core missing — skip puppeteer shim');
  process.exit(0);
}

const core = JSON.parse(fs.readFileSync(corePkg, 'utf8'));
const shimPkg = {
  name: 'puppeteer',
  version: core.version,
  description: 'Shim: redirects to puppeteer-core (no bundled Chrome)',
  main: 'index.js',
  types: 'index.d.ts',
  license: 'Apache-2.0',
};

fs.rmSync(puppeteerDir, { recursive: true, force: true });
fs.mkdirSync(puppeteerDir, { recursive: true });
fs.writeFileSync(path.join(puppeteerDir, 'package.json'), JSON.stringify(shimPkg, null, 2));
fs.writeFileSync(
  path.join(puppeteerDir, 'index.js'),
  "module.exports = require('puppeteer-core');\n"
);
fs.writeFileSync(
  path.join(puppeteerDir, 'index.d.ts'),
  "export * from 'puppeteer-core';\nexport { default } from 'puppeteer-core';\n"
);
console.log('[postinstall] puppeteer → puppeteer-core shim installed');
