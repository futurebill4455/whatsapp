const db = require('../config/db');

function safeJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * node:sqlite DatabaseSync has no better-sqlite3-style db.transaction().
 * Use explicit BEGIN / COMMIT / ROLLBACK instead.
 */
function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}

/** Strip non-digits. Also strips WhatsApp JID suffixes (@c.us / @lid / @s.whatsapp.net). */
function digitsOnly(phone) {
  let s = String(phone || '').trim();
  // Common WA JID / URL shapes
  s = s.replace(/@.+$/, '');
  s = s.replace(/^whatsapp:/i, '');
  return s.replace(/\D/g, '');
}

/**
 * Build comparable phone keys so +91 / 91 / local 10-digit / spaces / @c.us all match.
 * Example: +919562233772, 919562233772@c.us, 9562233772 → share key 9562233772
 */
function phoneMatchKeys(phone) {
  const d = digitsOnly(phone);
  if (!d) return [];
  // LID-like opaque ids are often 14–16+ digits and are NOT phone numbers — keep as-is only
  const keys = new Set([d]);

  if (d.length >= 10) keys.add(d.slice(-10));

  if (d.length === 10) {
    keys.add(`91${d}`);
    keys.add(`0${d}`);
  }
  if (d.startsWith('91') && d.length >= 12 && d.length <= 15) {
    keys.add(d.slice(2));
    keys.add(d.slice(-10));
  }
  if (d.startsWith('0') && d.length >= 11) {
    keys.add(d.slice(1));
    keys.add(d.slice(-10));
  }
  // India mobile often starts with 6–9 after country code
  if (d.length > 10 && d.length <= 15) {
    keys.add(d.slice(-10));
  }

  return [...keys].filter(Boolean);
}

/** True when two phone strings refer to the same handset. */
function phonesMatch(a, b) {
  const ka = phoneMatchKeys(a);
  if (!ka.length) return false;
  const kb = new Set(phoneMatchKeys(b));
  return ka.some((k) => kb.has(k));
}

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
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  },

  setMany(obj) {
    const entries = Object.entries(obj || {});
    if (!entries.length) return;
    const stmt = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    runInTransaction(() => {
      for (const [key, value] of entries) {
        stmt.run(key, String(value));
      }
    });
  },
};

const Admins = {
  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  },

  create({ username, password_hash }) {
    const result = db
      .prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
      .run(username, password_hash);
    return db
      .prepare('SELECT id, username, created_at FROM admins WHERE id = ?')
      .get(result.lastInsertRowid);
  },

  findByUsername(username) {
    return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  },
};

/**
 * Authorized users: Name + Phone + Unique Access Code (from admin panel).
 * Unlock is driven by live DB access_code values — never a hardcoded list.
 */
