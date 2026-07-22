/**
 * Pure in-memory store for pending forms and live customer↔company bridges.
 * Nothing is written to disk. Cleared on process restart (Render free tier spin-down).
 */
const crypto = require('crypto');
const { digits } = require('../config/runtime');

const FORM_TTL_MS = Number(process.env.FORM_TTL_MS) || 2 * 60 * 60 * 1000;
const BRIDGE_TTL_MS = Number(process.env.BRIDGE_TTL_MS) || 12 * 60 * 60 * 1000;
const MAX_PENDING = Number(process.env.MAX_PENDING_FORMS) || 80;
const MAX_BRIDGES = Number(process.env.MAX_BRIDGES) || 40;

/** @type {Map<string, object>} token → pending form */
const pendingByToken = new Map();
/** @type {Map<string, string>} customerPhone → token */
const pendingByPhone = new Map();
/** @type {Map<string, object>} bridgeId → bridge */
const bridges = new Map();
/** @type {Map<string, string>} customerPhone → bridgeId */
const bridgeByCustomer = new Map();
/** @type {Map<string, string>} waMessageId → bridgeId (for quoted replies) */
const waMsgToBridge = new Map();

function now() {
  return Date.now();
}

function makeToken() {
  return crypto.randomBytes(12).toString('hex');
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function prunePending() {
  const t = now();
  for (const [token, row] of pendingByToken) {
    if (t - row.createdAt > FORM_TTL_MS) {
      pendingByToken.delete(token);
      if (pendingByPhone.get(row.customerPhone) === token) {
        pendingByPhone.delete(row.customerPhone);
      }
    }
  }
  while (pendingByToken.size > MAX_PENDING) {
    const oldest = pendingByToken.keys().next().value;
    const row = pendingByToken.get(oldest);
    pendingByToken.delete(oldest);
    if (row && pendingByPhone.get(row.customerPhone) === oldest) {
      pendingByPhone.delete(row.customerPhone);
    }
  }
}

function pruneBridges() {
  const t = now();
  for (const [id, b] of bridges) {
    if (t - (b.lastActivityAt || b.openedAt) > BRIDGE_TTL_MS) {
      closeBridge(id);
    }
  }
  while (bridges.size > MAX_BRIDGES) {
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, b] of bridges) {
      const ts = b.lastActivityAt || b.openedAt;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestId = id;
      }
    }
    if (oldestId) closeBridge(oldestId);
    else break;
  }
}

function createPending({ customerPhone, customerChatId }) {
  prunePending();
  const phone = digits(customerPhone);
  const existingToken = pendingByPhone.get(phone);
  if (existingToken) {
    const existing = pendingByToken.get(existingToken);
    if (existing) return existing;
  }

  const token = makeToken();
  const row = {
    token,
    customerPhone: phone,
    customerChatId: customerChatId || null,
    status: 'awaiting_form',
    data: null,
    createdAt: now(),
  };
  pendingByToken.set(token, row);
  pendingByPhone.set(phone, token);
  return row;
}

function getPendingByToken(token) {
  prunePending();
  return pendingByToken.get(token) || null;
}

function getPendingByPhone(phone) {
  prunePending();
  const token = pendingByPhone.get(digits(phone));
  return token ? pendingByToken.get(token) || null : null;
}

function submitForm(token, data) {
  const row = pendingByToken.get(token);
  if (!row || row.status !== 'awaiting_form') return null;
  row.data = data;
  row.status = 'awaiting_confirmation';
  row.submittedAt = now();
  return row;
}

function clearPending(tokenOrPhone) {
  const byToken = pendingByToken.get(tokenOrPhone);
  if (byToken) {
    pendingByToken.delete(tokenOrPhone);
    if (pendingByPhone.get(byToken.customerPhone) === tokenOrPhone) {
      pendingByPhone.delete(byToken.customerPhone);
    }
    return;
  }
  const phone = digits(tokenOrPhone);
  const token = pendingByPhone.get(phone);
  if (token) {
    pendingByToken.delete(token);
    pendingByPhone.delete(phone);
  }
}

function formatSummary(data) {
  if (!data) return '';
  const lines = [];
  if (data.name) lines.push(`• Name: ${data.name}`);
  if (data.phone) lines.push(`• Phone: ${data.phone}`);
  if (data.email) lines.push(`• Email: ${data.email}`);
  if (data.details) lines.push(`• Details: ${data.details}`);
  for (const [k, v] of Object.entries(data)) {
    if (['name', 'phone', 'email', 'details'].includes(k)) continue;
    if (v == null || v === '') continue;
    lines.push(`• ${k}: ${v}`);
  }
  return lines.join('\n');
}

function openBridge({ customerPhone, customerChatId, companyPhone, data }) {
  pruneBridges();
  const cust = digits(customerPhone);
  const company = digits(companyPhone);
  const existingId = bridgeByCustomer.get(cust);
  if (existingId) closeBridge(existingId);

  const id = makeToken();
  const code = makeCode();
  const bridge = {
    id,
    code,
    customerPhone: cust,
    customerChatId: customerChatId || null,
    companyPhone: company,
    companyChatId: null,
    data: data || null,
    openedAt: now(),
    lastActivityAt: now(),
    lastCustomerAt: now(),
    lastCompanyAt: null,
  };
  bridges.set(id, bridge);
  bridgeByCustomer.set(cust, id);
  return bridge;
}

