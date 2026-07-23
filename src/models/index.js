const db = require('../config/db');

const Settings = {
  get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  },

  getAll() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  set(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));
  },

  setMany(obj) {
    const tx = db.transaction((entries) => {
      for (const [key, value] of Object.entries(entries)) {
        Settings.set(key, value);
      }
    });
    tx(obj);
  },
};

const InsuranceTypes = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM insurance_types WHERE is_active = 1 ORDER BY sort_order, name'
      : 'SELECT * FROM insurance_types ORDER BY sort_order, name';
    return db.prepare(sql).all();
  },

  get(id) {
    return db.prepare('SELECT * FROM insurance_types WHERE id = ?').get(id);
  },

  create({ name, sort_order = 0 }) {
    const result = db.prepare(
      'INSERT INTO insurance_types (name, sort_order) VALUES (?, ?)'
    ).run(name, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { name, is_active, sort_order }) {
    db.prepare(`
      UPDATE insurance_types
      SET name = COALESCE(?, name),
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(name ?? null, is_active ?? null, sort_order ?? null, id);
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM insurance_types WHERE id = ?').run(id);
  },
};

const Companies = {
  list(activeOnly = false, insuranceTypeId = null) {
    let sql = 'SELECT c.*, t.name AS insurance_type_name FROM companies c LEFT JOIN insurance_types t ON t.id = c.insurance_type_id';
    const params = [];
    const clauses = [];
    if (activeOnly) clauses.push('c.is_active = 1');
    if (insuranceTypeId) {
      clauses.push('(c.insurance_type_id = ? OR c.insurance_type_id IS NULL)');
      params.push(insuranceTypeId);
    }
    if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY c.sort_order, c.name';
    return db.prepare(sql).all(...params);
  },

  get(id) {
    return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  },

  findByName(name) {
    if (!name) return null;
    return db.prepare(
      'SELECT * FROM companies WHERE is_active = 1 AND LOWER(name) = LOWER(?) LIMIT 1'
    ).get(String(name).trim());
  },

  create({ name, insurance_type_id = null, desk_phone = null, sort_order = 0 }) {
    const phone = desk_phone ? String(desk_phone).replace(/\D/g, '') : null;
    const result = db.prepare(
      'INSERT INTO companies (name, insurance_type_id, desk_phone, sort_order) VALUES (?, ?, ?, ?)'
    ).run(name, insurance_type_id || null, phone || null, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { name, insurance_type_id, desk_phone, is_active, sort_order }) {
    const current = this.get(id);
    const phone =
      desk_phone !== undefined
        ? (desk_phone ? String(desk_phone).replace(/\D/g, '') : null)
        : current?.desk_phone;
    db.prepare(`
      UPDATE companies
      SET name = COALESCE(?, name),
          insurance_type_id = ?,
          desk_phone = ?,
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(
      name ?? null,
      insurance_type_id === undefined ? current?.insurance_type_id : (insurance_type_id || null),
      phone,
      is_active ?? null,
      sort_order ?? null,
      id
    );
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM companies WHERE id = ?').run(id);
  },
};

const InternalNumbers = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? `SELECT n.*, t.name AS insurance_type_name
         FROM internal_numbers n
         LEFT JOIN insurance_types t ON t.id = n.insurance_type_id
         WHERE n.is_active = 1
         ORDER BY n.is_default DESC, n.label`
      : `SELECT n.*, t.name AS insurance_type_name
         FROM internal_numbers n
         LEFT JOIN insurance_types t ON t.id = n.insurance_type_id
         ORDER BY n.is_default DESC, n.label`;
    return db.prepare(sql).all();
  },

  get(id) {
    return db.prepare('SELECT * FROM internal_numbers WHERE id = ?').get(id);
  },

  resolveForType(insuranceTypeName, companyName = null) {
    // 1) Company.desk_phone from Catalog (e.g. Star Health)
    if (companyName) {
      const company = Companies.findByName(companyName);
      if (company?.desk_phone) {
        return {
          id: null,
          label: company.name,
          phone: String(company.desk_phone).replace(/\D/g, ''),
          source: 'company_desk_phone',
        };
      }
      const byLabel = db.prepare(`
        SELECT * FROM internal_numbers
        WHERE is_active = 1 AND LOWER(label) = LOWER(?)
        LIMIT 1
      `).get(String(companyName).trim());
      if (byLabel) return { ...byLabel, source: 'internal_label' };
    }

    // 2) Match by insurance type (Health / Vehicle)
    if (insuranceTypeName) {
      const byType = db.prepare(`
        SELECT n.* FROM internal_numbers n
        LEFT JOIN insurance_types t ON t.id = n.insurance_type_id
        WHERE n.is_active = 1 AND LOWER(t.name) = LOWER(?)
        ORDER BY n.is_default DESC, n.id
        LIMIT 1
      `).get(insuranceTypeName);
      if (byType) return { ...byType, source: 'insurance_type' };
    }

    // 3) Default / first active desk
    const fallback =
      db.prepare(
        'SELECT * FROM internal_numbers WHERE is_active = 1 AND is_default = 1 LIMIT 1'
      ).get() ||
      db.prepare(
        'SELECT * FROM internal_numbers WHERE is_active = 1 ORDER BY id LIMIT 1'
      ).get();
    return fallback ? { ...fallback, source: 'default' } : null;
  },

  isDeskPhone(phoneDigits) {
    const digits = String(phoneDigits || '').replace(/\D/g, '');
    if (!digits) return false;
    if (
      db.prepare(
        'SELECT id FROM internal_numbers WHERE is_active = 1 AND phone = ? LIMIT 1'
      ).get(digits)
    ) {
      return true;
    }
    return !!db.prepare(
      'SELECT id FROM companies WHERE is_active = 1 AND desk_phone = ? LIMIT 1'
    ).get(digits);
  },

  create({ label, phone, insurance_type_id = null, is_default = 0 }) {
    const tx = db.transaction(() => {
      if (is_default) {
        db.prepare('UPDATE internal_numbers SET is_default = 0').run();
      }
      return db.prepare(
        'INSERT INTO internal_numbers (label, phone, insurance_type_id, is_default) VALUES (?, ?, ?, ?)'
      ).run(label, phone, insurance_type_id || null, is_default ? 1 : 0);
    });
    const result = tx();
    return this.get(result.lastInsertRowid);
  },

  update(id, { label, phone, insurance_type_id, is_default, is_active }) {
    const tx = db.transaction(() => {
      if (is_default) {
        db.prepare('UPDATE internal_numbers SET is_default = 0').run();
      }
      db.prepare(`
        UPDATE internal_numbers
        SET label = COALESCE(?, label),
            phone = COALESCE(?, phone),
            insurance_type_id = ?,
            is_default = COALESCE(?, is_default),
            is_active = COALESCE(?, is_active)
        WHERE id = ?
      `).run(
        label ?? null,
        phone ?? null,
        insurance_type_id === undefined ? this.get(id)?.insurance_type_id : (insurance_type_id || null),
        is_default ?? null,
        is_active ?? null,
        id
      );
    });
    tx();
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM internal_numbers WHERE id = ?').run(id);
  },
};

