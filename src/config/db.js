const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'insurance.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS insurance_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      insurance_type_id INTEGER,
      desk_phone TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (insurance_type_id) REFERENCES insurance_types(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS internal_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      phone TEXT NOT NULL,
      insurance_type_id INTEGER,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (insurance_type_id) REFERENCES insurance_types(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS chat_flow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_keyword TEXT NOT NULL,
      response_template TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS form_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text',
      options_json TEXT,
      is_required INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      customer_phone TEXT NOT NULL,
      customer_name TEXT,
      insurance_type TEXT,
      company TEXT,
      extra_data TEXT,
      status TEXT DEFAULT 'pending',
      form_submitted_at TEXT,
      confirmed_at TEXT,
      forwarded_at TEXT,
      forwarded_to TEXT,
      customer_chat_id TEXT,
      quote_relay_active INTEGER DEFAULT 0,
      workflow_run_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      phone TEXT NOT NULL,
      body TEXT,
      meta TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      graph_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      customer_phone TEXT NOT NULL,
      submission_token TEXT,
      status TEXT DEFAULT 'running',
      current_node_id TEXT,
      waiting_for TEXT,
      context_json TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER,
      customer_phone TEXT NOT NULL,
      customer_chat_id TEXT,
      desk_phone TEXT NOT NULL,
      desk_chat_id TEXT,
      company_name TEXT,
      session_code TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      last_message_at TEXT DEFAULT (datetime('now')),
      last_customer_msg_at TEXT,
      last_desk_msg_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS chat_bridge_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      wa_message_id TEXT NOT NULL UNIQUE,
      body_preview TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS access_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      access_code TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'waiting_code',
      verified_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Lightweight migrations for existing DBs
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN workflow_run_id INTEGER`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE companies ADD COLUMN desk_phone TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN customer_chat_id TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE submissions ADD COLUMN quote_relay_active INTEGER DEFAULT 0`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN session_code TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN last_customer_msg_at TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE chat_sessions ADD COLUMN last_desk_msg_at TEXT`);
  } catch (_) {}
  try {
    db.exec(`ALTER TABLE access_users ADD COLUMN status TEXT NOT NULL DEFAULT 'waiting_code'`);
  } catch (_) {}
  try {
    db.exec(`
      UPDATE access_users
      SET status = 'active'
      WHERE verified_at IS NOT NULL AND TRIM(verified_at) != ''
    `);
    db.exec(`
      UPDATE access_users
      SET status = 'waiting_code'
      WHERE verified_at IS NULL OR TRIM(COALESCE(verified_at, '')) = ''
    `);
  } catch (_) {}

  // Indexes after migrations so existing DBs get new columns first
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_customer ON chat_sessions(customer_phone, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_desk ON chat_sessions(desk_phone, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_code ON chat_sessions(session_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_msg_wa ON chat_bridge_messages(wa_message_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bridge_msg_session ON chat_bridge_messages(session_id)`);
  } catch (err) {
    console.warn('[DB] Index create warning:', err.message);
  }
}

initSchema();

/**
 * Thin compatibility layer so models can keep a better-sqlite3-like API
 * while using Node's built-in node:sqlite (no native compile required).
 */
const api = {
  name: dbPath,
  exec(sql) {
    return db.exec(sql);
  },
  prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      get(...params) {
        return stmt.get(...params);
      },
      all(...params) {
        return stmt.all(...params);
      },
      run(...params) {
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
    };
  },
  transaction(fn) {
    return (...args) => {
      db.exec('BEGIN');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
  },
};

module.exports = api;
