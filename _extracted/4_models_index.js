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

  create({ name, insurance_type_id = null, sort_order = 0 }) {
    const result = db.prepare(
      'INSERT INTO companies (name, insurance_type_id, sort_order) VALUES (?, ?, ?)'
    ).run(name, insurance_type_id || null, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { name, insurance_type_id, is_active, sort_order }) {
    db.prepare(`
      UPDATE companies
      SET name = COALESCE(?, name),
          insurance_type_id = ?,
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(
      name ?? null,
      insurance_type_id === undefined ? this.get(id)?.insurance_type_id : (insurance_type_id || null),
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

  resolveForType(insuranceTypeName) {
    if (insuranceTypeName) {
      const byType = db.prepare(`
        SELECT n.* FROM internal_numbers n
        LEFT JOIN insurance_types t ON t.id = n.insurance_type_id
        WHERE n.is_active = 1 AND LOWER(t.name) = LOWER(?)
        LIMIT 1
      `).get(insuranceTypeName);
      if (byType) return byType;
    }
    return db.prepare(
      'SELECT * FROM internal_numbers WHERE is_active = 1 AND is_default = 1 LIMIT 1'
    ).get() || db.prepare(
      'SELECT * FROM internal_numbers WHERE is_active = 1 ORDER BY id LIMIT 1'
    ).get();
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
    const normalized = String(text || '').trim().toLowerCase();
    const flows = this.list(true);
    return flows.find((f) => {
      const keywords = f.trigger_keyword.split(',').map((k) => k.trim().toLowerCase());
      return keywords.some((k) => k === normalized || normalized.startsWith(k));
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
  create({ token, customer_phone }) {
    db.prepare(
      'INSERT INTO submissions (token, customer_phone, status) VALUES (?, ?, ?)'
    ).run(token, customer_phone, 'awaiting_form');
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
          updated_at = datetime('now')
      WHERE id = ?
    `).run(forwardedTo, id);
    return this.get(id);
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
};
