/**
 * Public base URL for form links.
 * Reads process.env.BASE_URL (and .env if needed), never throws for a missing value.
 */
const fs = require('fs');
const path = require('path');

// Ensure .env is loaded even if this module is required before server.js dotenv
try {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch (_) {}

const VPS_FALLBACK = 'http://163.5.191.37:3000';
const LOCAL_FALLBACK = 'http://localhost:3000';

function normalizeUrl(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  // Strip wrapping quotes from .env / panel values: "https://…" or 'https://…'
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Reject empty / whitespace-only / literal "undefined"
  if (!s || /^undefined$/i.test(s) || /^null$/i.test(s)) return '';
  return s.replace(/\/+$/, '');
}

/**
 * Some hosts inject BASE_URL="" which blocks dotenv (dotenv does not override).
 * Read the value directly from the project .env when process.env is empty.
 */
function readBaseUrlFromDotEnvFile() {
  try {
    const file = path.join(process.cwd(), '.env');
    if (!fs.existsSync(file)) return '';
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^\s*BASE_URL\s*=\s*(.*?)\s*$/m);
    if (!match) return '';
    return normalizeUrl(match[1]);
  } catch (_) {
    return '';
  }
}

function resolveBaseUrl() {
  let url = normalizeUrl(process.env.BASE_URL);

  if (!url) {
    url = readBaseUrlFromDotEnvFile();
    if (url) {
      process.env.BASE_URL = url;
    }
  }

  if (!url) {
    url = VPS_FALLBACK;
  }

  if (!url) {
    url = LOCAL_FALLBACK;
  }

  return url;
}

function getBaseUrl() {
  return resolveBaseUrl();
}

function hasBaseUrl() {
  return !!normalizeUrl(process.env.BASE_URL) || !!readBaseUrlFromDotEnvFile();
}

/**
 * Absolute form URL for a submission token.
 */
function buildFormUrl(token) {
  const base = getBaseUrl();
  const t = String(token || '').trim();
  if (!t) throw new Error('Form token is required to build form URL');
  return `${base}/form/${t}`;
}

module.exports = {
  getBaseUrl,
  hasBaseUrl,
  buildFormUrl,
  VPS_FALLBACK,
  LOCAL_FALLBACK,
};
