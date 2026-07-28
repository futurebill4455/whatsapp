/**
 * Routine cleanup of old logs / campaign debris to keep memory & disk light.
 */
const fs = require('fs');
const path = require('path');
const {
  MessageLog,
  Settings,
  CampaignRecipients,
  Campaigns,
} = require('../models');
const { MEDIA_DIR } = require('../models/campaigns');

class HistoryCleanup {
  constructor() {
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    const hours = Number(Settings.get('cleanup_interval_hours')) || 6;
    const ms = Math.max(1, hours) * 60 * 60 * 1000;
    console.log(`[Cleanup] scheduled every ${hours}h`);
    this._timer = setInterval(() => {
      this.run().catch((err) =>
        console.error('[Cleanup] error:', err.message)
      );
    }, ms);
    // First pass shortly after boot
    setTimeout(() => {
      this.run().catch(() => {});
    }, 45_000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async run() {
    const logDays = Number(Settings.get('cleanup_message_log_days')) || 14;
    const recipDays =
      Number(Settings.get('cleanup_campaign_recipient_days')) || 30;

    const beforeLogs = MessageLog.countAll();
    const logResult = MessageLog.purgeOlderThanDays(logDays);
    const recipResult = CampaignRecipients.purgeOldCompleted(recipDays);
    const mediaRemoved = this.purgeOrphanMedia();

    // Prune in-memory WhatsApp maps/sets (session state leaks)
    try {
      const wa = require('./whatsapp');
      if (typeof wa.pruneMemoryMaps === 'function') wa.pruneMemoryMaps();
    } catch (_) {}

    try {
      if (global.gc) global.gc();
    } catch (_) {}

    console.log(
      `[Cleanup] message_log deleted=${logResult.changes || 0} (kept ~${logDays}d, was ${beforeLogs})` +
        ` | recipients deleted=${recipResult.changes || 0}` +
        ` | orphan media=${mediaRemoved}`
    );
  }

  purgeOrphanMedia() {
    if (!fs.existsSync(MEDIA_DIR)) return 0;
    let removed = 0;
    const used = new Set(
      Campaigns.list(500)
        .map((c) => c.image_path)
        .filter(Boolean)
        .map((p) => path.resolve(p))
    );
    let files = [];
    try {
      files = fs.readdirSync(MEDIA_DIR);
    } catch (_) {
      return 0;
    }
    for (const name of files) {
      const full = path.resolve(MEDIA_DIR, name);
      if (used.has(full)) continue;
      try {
        const st = fs.statSync(full);
        // Only delete files older than 7 days and unused
        if (Date.now() - st.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch (_) {}
    }
    return removed;
  }
}

let singleton = null;

function getHistoryCleanup() {
  if (!singleton) singleton = new HistoryCleanup();
  return singleton;
}

module.exports = { HistoryCleanup, getHistoryCleanup };
