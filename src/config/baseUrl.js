/**
 * Public base URL for form links and absolute redirects.
 * Strictly from process.env.BASE_URL — no localhost fallback.
 */
function getBaseUrl() {
  const raw = process.env.BASE_URL;
  if (!raw || !String(raw).trim()) {
    throw new Error(
      'BASE_URL is not set. Set process.env.BASE_URL (e.g. https://your-domain.com) — required for form links.'
    );
  }
  return String(raw).trim().replace(/\/+$/, '');
}

function hasBaseUrl() {
  return !!(process.env.BASE_URL && String(process.env.BASE_URL).trim());
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
};