function getBridge(id) {
  return bridges.get(id) || null;
}

function getBridgeByCustomer(phone) {
  pruneBridges();
  const id = bridgeByCustomer.get(digits(phone));
  return id ? bridges.get(id) || null : null;
}

function listBridgesByCompany(phone) {
  pruneBridges();
  const desk = digits(phone);
  const list = [];
  for (const b of bridges.values()) {
    if (b.companyPhone === desk) list.push(b);
  }
  list.sort((a, b) => (b.lastCustomerAt || 0) - (a.lastCustomerAt || 0));
  return list;
}

function listBridgesByCompanyChatId(chatId) {
  if (!chatId) return [];
  const id = String(chatId);
  const lidUser = id.replace(/@.+$/, '');
  const list = [];
  for (const b of bridges.values()) {
    if (!b.companyChatId) continue;
    if (
      b.companyChatId === id ||
      b.companyChatId === `${lidUser}@lid` ||
      b.companyChatId.startsWith(`${lidUser}@`)
    ) {
      list.push(b);
    }
  }
  list.sort((a, b) => (b.lastCustomerAt || 0) - (a.lastCustomerAt || 0));
  return list;
}

function isCompanyChatId(chatId) {
  return listBridgesByCompanyChatId(chatId).length > 0;
}

function bindCompanyChatId(bridgeId, chatId) {
  const b = bridges.get(bridgeId);
  if (!b || !chatId) return b;
  b.companyChatId = String(chatId);
  b.lastActivityAt = now();
  return b;
}

function bindCustomerChatId(bridgeId, chatId) {
  const b = bridges.get(bridgeId);
  if (!b || !chatId) return b;
  b.customerChatId = String(chatId);
  b.lastActivityAt = now();
  return b;
}

function touchBridge(bridgeId, side) {
  const b = bridges.get(bridgeId);
  if (!b) return null;
  b.lastActivityAt = now();
  if (side === 'customer') b.lastCustomerAt = now();
  if (side === 'company') b.lastCompanyAt = now();
  return b;
}

function trackWaMessage(bridgeId, waMessageId) {
  if (!bridgeId || !waMessageId) return;
  waMsgToBridge.set(String(waMessageId), bridgeId);
  // Cap map size
  if (waMsgToBridge.size > 300) {
    const first = waMsgToBridge.keys().next().value;
    waMsgToBridge.delete(first);
  }
}

function findBridgeByWaMessageId(waMessageId) {
  if (!waMessageId) return null;
  const id = waMsgToBridge.get(String(waMessageId));
  return id ? bridges.get(id) || null : null;
}

function findBridgeByCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  for (const b of bridges.values()) {
    if (b.code === c) return b;
  }
  return null;
}

/**
 * Resolve which customer a company inbound message belongs to.
 */
function resolveCompanyInbound(companyPhone, { quotedWaId = null, body = '', chatId = null } = {}) {
  if (quotedWaId) {
    const byQuote = findBridgeByWaMessageId(quotedWaId);
    if (byQuote) return { bridge: byQuote, method: 'quoted_reply' };
  }

  const codeMatch = String(body || '').match(/\[#([A-Z0-9]{3,6})\]/i);
  if (codeMatch) {
    const byCode = findBridgeByCode(codeMatch[1]);
    if (byCode) return { bridge: byCode, method: 'session_code' };
  }

  let active = listBridgesByCompany(companyPhone);
  if (!active.length) active = listBridgesByCompanyChatId(chatId);
  if (active.length === 0) return { bridge: null, method: 'none' };
  if (active.length === 1) return { bridge: active[0], method: 'single' };
  return { bridge: active[0], method: 'last_customer', ambiguous: true };
}

function closeBridge(bridgeId) {
  const b = bridges.get(bridgeId);
  if (!b) return null;
  bridges.delete(bridgeId);
  if (bridgeByCustomer.get(b.customerPhone) === bridgeId) {
    bridgeByCustomer.delete(b.customerPhone);
  }
  for (const [waId, id] of waMsgToBridge) {
    if (id === bridgeId) waMsgToBridge.delete(waId);
  }
  return b;
}

function stats() {
  prunePending();
  pruneBridges();
  return {
    pendingForms: pendingByToken.size,
    activeBridges: bridges.size,
  };
}

function listActiveBridges() {
  pruneBridges();
  return [...bridges.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

module.exports = {
  createPending,
  getPendingByToken,
  getPendingByPhone,
  submitForm,
  clearPending,
  formatSummary,
  openBridge,
  getBridge,
  getBridgeByCustomer,
  listBridgesByCompany,
  isCompanyChatId,
  bindCompanyChatId,
  bindCustomerChatId,
  touchBridge,
  trackWaMessage,
  resolveCompanyInbound,
  closeBridge,
  stats,
  listActiveBridges,
};