const ChatFlow = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM chat_flow WHERE is_active = 1 ORDER BY sort_order, id'
      : 'SELECT * FROM chat_flow ORDER BY sort_order, id';
    return db.prepare(sql).all();
  },

  get(id) {
    return db.prepare('SELECT * FROM chat_flow WHERE id = ?').get(id);
  },

  findByKeyword(text) {
    const normalized = String(text || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
    const flows = this.list(true);
    // Prefer exact keyword match first (brochure, address, …)
    const exact = flows.find((f) => {
      const keywords = f.trigger_keyword.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      return keywords.some((k) => k === normalized);
    });
    if (exact) return exact;
    return flows.find((f) => {
      const keywords = f.trigger_keyword.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      return keywords.some((k) => normalized.startsWith(`${k} `));
    });
  },

  create({ trigger_keyword, response_template, sort_order = 0 }) {
    const result = db.prepare(
      'INSERT INTO chat_flow (trigger_keyword, response_template, sort_order) VALUES (?, ?, ?)'
    ).run(trigger_keyword, response_template, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { trigger_keyword, response_template, is_active, sort_order }) {
    db.prepare(`
      UPDATE chat_flow
      SET trigger_keyword = COALESCE(?, trigger_keyword),
          response_template = COALESCE(?, response_template),
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(trigger_keyword ?? null, response_template ?? null, is_active ?? null, sort_order ?? null, id);
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM chat_flow WHERE id = ?').run(id);
  },
};

const FormFields = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM form_fields WHERE is_active = 1 ORDER BY sort_order, id'
      : 'SELECT * FROM form_fields ORDER BY sort_order, id';
    return db.prepare(sql).all().map((f) => ({
      ...f,
      options: f.options_json ? JSON.parse(f.options_json) : null,
    }));
  },

  get(id) {
    const f = db.prepare('SELECT * FROM form_fields WHERE id = ?').get(id);
    if (!f) return null;
    return { ...f, options: f.options_json ? JSON.parse(f.options_json) : null };
  },

  create({ field_key, label, field_type = 'text', options = null, is_required = 1, sort_order = 0 }) {
    const result = db.prepare(
      'INSERT INTO form_fields (field_key, label, field_type, options_json, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(field_key, label, field_type, options ? JSON.stringify(options) : null, is_required ? 1 : 0, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, data) {
    const current = this.get(id);
    if (!current) return null;
    db.prepare(`
      UPDATE form_fields
      SET label = COALESCE(?, label),
          field_type = COALESCE(?, field_type),
          options_json = ?,
          is_required = COALESCE(?, is_required),
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(
      data.label ?? null,
      data.field_type ?? null,
      data.options !== undefined ? (data.options ? JSON.stringify(data.options) : null) : current.options_json,
      data.is_required ?? null,
      data.is_active ?? null,
      data.sort_order ?? null,
      id
    );
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM form_fields WHERE id = ?').run(id);
  },
};

const Submissions = {
  create({ token, customer_phone, workflow_run_id = null }) {
    db.prepare(
      'INSERT INTO submissions (token, customer_phone, status, workflow_run_id) VALUES (?, ?, ?, ?)'
    ).run(token, customer_phone, 'awaiting_form', workflow_run_id);
    return this.getByToken(token);
  },

  getByToken(token) {
    return db.prepare('SELECT * FROM submissions WHERE token = ?').get(token);
  },

  get(id) {
    return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  },

  findPendingConfirmation(phone) {
    return db.prepare(`
      SELECT * FROM submissions
      WHERE customer_phone = ? AND status = 'awaiting_confirmation'
      ORDER BY updated_at DESC LIMIT 1
    `).get(phone);
  },

  findLatestOpen(phone) {
    return db.prepare(`
      SELECT * FROM submissions
      WHERE customer_phone = ? AND status IN ('awaiting_form', 'awaiting_confirmation')
      ORDER BY updated_at DESC LIMIT 1
    `).get(phone);
  },

  list({ status = null, limit = 100 } = {}) {
    if (status) {
      return db.prepare(
        'SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      ).all(status, limit);
    }
    return db.prepare(
      'SELECT * FROM submissions ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  },

  submitForm(token, { customer_name, insurance_type, company, extra_data = null }) {
    db.prepare(`
      UPDATE submissions
      SET customer_name = ?,
          insurance_type = ?,
          company = ?,
          extra_data = ?,
          status = 'awaiting_confirmation',
          form_submitted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE token = ?
    `).run(
      customer_name,
      insurance_type,
      company,
      extra_data ? JSON.stringify(extra_data) : null,
      token
    );
    return this.getByToken(token);
  },

  setWorkflowRun(token, runId) {
    db.prepare(
      `UPDATE submissions SET workflow_run_id = ?, updated_at = datetime('now') WHERE token = ?`
    ).run(runId, token);
  },

  markConfirmed(id) {
    db.prepare(`
      UPDATE submissions
      SET status = 'confirmed',
          confirmed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    return this.get(id);
  },

  markForwarded(id, forwardedTo) {
    db.prepare(`
      UPDATE submissions
      SET status = 'forwarded',
          forwarded_to = ?,
          forwarded_at = datetime('now'),
          quote_relay_active = 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(forwardedTo, id);
    return this.get(id);
  },

  setCustomerChatId(token, chatId) {
    db.prepare(
      `UPDATE submissions SET customer_chat_id = ?, updated_at = datetime('now') WHERE token = ?`
    ).run(chatId || null, token);
  },

  findAwaitingQuoteByDeskPhone(deskPhone) {
    const digits = String(deskPhone || '').replace(/\D/g, '');
    if (!digits) return null;
    return db.prepare(`
      SELECT * FROM submissions
      WHERE quote_relay_active = 1
        AND status = 'forwarded'
        AND forwarded_to = ?
      ORDER BY forwarded_at DESC
      LIMIT 1
    `).get(digits);
  },

  clearQuoteRelay(id) {
    db.prepare(
      `UPDATE submissions SET quote_relay_active = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(id);
  },

  markCancelled(id) {
    db.prepare(`
      UPDATE submissions
      SET status = 'cancelled',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    return this.get(id);
  },

  stats() {
    return {
      total: db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c,
      awaiting_form: db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'awaiting_form'").get().c,
      awaiting_confirmation: db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'awaiting_confirmation'").get().c,
      forwarded: db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'forwarded'").get().c,
      today: db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE date(created_at) = date('now')").get().c,
    };
  },
};

const Workflows = {
  list() {
    return db.prepare(
      'SELECT id, name, description, is_active, created_at, updated_at FROM workflows ORDER BY is_active DESC, updated_at DESC'
    ).all();
  },

  get(id) {
    const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      graph: safeJson(row.graph_json, { drawflow: { Home: { data: {} } } }),
    };
  },

  getActive() {
    const row = db.prepare(
      'SELECT * FROM workflows WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
    ).get();
    if (!row) return null;
    return {
      ...row,
      graph: safeJson(row.graph_json, { drawflow: { Home: { data: {} } } }),
    };
  },

  create({ name, description = '', graph = null, is_active = 0 }) {
    const graph_json = JSON.stringify(graph || { drawflow: { Home: { data: {} } } });
    const result = db.prepare(
      'INSERT INTO workflows (name, description, graph_json, is_active) VALUES (?, ?, ?, ?)'
    ).run(name, description, graph_json, is_active ? 1 : 0);
    return this.get(result.lastInsertRowid);
  },

  update(id, { name, description, graph, is_active }) {
    const current = this.get(id);
    if (!current) return null;
    db.prepare(`
      UPDATE workflows
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          graph_json = COALESCE(?, graph_json),
          is_active = COALESCE(?, is_active),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? null,
      description ?? null,
      graph ? JSON.stringify(graph) : null,
      is_active === undefined ? null : (is_active ? 1 : 0),
      id
    );
    return this.get(id);
  },

  setActive(id) {
    const tx = db.transaction(() => {
      db.prepare('UPDATE workflows SET is_active = 0').run();
      db.prepare(
        `UPDATE workflows SET is_active = 1, updated_at = datetime('now') WHERE id = ?`
      ).run(id);
    });
    tx();
    return this.get(id);
  },

  saveGraph(id, graph) {
    db.prepare(
      `UPDATE workflows SET graph_json = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(graph), id);
    return this.get(id);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM workflows').get().c;
  },

  remove(id) {
    return db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  },
};

const WorkflowRuns = {
  create({ workflow_id, customer_phone, submission_token = null, context = {} }) {
    const result = db.prepare(`
      INSERT INTO workflow_runs (workflow_id, customer_phone, submission_token, status, context_json)
      VALUES (?, ?, ?, 'running', ?)
    `).run(workflow_id, customer_phone, submission_token, JSON.stringify(context));
    return this.get(result.lastInsertRowid);
  },

  get(id) {
    const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, context: safeJson(row.context_json, {}) };
  },

  findWaiting(phone, waitingFor) {
    return db.prepare(`
      SELECT * FROM workflow_runs
      WHERE customer_phone = ? AND status = 'waiting' AND waiting_for = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(phone, waitingFor);
  },

  findWaitingByToken(token, waitingFor) {
    return db.prepare(`
      SELECT * FROM workflow_runs
      WHERE submission_token = ? AND status = 'waiting' AND waiting_for = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(token, waitingFor);
  },

  update(id, fields) {
    const run = this.get(id);
    if (!run) return null;
    const context_json = fields.context !== undefined
      ? JSON.stringify(fields.context)
      : run.context_json;
    db.prepare(`
      UPDATE workflow_runs
      SET status = COALESCE(?, status),
          current_node_id = COALESCE(?, current_node_id),
          waiting_for = ?,
          submission_token = COALESCE(?, submission_token),
          context_json = ?,
          last_error = COALESCE(?, last_error),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fields.status ?? null,
      fields.current_node_id ?? null,
      fields.waiting_for === undefined ? run.waiting_for : fields.waiting_for,
      fields.submission_token ?? null,
      context_json,
      fields.last_error ?? null,
      id
    );
    return this.get(id);
  },
};

function safeJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

const MessageLog = {
  add({ direction, phone, body, meta = null }) {
    db.prepare(
      'INSERT INTO message_log (direction, phone, body, meta) VALUES (?, ?, ?, ?)'
    ).run(direction, phone, body, meta ? JSON.stringify(meta) : null);
  },

  recent(limit = 50) {
    return db.prepare(
      'SELECT * FROM message_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  },
};

const Admins = {
  findByUsername(username) {
    return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  },

  create({ username, password_hash }) {
    const result = db.prepare(
      'INSERT INTO admins (username, password_hash) VALUES (?, ?)'
    ).run(username, password_hash);
    return db.prepare('SELECT id, username, created_at FROM admins WHERE id = ?').get(result.lastInsertRowid);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  },
};

/**
 * Persistent two-way bridge between a customer and a company desk.
 * Multiple customers may share the same desk_phone — routing uses
 * quoted WhatsApp replies, session codes, then last-active fallback.
 */
const ChatSessions = {
  _makeCode(id) {
    // Short human tag e.g. C7A3 — shown to desk for multi-customer clarity
    const n = Number(id) || 0;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let x = (n * 7919 + 104729) % 1000000;
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += alphabet[x % alphabet.length];
      x = Math.floor(x / alphabet.length);
    }
    return code;
  },

  open({
    submission_id = null,
    customer_phone,
    customer_chat_id = null,
    desk_phone,
    desk_chat_id = null,
    company_name = null,
  }) {
    const cust = String(customer_phone || '').replace(/\D/g, '');
    const desk = String(desk_phone || '').replace(/\D/g, '');
    if (!cust || !desk) throw new Error('customer_phone and desk_phone required');

    // One active bridge per customer (not per desk — other customers keep theirs)
    db.prepare(`
      UPDATE chat_sessions
      SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now')
      WHERE customer_phone = ? AND status = 'active'
    `).run(cust);

    const result = db.prepare(`
      INSERT INTO chat_sessions
        (submission_id, customer_phone, customer_chat_id, desk_phone, desk_chat_id, company_name, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(
      submission_id || null,
      cust,
      customer_chat_id || null,
      desk,
      desk_chat_id || null,
      company_name || null
    );

    const id = result.lastInsertRowid;
    const code = this._makeCode(id);
    db.prepare(
      `UPDATE chat_sessions SET session_code = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(code, id);

    return this.get(id);
  },

  get(id) {
    return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id);
  },

  findActiveByCustomer(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return db.prepare(`
      SELECT * FROM chat_sessions
      WHERE status = 'active' AND customer_phone = ?
      ORDER BY opened_at DESC LIMIT 1
    `).get(digits);
  },

  listActiveByDesk(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return [];
    return db.prepare(`
      SELECT * FROM chat_sessions
      WHERE status = 'active' AND desk_phone = ?
      ORDER BY COALESCE(last_customer_msg_at, last_message_at) DESC
    `).all(digits);
  },

  listActiveByDeskChatId(chatId) {
    if (!chatId) return [];
    const id = String(chatId).trim();
    const lidUser = id.replace(/@.+$/, '');
    return db.prepare(`
      SELECT * FROM chat_sessions
      WHERE status = 'active'
        AND desk_chat_id IS NOT NULL
        AND (
          desk_chat_id = ?
          OR desk_chat_id = ?
          OR desk_chat_id LIKE ?
        )
      ORDER BY COALESCE(last_customer_msg_at, last_message_at) DESC
    `).all(id, `${lidUser}@lid`, `${lidUser}@%`);
  },

  /** Match desk by E.164 phone OR WhatsApp @lid / @c.us chat id */
  listActiveByDeskIdentity(phone, chatId) {
    const byPhone = this.listActiveByDesk(phone);
    if (byPhone.length) return byPhone;
    const byChat = this.listActiveByDeskChatId(chatId);
    if (byChat.length) return byChat;
    return [];
  },

  bindDeskChatId(sessionId, chatId) {
    if (!sessionId || !chatId) return sessionId ? this.get(sessionId) : null;
    db.prepare(`
      UPDATE chat_sessions
      SET desk_chat_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(chatId), sessionId);
    return this.get(sessionId);
  },

  bindCustomerChatId(sessionId, chatId) {
    if (!sessionId || !chatId) return sessionId ? this.get(sessionId) : null;
    db.prepare(`
      UPDATE chat_sessions
      SET customer_chat_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(chatId), sessionId);
    return this.get(sessionId);
  },

  findActiveByCode(code) {
    if (!code) return null;
    return db.prepare(`
      SELECT * FROM chat_sessions
      WHERE status = 'active' AND UPPER(session_code) = UPPER(?)
      LIMIT 1
    `).get(String(code).trim());
  },

  findActiveByEitherPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return this.findActiveByCustomer(digits);
  },

  touch(id, { customer_chat_id, desk_chat_id, side } = {}) {
    if (side === 'customer') {
      db.prepare(`
        UPDATE chat_sessions
        SET last_message_at = datetime('now'),
            last_customer_msg_at = datetime('now'),
            updated_at = datetime('now'),
            customer_chat_id = COALESCE(?, customer_chat_id)
        WHERE id = ?
      `).run(customer_chat_id ?? null, id);
    } else if (side === 'desk') {
      db.prepare(`
        UPDATE chat_sessions
        SET last_message_at = datetime('now'),
            last_desk_msg_at = datetime('now'),
            updated_at = datetime('now'),
            desk_chat_id = COALESCE(?, desk_chat_id)
        WHERE id = ?
      `).run(desk_chat_id ?? null, id);
    } else {
      db.prepare(`
        UPDATE chat_sessions
        SET last_message_at = datetime('now'),
            updated_at = datetime('now'),
            customer_chat_id = COALESCE(?, customer_chat_id),
            desk_chat_id = COALESCE(?, desk_chat_id)
        WHERE id = ?
      `).run(customer_chat_id ?? null, desk_chat_id ?? null, id);
    }
    return this.get(id);
  },

  close(id) {
    db.prepare(`
      UPDATE chat_sessions
      SET status = 'closed',
          closed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    const session = this.get(id);
    if (session?.submission_id) {
      try {
        Submissions.clearQuoteRelay(session.submission_id);
      } catch (_) {}
    }
    return session;
  },

  listActive(limit = 50) {
    return db.prepare(`
      SELECT * FROM chat_sessions
      WHERE status = 'active'
      ORDER BY last_message_at DESC
      LIMIT ?
    `).all(limit);
  },

  countActive() {
    return db.prepare(
      "SELECT COUNT(*) AS c FROM chat_sessions WHERE status = 'active'"
    ).get().c;
  },

  /** Record a WhatsApp message id so desk quoted-replies can be routed */
  trackMessage(sessionId, direction, waMessageId, bodyPreview = null) {
    if (!sessionId || !waMessageId) return;
    try {
      db.prepare(`
        INSERT OR REPLACE INTO chat_bridge_messages
          (session_id, direction, wa_message_id, body_preview)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, direction, String(waMessageId), bodyPreview ? String(bodyPreview).slice(0, 200) : null);
    } catch (err) {
      console.warn('[ChatSessions] trackMessage failed:', err.message);
    }
  },

  findSessionByWaMessageId(waMessageId) {
    if (!waMessageId) return null;
    const row = db.prepare(`
      SELECT s.* FROM chat_bridge_messages m
      JOIN chat_sessions s ON s.id = m.session_id
      WHERE m.wa_message_id = ? AND s.status = 'active'
      LIMIT 1
    `).get(String(waMessageId));
    return row || null;
  },

  /**
   * Resolve which customer session a desk message belongs to.
   * Priority: quoted WA id → [#CODE] in body → single active session → last customer speaker.
   */
  resolveDeskInbound(deskPhone, { quotedWaId = null, body = '', chatId = null } = {}) {
    const desk = String(deskPhone || '').replace(/\D/g, '');

    if (quotedWaId) {
      const byQuote = this.findSessionByWaMessageId(quotedWaId);
      if (byQuote) {
        return { session: byQuote, method: 'quoted_reply' };
      }
    }

    const codeMatch = String(body || '').match(/\[#([A-Z0-9]{3,6})\]/i);
    if (codeMatch) {
      const byCode = this.findActiveByCode(codeMatch[1]);
      if (byCode) {
        return { session: byCode, method: 'session_code' };
      }
    }

    const active = this.listActiveByDeskIdentity(desk, chatId);
    if (active.length === 0) return { session: null, method: 'none' };
    if (active.length === 1) return { session: active[0], method: 'single_session' };

    return {
      session: active[0],
      method: 'last_customer_active',
      ambiguous: true,
      candidates: active.length,
    };
  },
};

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

const AccessWhitelist = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM access_whitelist WHERE is_active = 1 ORDER BY created_at DESC'
      : 'SELECT * FROM access_whitelist ORDER BY created_at DESC';
    return db.prepare(sql).all();
  },

  isAllowed(phone) {
    const digits = digitsOnly(phone);
    if (!digits) return false;
    return !!db
      .prepare(
        'SELECT id FROM access_whitelist WHERE is_active = 1 AND phone = ? LIMIT 1'
      )
      .get(digits);
  },

  create({ phone, label = null }) {
    const digits = digitsOnly(phone);
    if (!digits) throw new Error('Phone required');
    db.prepare(
      `INSERT INTO access_whitelist (phone, label) VALUES (?, ?)
       ON CONFLICT(phone) DO UPDATE SET label = excluded.label, is_active = 1`
    ).run(digits, label || null);
    return db.prepare('SELECT * FROM access_whitelist WHERE phone = ?').get(digits);
  },

  update(id, { phone, label, is_active }) {
    const current = db.prepare('SELECT * FROM access_whitelist WHERE id = ?').get(id);
    if (!current) return null;
    const digits =
      phone !== undefined ? digitsOnly(phone) || current.phone : current.phone;
    db.prepare(
      `UPDATE access_whitelist
       SET phone = ?, label = COALESCE(?, label), is_active = COALESCE(?, is_active)
       WHERE id = ?`
    ).run(digits, label ?? null, is_active ?? null, id);
    return db.prepare('SELECT * FROM access_whitelist WHERE id = ?').get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM access_whitelist WHERE id = ?').run(id);
  },
};

const AccessCodes = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM access_codes WHERE is_active = 1 ORDER BY created_at DESC'
      : 'SELECT * FROM access_codes ORDER BY created_at DESC';
    return db.prepare(sql).all();
  },

  normalize(code) {
    return String(code || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toUpperCase();
  },

  findValid(code) {
    const c = this.normalize(code);
    if (!c || c.length < 4) return null;
    const row = db
      .prepare('SELECT * FROM access_codes WHERE is_active = 1 AND UPPER(code) = ? LIMIT 1')
      .get(c);
    if (!row) return null;
    if (row.expires_at) {
      const exp = Date.parse(row.expires_at);
      if (Number.isFinite(exp) && exp < Date.now()) return null;
    }
    if (row.max_uses > 0 && row.use_count >= row.max_uses) return null;
    return row;
  },

  create({ code, label = null, max_uses = 0, expires_at = null }) {
    const c = this.normalize(code);
    if (!c) throw new Error('Code required');
    const result = db
      .prepare(
        `INSERT INTO access_codes (code, label, max_uses, expires_at) VALUES (?, ?, ?, ?)`
      )
      .run(c, label || null, Number(max_uses) || 0, expires_at || null);
    return db.prepare('SELECT * FROM access_codes WHERE id = ?').get(result.lastInsertRowid);
  },

  incrementUse(id) {
    db.prepare(`UPDATE access_codes SET use_count = use_count + 1 WHERE id = ?`).run(id);
  },

  update(id, { code, label, max_uses, is_active, expires_at }) {
    const current = db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id);
    if (!current) return null;
    const c = code !== undefined ? this.normalize(code) : current.code;
    db.prepare(
      `UPDATE access_codes
       SET code = ?,
           label = COALESCE(?, label),
           max_uses = COALESCE(?, max_uses),
           is_active = COALESCE(?, is_active),
           expires_at = ?
       WHERE id = ?`
    ).run(
      c,
      label ?? null,
      max_uses === undefined ? null : Number(max_uses) || 0,
      is_active ?? null,
      expires_at === undefined ? current.expires_at : expires_at || null,
      id
    );
    return db.prepare('SELECT * FROM access_codes WHERE id = ?').get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM access_codes WHERE id = ?').run(id);
  },
};

const AuthorizedPeers = {
  isAuthorized(phone) {
    const digits = digitsOnly(phone);
    if (!digits) return false;
    if (AccessWhitelist.isAllowed(digits)) return true;
    return !!db
      .prepare('SELECT id FROM authorized_peers WHERE phone = ? LIMIT 1')
      .get(digits);
  },

  authorize(phone, { method = 'code', code_used = null } = {}) {
    const digits = digitsOnly(phone);
    if (!digits) throw new Error('Phone required');
    db.prepare(
      `INSERT INTO authorized_peers (phone, method, code_used, authorized_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(phone) DO UPDATE SET
         method = excluded.method,
         code_used = excluded.code_used,
         updated_at = datetime('now')`
    ).run(digits, method, code_used || null);
    return db.prepare('SELECT * FROM authorized_peers WHERE phone = ?').get(digits);
  },

  revoke(phone) {
    const digits = digitsOnly(phone);
    return db.prepare('DELETE FROM authorized_peers WHERE phone = ?').run(digits);
  },

  list() {
    return db
      .prepare('SELECT * FROM authorized_peers ORDER BY authorized_at DESC LIMIT 200')
      .all();
  },
};

module.exports = {
  Settings,
  InsuranceTypes,
  Companies,
  InternalNumbers,
  ChatFlow,
  FormFields,
  Submissions,
  MessageLog,
  Admins,
  Workflows,
  WorkflowRuns,
  ChatSessions,
  AccessWhitelist,
  AccessCodes,
  AuthorizedPeers,
};
