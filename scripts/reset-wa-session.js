#!/usr/bin/env node
/**
 * Clean WhatsApp LocalAuth reset (run while the server is STOPPED).
 * Usage: npm run reset:wa
 */
const fs = require('fs');
const path = require('path');

const targets = ['.wwebjs_auth', '.wwebjs_cache'];

for (const name of targets) {
  const full = path.join(process.cwd(), name);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`Removed ${name}`);
  } else {
    console.log(`Skip ${name} (not found)`);
  }
}

console.log('\nSession cleared. Start the app with: npm start');
console.log('Then open http://localhost:3000 and scan the NEW QR promptly.');