const AccessUsers = {
  digitsOnly,
  phoneMatchKeys,
  phonesMatch,

  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM access_users WHERE is_active = 1 ORDER BY name COLLATE NOCASE, id'
      : 'SELECT * FROM access_users ORDER BY name COLLATE NOCASE, id';
    return db.prepare(sql).all();
  },

  get(id) {
    return db.prepare('SELECT * FROM access_users WHERE id = ?').get(id);
  },

  findByPhone(phone) {
    // Accept raw JIDs like 919562233772@c.us or +91 95622 33772
    const digits = digitsOnly(phone);
    if (!digits) return null;

    // Opaque @lid ids can look numeric but are not MSISDNs — still try last-10 match
    const incomingKeys = new Set(phoneMatchKeys(digits));
    if (!incomingKeys.size) return null;

    // Fast path: exact stored phone
    const exact = db
      .prepare('SELECT * FROM access_users WHERE is_active = 1 AND phone = ? LIMIT 1')
      .get(digits);
    if (exact) return exact;

    // Try every variant key against DB (91… / last-10 / etc.)
    for (const key of incomingKeys) {
      const row = db
        .prepare('SELECT * FROM access_users WHERE is_active = 1 AND phone = ? LIMIT 1')
        .get(key);
      if (row) return row;
    }

    // Slow path: flexible compare against every active user
    const active = this.list(true);
    for (const user of active) {
      if (phonesMatch(digits, user.phone)) return user;
    }
    return null;
  },

  /**
   * Normalize access codes for storage + comparison.
   * Keeps A–Z / 0–9 only. " insu-2026 " → "INSU2026"
   */
  normalizeCode(code) {
    return String(code || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  },

  /** Candidate codes from an inbound WhatsApp body (bare code or short phrase). */
  codeCandidatesFromMessage(raw) {
    const text = String(raw || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const out = [];
    const push = (v) => {
      const n = this.normalizeCode(v);
      if (n && n.length >= 3 && !out.includes(n)) out.push(n);
    };
    if (!text) return out;
    push(text);
    for (const tok of text.split(/[\s,;|:@#]+/)) push(tok);
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length > 1) push(parts[parts.length - 1]);
    return out;
  },

  /** Look up any active user by their stored access_code (dynamic DB). */
  findByAccessCode(codeInput) {
    const code = this.normalizeCode(codeInput);
    if (!code || code.length < 3) return null;

    const exact = db
      .prepare(
        `SELECT * FROM access_users
         WHERE is_active = 1
           AND UPPER(REPLACE(REPLACE(REPLACE(REPLACE(access_code,'-',''),' ',''),'_',''),'/','')) = ?
         LIMIT 1`
      )
      .get(code);
    if (exact) return exact;

    for (const user of this.list(true)) {
      if (this.normalizeCode(user.access_code) === code) return user;
    }
    return null;
  },

  messageMatchesUserCode(user, messageBody) {
    if (!user) return false;
    const want = this.normalizeCode(user.access_code);
    if (!want) return false;
    return this.codeCandidatesFromMessage(messageBody).includes(want);
  },

  isUnlocked(phone) {
    const user = this.findByPhone(phone);
    if (!user) return false;
    if (user.status === 'active') return true;
    return !!user.verified_at;
  },

  displayStatus(user) {
    if (!user) return 'unknown';
    if (!user.is_active) return 'inactive';
    if (user.status === 'active' || user.verified_at) return 'active';
    return 'waiting_code';
  },

  _activateUser(userId) {
    db.prepare(
      `UPDATE access_users
       SET status = 'active',
           verified_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(userId);
    return this.get(userId);
  },

  /**
   * Unlock when inbound text matches a live DB access_code.
   * Code-first (admin dynamic codes); phone must agree when both resolve.
   */
  tryUnlock(phone, codeInput) {
    const candidates = this.codeCandidatesFromMessage(codeInput);
    if (!candidates.length) {
      return { ok: false, reason: 'invalid_input' };
    }

    let userByCode = null;
    let matchedCandidate = null;
    for (const c of candidates) {
      const found = this.findByAccessCode(c);
      if (found) {
        userByCode = found;
        matchedCandidate = c;
        break;
      }
    }

    const userByPhone = phone ? this.findByPhone(phone) : null;

    // Already active on this phone — only treat as unlock if they resent their code
    if (userByPhone && (userByPhone.status === 'active' || userByPhone.verified_at)) {
      if (this.messageMatchesUserCode(userByPhone, codeInput)) {
        return {
          ok: true,
          user: userByPhone,
          reason: 'already_active',
          matchedCode: this.normalizeCode(userByPhone.access_code),
        };
      }
      return { ok: false, reason: 'unlocked_noise', user: userByPhone };
    }

    if (!userByCode) {
      if (userByPhone) return { ok: false, reason: 'wrong_code', user: userByPhone };
      return { ok: false, reason: 'unknown_code' };
    }

    if (
      userByPhone &&
      userByPhone.id !== userByCode.id &&
      !phonesMatch(userByPhone.phone, userByCode.phone)
    ) {
      console.warn(
        `[Access] Code ${matchedCandidate} belongs to #${userByCode.id} but phone matched #${userByPhone.id}`
      );
      return { ok: false, reason: 'phone_code_mismatch', user: userByPhone };
    }

    if (!userByPhone && phone) {
      console.warn(
        `[Access] Code ${matchedCandidate} matched #${userByCode.id} (${userByCode.phone}); inbound phone "${phone}" not in DB — unlocking by code`
      );
    }

    if (userByCode.status === 'active' || userByCode.verified_at) {
      return {
        ok: true,
        user: userByCode,
        reason: 'already_active',
        matchedCode: matchedCandidate,
      };
    }

    const activated = this._activateUser(userByCode.id);
    console.log(
      `[Access] Unlocked #${activated.id} (${activated.phone}) via code ${matchedCandidate}`
    );
    return {
      ok: true,
      user: activated,
      reason: 'unlocked',
      matchedCode: matchedCandidate,
    };
  },

  create({ name, phone, access_code }) {
    let digits = digitsOnly(phone);
    const code = this.normalizeCode(access_code);
    const displayName = String(name || '').trim();
    if (!displayName) throw new Error('Name is required');
    if (!digits) throw new Error('Phone number is required');
    if (!code || code.length < 3) {
      throw new Error('Access code must be at least 3 characters');
    }

    if (digits.length === 10) digits = `91${digits}`;

    if (this.findByAccessCode(code)) {
      throw new Error('Access code already in use');
    }

    const result = db
      .prepare(
        `INSERT INTO access_users (name, phone, access_code, status)
         VALUES (?, ?, ?, 'waiting_code')`
      )
      .run(displayName, digits, code);
    return this.get(result.lastInsertRowid);
  },

  update(id, { name, phone, access_code, is_active, clear_verified }) {
    const current = this.get(id);
    if (!current) return null;
    let digits =
      phone !== undefined ? digitsOnly(phone) || current.phone : current.phone;
    if (phone !== undefined && digits && digits.length === 10) {
      digits = `91${digits}`;
    }
    const code =
      access_code !== undefined
        ? this.normalizeCode(access_code) || this.normalizeCode(current.access_code)
        : this.normalizeCode(current.access_code) || current.access_code;
    const displayName =
      name !== undefined ? String(name || '').trim() || current.name : current.name;

    if (access_code !== undefined) {
      const other = this.findByAccessCode(code);
      if (other && other.id !== id) {
        throw new Error('Access code already in use');
      }
    }

    db.prepare(
      `UPDATE access_users
       SET name = ?,
           phone = ?,
           access_code = ?,
           is_active = COALESCE(?, is_active),
           verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END,
           status = CASE WHEN ? = 1 THEN 'waiting_code' ELSE status END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      displayName,
      digits,
      code,
      is_active ?? null,
      clear_verified ? 1 : 0,
      clear_verified ? 1 : 0,
      id
    );
    return this.get(id);
  },

  lock(phone) {
    const user = this.findByPhone(phone);
    if (user) {
      db.prepare(
        `UPDATE access_users
         SET verified_at = NULL,
             status = 'waiting_code',
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(user.id);
      return this.get(user.id);
    }
    const digits = digitsOnly(phone);
    db.prepare(
      `UPDATE access_users
       SET verified_at = NULL,
           status = 'waiting_code',
           updated_at = datetime('now')
       WHERE phone = ?`
    ).run(digits);
    return this.findByPhone(digits);
  },

  remove(id) {
    return db.prepare('DELETE FROM access_users WHERE id = ?').run(id);
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
    const result = db
      .prepare('INSERT INTO insurance_types (name, sort_order) VALUES (?, ?)')
      .run(name, sort_order);
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
    let sql =
      'SELECT c.*, t.name AS insurance_type_name FROM companies c LEFT JOIN insurance_types t ON t.id = c.insurance_type_id';
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
    return db
      .prepare(
        'SELECT * FROM companies WHERE is_active = 1 AND LOWER(name) = LOWER(?) LIMIT 1'
      )
      .get(String(name).trim());
  },

  create({ name, insurance_type_id = null, desk_phone = null, sort_order = 0 }) {
    const phone = desk_phone ? digitsOnly(desk_phone) : null;
    const result = db
      .prepare(
        'INSERT INTO companies (name, insurance_type_id, desk_phone, sort_order) VALUES (?, ?, ?, ?)'
      )
      .run(name, insurance_type_id || null, phone || null, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { name, insurance_type_id, desk_phone, is_active, sort_order }) {
    const current = this.get(id);
    const phone =
      desk_phone !== undefined
        ? desk_phone
          ? digitsOnly(desk_phone)
          : null
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
      insurance_type_id === undefined
        ? current?.insurance_type_id
        : insurance_type_id || null,
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

const PremiumOptions = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM premium_options WHERE is_active = 1 ORDER BY sort_order, id'
      : 'SELECT * FROM premium_options ORDER BY sort_order, id';
    return db.prepare(sql).all();
  },

  get(id) {
    return db.prepare('SELECT * FROM premium_options WHERE id = ?').get(id);
  },

  create({ label, value, sort_order = 0 }) {
    const result = db
      .prepare(
        'INSERT INTO premium_options (label, value, sort_order) VALUES (?, ?, ?)'
      )
      .run(label, value, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { label, value, is_active, sort_order }) {
    db.prepare(`
      UPDATE premium_options
      SET label = COALESCE(?, label),
          value = COALESCE(?, value),
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(label ?? null, value ?? null, is_active ?? null, sort_order ?? null, id);
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM premium_options WHERE id = ?').run(id);
  },
};

const DurationOptions = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM duration_options WHERE is_active = 1 ORDER BY sort_order, id'
      : 'SELECT * FROM duration_options ORDER BY sort_order, id';
    return db.prepare(sql).all();
  },

  get(id) {
    return db.prepare('SELECT * FROM duration_options WHERE id = ?').get(id);
  },

  create({ label, value, sort_order = 0 }) {
    const result = db
      .prepare(
        'INSERT INTO duration_options (label, value, sort_order) VALUES (?, ?, ?)'
      )
      .run(label, value, sort_order);
    return this.get(result.lastInsertRowid);
  },

  update(id, { label, value, is_active, sort_order }) {
    db.prepare(`
      UPDATE duration_options
      SET label = COALESCE(?, label),
          value = COALESCE(?, value),
          is_active = COALESCE(?, is_active),
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `).run(label ?? null, value ?? null, is_active ?? null, sort_order ?? null, id);
    return this.get(id);
  },

  remove(id) {
    return db.prepare('DELETE FROM duration_options WHERE id = ?').run(id);
  },
};

const FormFields = {
  list(activeOnly = false) {
    const sql = activeOnly
      ? 'SELECT * FROM form_fields WHERE is_active = 1 ORDER BY sort_order, id'
      : 'SELECT * FROM form_fields ORDER BY sort_order, id';
    return db.prepare(sql).all().map((f) => ({
      ...f,
      options: f.options_json ? safeJson(f.options_json, null) : null,
    }));
  },

  get(id) {
    const f = db.prepare('SELECT * FROM form_fields WHERE id = ?').get(id);
    if (!f) return null;
    return { ...f, options: f.options_json ? safeJson(f.options_json, null) : null };
  },

  create({
    field_key,
    label,
    field_type = 'text',
    options = null,
    is_required = 1,
    sort_order = 0,
  }) {
    const result = db
      .prepare(
        `INSERT INTO form_fields
          (field_key, label, field_type, options_json, is_required, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        field_key,
        label,
        field_type,
        options ? JSON.stringify(options) : null,
        is_required ? 1 : 0,
        sort_order
      );
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
      data.options !== undefined
        ? data.options
          ? JSON.stringify(data.options)
          : null
        : current.options_json,
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
  create({ token, customer_phone, customer_chat_id = null, workflow_run_id = null }) {
    db.prepare(
      `INSERT INTO submissions
        (token, customer_phone, customer_chat_id, status, workflow_run_id)
       VALUES (?, ?, ?, 'awaiting_form', ?)`
    ).run(
      token,
      digitsOnly(customer_phone) || customer_phone || null,
      customer_chat_id || null,
      workflow_run_id
    );
    return this.getByToken(token);
  },

  getByToken(token) {
    return db.prepare('SELECT * FROM submissions WHERE token = ?').get(token);
  },

  get(id) {
    return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  },

  findLatestOpen(phone) {
    const digits = digitsOnly(phone);
    const openStatuses = "('awaiting_form', 'awaiting_confirmation', 'submitted')";
    if (digits) {
      const row = db
        .prepare(
          `SELECT * FROM submissions
           WHERE customer_phone = ? AND status IN ${openStatuses}
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(digits);
      if (row) return row;
    }
    const recent = db
      .prepare(
        `SELECT * FROM submissions
         WHERE status IN ${openStatuses}
         ORDER BY updated_at DESC LIMIT 40`
      )
      .all();
    return recent.find((r) => phonesMatch(r.customer_phone, phone)) || null;
  },

  submitForm(
    token,
    {
      customer_name = null,
      advisor_name = null,
      insurance_type = null,
      company = null,
      premium_amount = null,
      member_count = null,
      members = null,
      members_json = null,
      policy_duration = null,
      extra = null,
      extra_json = null,
    } = {}
  ) {
    const membersPayload =
      members_json != null
        ? typeof members_json === 'string'
          ? members_json
          : JSON.stringify(members_json)
        : members != null
          ? JSON.stringify(members)
          : null;
    const extraPayload =
      extra_json != null
        ? typeof extra_json === 'string'
          ? extra_json
          : JSON.stringify(extra_json)
        : extra != null
          ? JSON.stringify(extra)
          : null;

    db.prepare(`
      UPDATE submissions
      SET customer_name = COALESCE(?, customer_name),
          advisor_name = COALESCE(?, advisor_name),
          insurance_type = COALESCE(?, insurance_type),
          company = COALESCE(?, company),
          premium_amount = COALESCE(?, premium_amount),
          member_count = COALESCE(?, member_count),
          members_json = COALESCE(?, members_json),
          policy_duration = COALESCE(?, policy_duration),
          extra_json = COALESCE(?, extra_json),
          status = 'submitted',
          submitted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE token = ?
    `).run(
      customer_name,
      advisor_name,
      insurance_type,
      company,
      premium_amount,
      member_count,
      membersPayload,
      policy_duration,
      extraPayload,
      token
    );
    return this.getByToken(token);
  },

  markForwarded(id, deskPhone) {
    const desk = deskPhone ? digitsOnly(deskPhone) : null;
    db.prepare(`
      UPDATE submissions
      SET status = 'forwarded',
          desk_phone = COALESCE(?, desk_phone),
          forwarded_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(desk, id);
    return this.get(id);
  },

  markConfirmed(id) {
    db.prepare(`
      UPDATE submissions
      SET status = 'confirmed',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    return this.get(id);
  },

  setCustomerChatId(token, chatId) {
    db.prepare(
      `UPDATE submissions SET customer_chat_id = ?, updated_at = datetime('now') WHERE token = ?`
    ).run(chatId || null, token);
    return this.getByToken(token);
  },

  list({ status = null, limit = 100 } = {}) {
    if (status) {
      return db
        .prepare(
          'SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT ?'
        )
        .all(status, limit);
    }
    return db
      .prepare('SELECT * FROM submissions ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  },

  stats() {
    return {
      total: db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c,
      awaiting_form: db
        .prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'awaiting_form'")
        .get().c,
      submitted: db
        .prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'submitted'")
        .get().c,
      confirmed: db
        .prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'confirmed'")
        .get().c,
      forwarded: db
        .prepare("SELECT COUNT(*) AS c FROM submissions WHERE status = 'forwarded'")
        .get().c,
      today: db
        .prepare(
          "SELECT COUNT(*) AS c FROM submissions WHERE date(created_at) = date('now')"
        )
        .get().c,
    };
  },
};

const Workflows = {
  list() {
    return db
      .prepare(
        'SELECT id, name, description, is_active, created_at, updated_at FROM workflows ORDER BY is_active DESC, updated_at DESC'
      )
      .all();
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
    const row = db
      .prepare(
        'SELECT * FROM workflows WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
      )
      .get();
    if (!row) return null;
    return {
      ...row,
      graph: safeJson(row.graph_json, { drawflow: { Home: { data: {} } } }),
    };
  },

  create({ name, description = '', graph = null, is_active = 0 }) {
    const graph_json = JSON.stringify(
      graph || { drawflow: { Home: { data: {} } } }
    );
    const result = db
      .prepare(
        'INSERT INTO workflows (name, description, graph_json, is_active) VALUES (?, ?, ?, ?)'
      )
      .run(name, description, graph_json, is_active ? 1 : 0);
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
      is_active === undefined ? null : is_active ? 1 : 0,
      id
    );
    return this.get(id);
  },

  saveGraph(id, graph) {
    db.prepare(
      `UPDATE workflows SET graph_json = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(graph), id);
    return this.get(id);
  },

  setActive(id) {
    runInTransaction(() => {
      db.prepare('UPDATE workflows SET is_active = 0').run();
      db.prepare(
        `UPDATE workflows SET is_active = 1, updated_at = datetime('now') WHERE id = ?`
      ).run(id);
    });
    return this.get(id);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM workflows').get().c;
  },
};

const WorkflowRuns = {
  create({ workflow_id, customer_phone, submission_token = null, context = {} }) {
    const result = db
      .prepare(
        `INSERT INTO workflow_runs
          (workflow_id, customer_phone, submission_token, status, context_json)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(
        workflow_id,
        digitsOnly(customer_phone) || customer_phone,
        submission_token,
        JSON.stringify(context)
      );
    return this.get(result.lastInsertRowid);
  },

  get(id) {
    const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, context: safeJson(row.context_json, {}) };
  },

  findWaiting(phone, waitingFor) {
    const digits = digitsOnly(phone);
    if (digits) {
      const exact = db
        .prepare(
          `SELECT * FROM workflow_runs
           WHERE customer_phone = ? AND status = 'waiting' AND waiting_for = ?
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(digits, waitingFor);
      if (exact) return exact;
    }
    const recent = db
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE status = 'waiting' AND waiting_for = ?
         ORDER BY updated_at DESC LIMIT 40`
      )
      .all(waitingFor);
    const row = recent.find((r) => phonesMatch(r.customer_phone, phone));
    return row || null;
  },

  update(id, fields) {
    const run = this.get(id);
    if (!run) return null;
    const context_json =
      fields.context !== undefined
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

/**
 * Persistent two-way bridge between a customer and a company desk.
 * Routing priority for desk inbound: quoted WA id → [#CODE] → last-active.
 */
const ChatSessions = {
  _makeCode(id) {
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

  /** True when phone matches any active company desk_phone. */
  isDeskPhone(phone) {
    const digits = digitsOnly(phone);
    if (!digits) return false;
    const desks = db
      .prepare(
        `SELECT desk_phone FROM companies
         WHERE is_active = 1 AND desk_phone IS NOT NULL AND desk_phone != ''`
      )
      .all();
    return desks.some((row) => phonesMatch(row.desk_phone, digits));
  },

  open({
    submission_id = null,
    customer_phone,
    customer_chat_id = null,
    desk_phone,
    desk_chat_id = null,
    company_name = null,
  }) {
    const cust = digitsOnly(customer_phone);
    const desk = digitsOnly(desk_phone);
    if (!cust || !desk) throw new Error('customer_phone and desk_phone required');

    db.prepare(`
      UPDATE chat_sessions
      SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now')
      WHERE customer_phone = ? AND status = 'active'
    `).run(cust);

    const result = db
      .prepare(
        `INSERT INTO chat_sessions
          (submission_id, customer_phone, customer_chat_id, desk_phone, desk_chat_id, company_name, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
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
    const digits = digitsOnly(phone);
    if (!digits) return null;
    const exact = db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE status = 'active' AND customer_phone = ?
         ORDER BY opened_at DESC LIMIT 1`
      )
      .get(digits);
    if (exact) return exact;
    const active = db
      .prepare(
        `SELECT * FROM chat_sessions WHERE status = 'active' ORDER BY opened_at DESC LIMIT 50`
      )
      .all();
    return active.find((s) => phonesMatch(s.customer_phone, phone)) || null;
  },

  listActiveByDesk(phone) {
    const digits = digitsOnly(phone);
    if (!digits) return [];
    const exact = db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE status = 'active' AND desk_phone = ?
         ORDER BY COALESCE(last_customer_at, last_desk_at, opened_at) DESC`
      )
      .all(digits);
    if (exact.length) return exact;
    const active = db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE status = 'active'
         ORDER BY COALESCE(last_customer_at, last_desk_at, opened_at) DESC`
      )
      .all();
    return active.filter((s) => phonesMatch(s.desk_phone, phone));
  },

  listActive(limit = 50) {
    return db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE status = 'active'
         ORDER BY COALESCE(last_customer_at, last_desk_at, opened_at) DESC
         LIMIT ?`
      )
      .all(limit);
  },

  findActiveByCode(code) {
    if (!code) return null;
    return db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE status = 'active' AND UPPER(session_code) = UPPER(?)
         LIMIT 1`
      )
      .get(String(code).trim());
  },

  findSessionByWaMessageId(waMessageId) {
    if (!waMessageId) return null;
    return (
      db
        .prepare(
          `SELECT s.* FROM chat_session_messages m
           JOIN chat_sessions s ON s.id = m.session_id
           WHERE m.wa_message_id = ? AND s.status = 'active'
           ORDER BY m.id DESC LIMIT 1`
        )
        .get(String(waMessageId)) || null
    );
  },

  /**
   * Resolve which customer session a desk message belongs to.
   * Priority: quoted WA id → [#CODE] in body → last-active (or single session).
   */
  resolveDeskInbound(deskPhone, { quotedWaId = null, body = '', chatId = null } = {}) {
    if (quotedWaId) {
      const byQuote = this.findSessionByWaMessageId(quotedWaId);
      if (byQuote) return { session: byQuote, method: 'quoted_reply' };
    }

    const codeMatch = String(body || '').match(/\[#([A-Z0-9]{3,8})\]/i);
    if (codeMatch) {
      const byCode = this.findActiveByCode(codeMatch[1]);
      if (byCode) return { session: byCode, method: 'session_code' };
    }

    let active = this.listActiveByDesk(deskPhone);
    if (!active.length && chatId) {
      const id = String(chatId).trim();
      const lidUser = id.replace(/@.+$/, '');
      active = db
        .prepare(
          `SELECT * FROM chat_sessions
           WHERE status = 'active'
             AND desk_chat_id IS NOT NULL
             AND (
               desk_chat_id = ?
               OR desk_chat_id = ?
               OR desk_chat_id LIKE ?
             )
           ORDER BY COALESCE(last_customer_at, last_desk_at, opened_at) DESC`
        )
        .all(id, `${lidUser}@lid`, `${lidUser}@%`);
    }

    if (active.length === 0) return { session: null, method: 'none' };
    if (active.length === 1) return { session: active[0], method: 'single_session' };

    return {
      session: active[0],
      method: 'last_customer_active',
      ambiguous: true,
      candidates: active.length,
    };
  },

  close(id) {
    db.prepare(`
      UPDATE chat_sessions
      SET status = 'closed',
          closed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    return this.get(id);
  },

  touch(id, { customer_chat_id, desk_chat_id, side } = {}) {
    if (side === 'customer') {
      db.prepare(`
        UPDATE chat_sessions
        SET last_customer_at = datetime('now'),
            updated_at = datetime('now'),
            customer_chat_id = COALESCE(?, customer_chat_id)
        WHERE id = ?
      `).run(customer_chat_id ?? null, id);
    } else if (side === 'desk') {
      db.prepare(`
        UPDATE chat_sessions
        SET last_desk_at = datetime('now'),
            updated_at = datetime('now'),
            desk_chat_id = COALESCE(?, desk_chat_id)
        WHERE id = ?
      `).run(desk_chat_id ?? null, id);
    } else {
      db.prepare(`
        UPDATE chat_sessions
        SET updated_at = datetime('now'),
            customer_chat_id = COALESCE(?, customer_chat_id),
            desk_chat_id = COALESCE(?, desk_chat_id)
        WHERE id = ?
      `).run(customer_chat_id ?? null, desk_chat_id ?? null, id);
    }
    return this.get(id);
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

  bindDeskChatId(sessionId, chatId) {
    if (!sessionId || !chatId) return sessionId ? this.get(sessionId) : null;
    db.prepare(`
      UPDATE chat_sessions
      SET desk_chat_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(String(chatId), sessionId);
    return this.get(sessionId);
  },

  trackMessage(sessionId, direction, waMessageId, body = null) {
    if (!sessionId) return;
    try {
      db.prepare(
        `INSERT INTO chat_session_messages (session_id, direction, wa_message_id, body)
         VALUES (?, ?, ?, ?)`
      ).run(
        sessionId,
        direction,
        waMessageId ? String(waMessageId) : null,
        body != null ? String(body).slice(0, 2000) : null
      );
    } catch (err) {
      console.warn('[ChatSessions] trackMessage failed:', err.message);
    }
  },

  countActive() {
    return db
      .prepare("SELECT COUNT(*) AS c FROM chat_sessions WHERE status = 'active'")
      .get().c;
  },
};

const MessageLog = {
  add({ direction, phone, body, meta = null }) {
    db.prepare(
      'INSERT INTO message_log (direction, phone, body, meta_json) VALUES (?, ?, ?, ?)'
    ).run(
      direction,
      phone != null ? digitsOnly(phone) || String(phone) : null,
      body,
      meta ? JSON.stringify(meta) : null
    );
  },

  recent(limit = 50) {
    return db
      .prepare('SELECT * FROM message_log ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  },

  /**
   * Count outbound messages since a SQLite datetime modifier (e.g. '-1 hour').
   * Pass phone=null for global outbound volume.
   */
  countOutboundSince(phone, sinceModifier = '-1 hour') {
    const mod = String(sinceModifier || '-1 hour').replace(/[^a-z0-9 +\-]/gi, '');
    const digits = phone != null ? digitsOnly(phone) : '';
    if (digits) {
      return db
        .prepare(
          `SELECT COUNT(*) AS c FROM message_log
           WHERE direction = 'out'
             AND phone = ?
             AND created_at >= datetime('now', ?)`
        )
        .get(digits, mod).c;
    }
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM message_log
         WHERE direction = 'out'
           AND created_at >= datetime('now', ?)`
      )
      .get(mod).c;
  },
};

module.exports = {
  Settings,
  Admins,
  AccessUsers,
  InsuranceTypes,
  Companies,
  PremiumOptions,
  DurationOptions,
  FormFields,
  Submissions,
  Workflows,
  WorkflowRuns,
  ChatSessions,
  MessageLog,
  digitsOnly,
  phoneMatchKeys,
  phonesMatch,
};
