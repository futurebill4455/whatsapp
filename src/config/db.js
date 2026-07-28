const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'insurance.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS insurance_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    insurance_type_id INTEGER,
    desk_phone TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (insurance_type_id) REFERENCES insurance_types(id)
  );

  CREATE TABLE IF NOT EXISTS premium_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS duration_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS life_plan_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS form_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    field_type TEXT NOT NULL,
    is_required INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    options_json TEXT
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    customer_phone TEXT,
    customer_chat_id TEXT,
    customer_name TEXT,
    advisor_name TEXT,
    insurance_type TEXT,
    company TEXT,
    premium_amount TEXT,
    member_count INTEGER,
    members_json TEXT,
    policy_duration TEXT,
    extra_json TEXT,
    status TEXT DEFAULT 'awaiting_form',
    desk_phone TEXT,
    workflow_run_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    submitted_at TEXT,
    forwarded_at TEXT
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    graph_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
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
    session_code TEXT,
    submission_id INTEGER,
    customer_phone TEXT NOT NULL,
    customer_chat_id TEXT,
    desk_phone TEXT NOT NULL,
    desk_chat_id TEXT,
    company_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    last_customer_at TEXT,
    last_desk_at TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    wa_message_id TEXT,
    body TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    phone TEXT,
    body TEXT,
    meta_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaign_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT NOT NULL UNIQUE,
    tags TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    content_type TEXT NOT NULL DEFAULT 'text',
    body_text TEXT,
    image_path TEXT,
    image_mimetype TEXT,
    image_filename TEXT,
    use_quick_replies INTEGER NOT NULL DEFAULT 1,
    delay_min_ms INTEGER NOT NULL DEFAULT 60000,
    delay_max_ms INTEGER NOT NULL DEFAULT 300000,
    batch_size INTEGER NOT NULL DEFAULT 10,
    batch_window_ms INTEGER NOT NULL DEFAULT 300000,
    next_send_at TEXT,
    schedule_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS campaign_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL DEFAULT 0,
    body_text TEXT,
    content_type TEXT NOT NULL DEFAULT 'text',
    image_path TEXT,
    delay_min_ms INTEGER NOT NULL DEFAULT 60000,
    delay_max_ms INTEGER NOT NULL DEFAULT 300000,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS campaign_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    contact_id INTEGER,
    phone TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    current_step INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    sent_at TEXT,
    reply_at TEXT,
    reply_text TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
    ON campaign_recipients(campaign_id, status);
  CREATE INDEX IF NOT EXISTS idx_campaign_contacts_phone
    ON campaign_contacts(phone);
  CREATE INDEX IF NOT EXISTS idx_message_log_phone
    ON message_log(phone, created_at);
  CREATE INDEX IF NOT EXISTS idx_campaign_steps_campaign
    ON campaign_steps(campaign_id, step_order);
`);

// Migrations for existing DBs
const migrations = [
  'ALTER TABLE campaigns ADD COLUMN schedule_at TEXT',
  'ALTER TABLE campaign_recipients ADD COLUMN current_step INTEGER NOT NULL DEFAULT 0',
];
for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (_) {}
}

// Legacy cleanup — per-user whitelist removed in favour of Settings.common_access_code
try {
  db.exec('DROP TABLE IF EXISTS access_users');
} catch (_) {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_customer ON chat_sessions(customer_phone, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_desk ON chat_sessions(desk_phone, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token)`);

module.exports = db;
