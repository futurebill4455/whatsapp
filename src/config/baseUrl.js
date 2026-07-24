function getBaseUrl() {
  const raw = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return String(raw).replace(/\/$/, '');
}

function buildFormUrl(token) {
  return `${getBaseUrl()}/form/${token}`;
}

module.exports = { getBaseUrl, buildFormUrl };
