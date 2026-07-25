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

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM message_log').get().c;
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
    return db
      .prepare('SELECT id, username, created_at FROM admins WHERE id = ?')
      .get(result.lastInsertRowid);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  },
};

module.exports = {
  Settings,
  MessageLog,
  Admins,
};
