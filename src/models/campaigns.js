/**
 * Campaign contacts, campaigns, and recipients — bulk messaging models.
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const MEDIA_DIR = path.join(process.cwd(), 'data', 'campaign-media');

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

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

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
  return MEDIA_DIR;
}

function normalizePhone(phone) {
  return digitsOnly(phone) || '';
}

const CampaignContacts = {
  list({ q = '', limit = 500, offset = 0 } = {}) {
    const needle = String(q || '').trim();
    if (needle) {
      const like = `%${needle}%`;
      return db
        .prepare(
          `SELECT * FROM campaign_contacts
           WHERE phone LIKE ? OR IFNULL(name,'') LIKE ? OR IFNULL(tags,'') LIKE ?
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`
        )
        .all(like, like, like, limit, offset);
    }
    return db
      .prepare(
        `SELECT * FROM campaign_contacts ORDER BY updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
  },

  count(q = '') {
    const needle = String(q || '').trim();
    if (needle) {
      const like = `%${needle}%`;
      return db
        .prepare(
          `SELECT COUNT(*) AS c FROM campaign_contacts
           WHERE phone LIKE ? OR IFNULL(name,'') LIKE ? OR IFNULL(tags,'') LIKE ?`
        )
        .get(like, like, like).c;
    }
    return db.prepare('SELECT COUNT(*) AS c FROM campaign_contacts').get().c;
  },

  get(id) {
    return db.prepare('SELECT * FROM campaign_contacts WHERE id = ?').get(id);
  },

  findByPhone(phone) {
    const p = normalizePhone(phone);
    if (!p) return null;
    return db
      .prepare('SELECT * FROM campaign_contacts WHERE phone = ?')
      .get(p);
  },

  upsert({ name = null, phone, tags = null, source = 'manual' }) {
    const p = normalizePhone(phone);
    if (!p || p.length < 8) {
      throw new Error(`Invalid phone: ${phone}`);
    }
    const existing = this.findByPhone(p);
    if (existing) {
      db.prepare(
        `UPDATE campaign_contacts
         SET name = COALESCE(?, name),
             tags = COALESCE(?, tags),
             source = COALESCE(?, source),
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(name || null, tags || null, source || null, existing.id);
      return this.get(existing.id);
    }
    const result = db
      .prepare(
        `INSERT INTO campaign_contacts (name, phone, tags, source)
         VALUES (?, ?, ?, ?)`
      )
      .run(name || null, p, tags || null, source || 'manual');
    return this.get(result.lastInsertRowid);
  },

  /**
   * Bulk upsert rows: [{ name, phone, tags }]
   * @returns {{ inserted: number, updated: number, skipped: number, errors: string[] }}
   */
  upsertMany(rows, source = 'import') {
    const stats = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    runInTransaction(() => {
      for (const row of rows || []) {
        try {
          const p = normalizePhone(row.phone);
          if (!p || p.length < 8) {
            stats.skipped += 1;
            continue;
          }
          const existing = this.findByPhone(p);
          if (existing) {
            db.prepare(
              `UPDATE campaign_contacts
               SET name = COALESCE(?, name),
                   tags = COALESCE(?, tags),
                   source = ?,
                   updated_at = datetime('now')
               WHERE id = ?`
            ).run(row.name || null, row.tags || null, source, existing.id);
            stats.updated += 1;
          } else {
            db.prepare(
              `INSERT INTO campaign_contacts (name, phone, tags, source)
               VALUES (?, ?, ?, ?)`
            ).run(row.name || null, p, row.tags || null, source);
            stats.inserted += 1;
          }
        } catch (err) {
          stats.errors.push(err.message);
          stats.skipped += 1;
        }
      }
    });
    return stats;
  },

  remove(id) {
    return db.prepare('DELETE FROM campaign_contacts WHERE id = ?').run(id);
  },

  removeAll() {
    return db.prepare('DELETE FROM campaign_contacts').run();
  },

  listAllPhones() {
    return db
      .prepare('SELECT id, name, phone FROM campaign_contacts ORDER BY id')
      .all();
  },
};

