const os = require('os');

function detectLanIpv4() {
  const nets = os.networkInterfaces();
  const preferred = [];
  const fallback = [];

  for (const entries of Object.values(nets || {})) {
    for (const net of entries || []) {
      const family = net.family === 'IPv4' || net.family === 4;
      if (!family || net.internal) continue;
      const addr = String(net.address || '');
      // Prefer typical private LAN ranges over weird virtual adapters when possible
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(addr)) {
        preferred.push(addr);
      } else {
        fallback.push(addr);
      }
    }
  }
  return preferred[0] || fallback[0] || null;
}

function isLoopbackUrl(url) {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(String(url || '').trim());
}

/**
 * Public base URL for form links opened on mobile.
 * Priority: Settings.public_base_url → BASE_URL env → auto LAN IP → localhost.
 */
function getBaseUrl() {
  const port = process.env.PORT || 3000;
  let fromSettings = '';
  try {
    fromSettings = String(
      require('../models').Settings.get('public_base_url') || ''
    ).trim();
  } catch (_) {}

  let raw =
    fromSettings ||
    String(process.env.BASE_URL || process.env.PUBLIC_BASE_URL || '').trim();

  if (!raw || isLoopbackUrl(raw)) {
    const ip = detectLanIpv4();
    if (ip) {
      // If env was https://localhost, keep http for LAN IP (no cert)
      raw = `http://${ip}:${port}`;
    } else if (!raw) {
      raw = `http://localhost:${port}`;
    }
  }

  return String(raw).replace(/\/$/, '');
}

function buildFormUrl(token) {
  return `${getBaseUrl()}/form/${token}`;
}

module.exports = { getBaseUrl, buildFormUrl, detectLanIpv4, isLoopbackUrl };