const Campaigns = {
  list(limit = 50) {
    return db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id) AS total,
           (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'pending') AS pending,
           (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent,
           (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') AS failed
         FROM campaigns c
         ORDER BY c.id DESC
         LIMIT ?`
      )
      .all(limit);
  },

  get(id) {
    return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  },

  create(data) {
    const result = db
      .prepare(
        `INSERT INTO campaigns (
          name, status, content_type, body_text,
          image_path, image_mimetype, image_filename,
          use_quick_replies, delay_min_ms, delay_max_ms,
          batch_size, batch_window_ms, schedule_at,
          msgs_per_minute, hourly_limit, quick_reply_buttons
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.name,
        data.status || 'draft',
        data.content_type || 'text',
        data.body_text || '',
        data.image_path || null,
        data.image_mimetype || null,
        data.image_filename || null,
        data.use_quick_replies != null ? (data.use_quick_replies ? 1 : 0) : 1,
        data.delay_min_ms != null ? data.delay_min_ms : 60000,
        data.delay_max_ms != null ? data.delay_max_ms : 300000,
        data.batch_size != null ? data.batch_size : 10,
        data.batch_window_ms != null ? data.batch_window_ms : 300000,
        data.schedule_at || null,
        data.msgs_per_minute != null ? data.msgs_per_minute : 5,
        data.hourly_limit != null ? data.hourly_limit : 40,
        data.quick_reply_buttons != null
          ? typeof data.quick_reply_buttons === 'string'
            ? data.quick_reply_buttons
            : JSON.stringify(data.quick_reply_buttons)
          : null
      );
    return this.get(result.lastInsertRowid);
  },

  update(id, data) {
    const cur = this.get(id);
    if (!cur) return null;
    const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
    db.prepare(
      `UPDATE campaigns SET
        name = COALESCE(?, name),
        status = COALESCE(?, status),
        content_type = COALESCE(?, content_type),
        body_text = COALESCE(?, body_text),
        image_path = COALESCE(?, image_path),
        image_mimetype = COALESCE(?, image_mimetype),
        image_filename = COALESCE(?, image_filename),
        use_quick_replies = COALESCE(?, use_quick_replies),
        delay_min_ms = COALESCE(?, delay_min_ms),
        delay_max_ms = COALESCE(?, delay_max_ms),
        batch_size = COALESCE(?, batch_size),
        batch_window_ms = COALESCE(?, batch_window_ms),
        msgs_per_minute = COALESCE(?, msgs_per_minute),
        hourly_limit = COALESCE(?, hourly_limit),
        quick_reply_buttons = COALESCE(?, quick_reply_buttons),
        next_send_at = CASE WHEN ? THEN ? ELSE next_send_at END,
        schedule_at = CASE WHEN ? THEN ? ELSE schedule_at END,
        started_at = COALESCE(?, started_at),
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
        updated_at = datetime('now')
      WHERE id = ?`
    ).run(
      data.name ?? null,
      data.status ?? null,
      data.content_type ?? null,
      data.body_text ?? null,
      data.image_path ?? null,
      data.image_mimetype ?? null,
      data.image_filename ?? null,
      data.use_quick_replies != null ? (data.use_quick_replies ? 1 : 0) : null,
      data.delay_min_ms ?? null,
      data.delay_max_ms ?? null,
      data.batch_size ?? null,
      data.batch_window_ms ?? null,
      data.msgs_per_minute ?? null,
      data.hourly_limit ?? null,
      data.quick_reply_buttons != null
        ? typeof data.quick_reply_buttons === 'string'
          ? data.quick_reply_buttons
          : JSON.stringify(data.quick_reply_buttons)
        : null,
      has('next_send_at') ? 1 : 0,
      has('next_send_at') ? data.next_send_at : null,
      has('schedule_at') ? 1 : 0,
      has('schedule_at') ? data.schedule_at : null,
      data.started_at ?? null,
      has('completed_at') ? 1 : 0,
      has('completed_at') ? data.completed_at : null,
      id
    );
    return this.get(id);
  },

  setStatus(id, status, extra = {}) {
    return this.update(id, { status, ...extra });
  },

  remove(id) {
    const camp = this.get(id);
    if (camp?.image_path) {
      try {
        if (fs.existsSync(camp.image_path)) fs.unlinkSync(camp.image_path);
      } catch (_) {}
    }
    try {
      const steps = CampaignSteps.listByCampaign(id);
      for (const s of steps) {
        if (s.image_path && fs.existsSync(s.image_path)) {
          try {
            fs.unlinkSync(s.image_path);
          } catch (_) {}
        }
      }
    } catch (_) {}
    return db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  },

  /** Promote due scheduled campaigns, then return runnable ones. */
  activateDueScheduled() {
    const due = db
      .prepare(
        `SELECT id FROM campaigns
         WHERE status = 'scheduled'
           AND schedule_at IS NOT NULL
           AND schedule_at <= datetime('now')`
      )
      .all();
    for (const row of due) {
      this.setStatus(row.id, 'running', {
        started_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        next_send_at: null,
      });
      console.log(`[Campaigns] Scheduled #${row.id} is due — now running`);
    }
  },

  listRunnable() {
    this.activateDueScheduled();
    return db
      .prepare(
        `SELECT * FROM campaigns
         WHERE status = 'running'
         ORDER BY id ASC`
      )
      .all();
  },

  stats(id) {
    const row = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN status LIKE 'replied%' THEN 1 ELSE 0 END) AS replied
         FROM campaign_recipients WHERE campaign_id = ?`
      )
      .get(id);
    return {
      total: row?.total || 0,
      pending: row?.pending || 0,
      sent: row?.sent || 0,
      failed: row?.failed || 0,
      skipped: row?.skipped || 0,
      replied: row?.replied || 0,
    };
  },
};

const CampaignSteps = {
  listByCampaign(campaignId) {
    return db
      .prepare(
        `SELECT * FROM campaign_steps
         WHERE campaign_id = ?
         ORDER BY step_order ASC, id ASC`
      )
      .all(campaignId);
  },

  replaceAll(campaignId, steps) {
    db.prepare('DELETE FROM campaign_steps WHERE campaign_id = ?').run(
      campaignId
    );
    const insert = db.prepare(
      `INSERT INTO campaign_steps (
        campaign_id, step_order, body_text, content_type, image_path,
        delay_min_ms, delay_max_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    runInTransaction(() => {
      (steps || []).forEach((s, i) => {
        insert.run(
          campaignId,
          s.step_order != null ? s.step_order : i,
          s.body_text || '',
          s.content_type || 'text',
          s.image_path || null,
          s.delay_min_ms != null ? s.delay_min_ms : 60000,
          s.delay_max_ms != null ? s.delay_max_ms : 300000
        );
      });
    });
    return this.listByCampaign(campaignId);
  },

  getStep(campaignId, stepOrder) {
    return db
      .prepare(
        `SELECT * FROM campaign_steps
         WHERE campaign_id = ? AND step_order = ?
         LIMIT 1`
      )
      .get(campaignId, stepOrder);
  },
};

const CampaignRecipients = {
  listByCampaign(campaignId, { status = null, limit = 500 } = {}) {
    if (status) {
      return db
        .prepare(
          `SELECT * FROM campaign_recipients
           WHERE campaign_id = ? AND status = ?
           ORDER BY id ASC LIMIT ?`
        )
        .all(campaignId, status, limit);
    }
    return db
      .prepare(
        `SELECT * FROM campaign_recipients
         WHERE campaign_id = ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(campaignId, limit);
  },

  addMany(campaignId, contacts) {
    const insert = db.prepare(
      `INSERT INTO campaign_recipients (campaign_id, contact_id, phone, name, status)
       VALUES (?, ?, ?, ?, 'pending')`
    );
    return runInTransaction(() => {
      let n = 0;
      for (const c of contacts || []) {
        const phone = normalizePhone(c.phone);
        if (!phone) continue;
        insert.run(campaignId, c.id || null, phone, c.name || null);
        n += 1;
      }
      return n;
    });
  },

  claimNextPending(campaignId) {
    const row = db
      .prepare(
        `SELECT * FROM campaign_recipients
         WHERE campaign_id = ? AND status = 'pending'
         ORDER BY id ASC LIMIT 1`
      )
      .get(campaignId);
    return row || null;
  },

  markSent(id) {
    db.prepare(
      `UPDATE campaign_recipients
       SET status = 'sent', sent_at = datetime('now'), error = NULL
       WHERE id = ?`
    ).run(id);
  },

  advanceStep(id, nextStep) {
    db.prepare(
      `UPDATE campaign_recipients
       SET current_step = ?, status = 'pending', error = NULL
       WHERE id = ?`
    ).run(nextStep, id);
  },

  markFailed(id, error) {
    db.prepare(
      `UPDATE campaign_recipients
       SET status = 'failed', error = ?, sent_at = datetime('now')
       WHERE id = ?`
    ).run(String(error || 'failed').slice(0, 500), id);
  },

  markSkipped(id, reason) {
    db.prepare(
      `UPDATE campaign_recipients
       SET status = 'skipped', error = ?
       WHERE id = ?`
    ).run(String(reason || 'skipped').slice(0, 500), id);
  },

  countSentInWindow(campaignId, windowMs) {
    const seconds = Math.max(1, Math.floor(Number(windowMs) / 1000));
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM campaign_recipients
         WHERE campaign_id = ?
           AND status IN ('sent','failed')
           AND sent_at IS NOT NULL
           AND sent_at >= datetime('now', ?)`
      )
      .get(campaignId, `-${seconds} seconds`).c;
  },

  /**
   * Match an inbound reply to the latest sent campaign recipient for this phone.
   */
  findLatestSentByPhone(phone) {
    const p = normalizePhone(phone);
    if (!p) return null;
    return db
      .prepare(
        `SELECT r.*, c.name AS campaign_name, c.use_quick_replies,
                c.quick_reply_buttons
         FROM campaign_recipients r
         JOIN campaigns c ON c.id = r.campaign_id
         WHERE r.phone = ?
           AND r.status = 'sent'
           AND c.use_quick_replies = 1
         ORDER BY r.sent_at DESC
         LIMIT 1`
      )
      .get(p);
  },

  markReply(id, status, replyText) {
    db.prepare(
      `UPDATE campaign_recipients
       SET status = ?, reply_at = datetime('now'), reply_text = ?
       WHERE id = ?`
    ).run(status, String(replyText || '').slice(0, 500), id);
  },

  pendingCount(campaignId) {
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM campaign_recipients
         WHERE campaign_id = ? AND status = 'pending'`
      )
      .get(campaignId).c;
  },

  purgeOldCompleted(days = 30) {
    const d = Math.max(1, Number(days) || 30);
    return db
      .prepare(
        `DELETE FROM campaign_recipients
         WHERE status != 'pending'
           AND IFNULL(sent_at, created_at) < datetime('now', ?)`
      )
      .run(`-${d} days`);
  },
};

module.exports = {
  CampaignContacts,
  Campaigns,
  CampaignRecipients,
  CampaignSteps,
  MEDIA_DIR,
  ensureMediaDir,
  normalizePhone,
};
