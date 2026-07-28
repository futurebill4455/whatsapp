/**
 * Background campaign queue runner — PM2-persistent, DB-backed.
 * Randomized delays + batch caps mimic human pacing.
 */
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const {
  Campaigns,
  CampaignRecipients,
  Settings,
} = require('../models');

const QUICK_REPLY_FOOTER = `

———
Reply with:
*Interested* or *Not Interested*`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(a, Number(max) || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function buildCampaignBody(campaign) {
  let text = String(campaign.body_text || '').trim();
  if (campaign.use_quick_replies) {
    text = `${text}${QUICK_REPLY_FOOTER}`;
  }
  return text;
}

class CampaignRunner {
  constructor(whatsapp) {
    this.wa = whatsapp;
    this._timer = null;
    this._tickBusy = false;
    this._runningSend = false;
  }

  start() {
    if (this._timer) return;
    const intervalMs = Number(Settings.get('campaign_tick_ms')) || 5000;
    console.log(
      `[CampaignRunner] started (tick=${intervalMs}ms) — survives client disconnect`
    );
    this._timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[CampaignRunner] tick error:', err.message);
      });
    }, intervalMs);
    // Kick once on boot
    setTimeout(() => {
      this.tick().catch(() => {});
    }, 2500);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async tick() {
    if (this._tickBusy || this._runningSend) return;
    this._tickBusy = true;
    try {
      if (!this.wa?.ready || !this.wa?.client) return;

      const campaigns = Campaigns.listRunnable();
      for (const camp of campaigns) {
        await this.processCampaign(camp);
      }
    } finally {
      this._tickBusy = false;
    }
  }

  async processCampaign(camp) {
    const pending = CampaignRecipients.pendingCount(camp.id);
    if (pending === 0) {
      Campaigns.setStatus(camp.id, 'completed', {
        completed_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        next_send_at: null,
      });
      console.log(`[CampaignRunner] #${camp.id} completed`);
      this.emitStatus(camp.id);
      return;
    }

    // Honor scheduled next_send_at
    if (camp.next_send_at) {
      const next = Date.parse(String(camp.next_send_at).replace(' ', 'T') + 'Z');
      // SQLite datetime is UTC-ish; also accept local
      const nextLocal = Date.parse(camp.next_send_at);
      const dueAt = Number.isFinite(nextLocal) ? nextLocal : next;
      if (Number.isFinite(dueAt) && Date.now() < dueAt) {
        return;
      }
    }

    // Batch cap: e.g. 10 messages per 5 minutes
    const batchSize = Math.max(1, Number(camp.batch_size) || 10);
    const batchWindow = Math.max(60_000, Number(camp.batch_window_ms) || 300_000);
    const sentInWindow = CampaignRecipients.countSentInWindow(
      camp.id,
      batchWindow
    );
    if (sentInWindow >= batchSize) {
      const waitMs = randomBetween(15_000, 60_000);
      const nextAt = new Date(Date.now() + waitMs)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
      Campaigns.update(camp.id, { next_send_at: nextAt });
      console.log(
        `[CampaignRunner] #${camp.id} batch cap ${sentInWindow}/${batchSize} — next ${nextAt}`
      );
      return;
    }

    const recipient = CampaignRecipients.claimNextPending(camp.id);
    if (!recipient) return;

    this._runningSend = true;
    try {
      await this.sendOne(camp, recipient);
    } finally {
      this._runningSend = false;
    }

    // Schedule randomized human delay before next message
    const delayMs = randomBetween(
      camp.delay_min_ms || 60_000,
      camp.delay_max_ms || 300_000
    );
    const nextAt = new Date(Date.now() + delayMs)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    Campaigns.update(camp.id, { next_send_at: nextAt });
    if (process.env.LOG_LEVEL === 'debug' || process.env.WA_DEBUG === '1') {
      console.log(
        `[CampaignRunner] #${camp.id} → ${recipient.phone}; next in ${Math.round(delayMs / 1000)}s`
      );
    }
    this.emitStatus(camp.id);
  }

  async sendOne(camp, recipient) {
    const body = buildCampaignBody(camp);
    const phone = recipient.phone;
    try {
      if (camp.content_type === 'image_text' && camp.image_path) {
        if (!fs.existsSync(camp.image_path)) {
          throw new Error('Campaign image missing on disk');
        }
        const media = MessageMedia.fromFilePath(camp.image_path);
        await this.wa.sendMedia(phone, media, {
          caption: body,
          skipPacing: true,
          skipLimiter: false,
          once: true,
        });
      } else {
        await this.wa.sendMessage(phone, body, {
          skipPacing: true,
          skipLimiter: false,
        });
      }
      CampaignRecipients.markSent(recipient.id);
      console.log(`[CampaignRunner] SENT #${camp.id} → ${phone}`);
    } catch (err) {
      CampaignRecipients.markFailed(recipient.id, err.message);
      console.error(
        `[CampaignRunner] FAIL #${camp.id} → ${phone}:`,
        err.message
      );
    }
  }

  emitStatus(campaignId) {
    try {
      const camp = Campaigns.get(campaignId);
      const stats = Campaigns.stats(campaignId);
      this.wa?.emit?.('campaign:update', { campaign: camp, stats });
    } catch (_) {}
  }

  /**
   * Detect Interested / Not Interested replies from customers.
   * @returns {boolean} true if handled as campaign reply
   */
  handleInboundReply(phone, body) {
    const text = String(body || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
    if (!text) return false;

    let status = null;
    if (
      /^(interested|yes|1|i am interested|i'm interested)\b/.test(text) ||
      text === 'interested'
    ) {
      status = 'replied_interested';
    } else if (
      /^(not interested|no|2|not_interested)\b/.test(text) ||
      text === 'not interested'
    ) {
      status = 'replied_not_interested';
    }
    if (!status) return false;

    const row = CampaignRecipients.findLatestSentByPhone(phone);
    if (!row) return false;

    CampaignRecipients.markReply(row.id, status, body);
    console.log(
      `[CampaignRunner] Reply ${status} from ${phone} campaign=#${row.campaign_id}`
    );
    this.emitStatus(row.campaign_id);
    try {
      this.wa?.emit?.('webchat:message', {
        phone: String(phone).replace(/\D/g, ''),
        direction: 'in',
        body: String(body || ''),
        meta: { campaign_reply: status, campaign_id: row.campaign_id },
      });
    } catch (_) {}
    return true;
  }
}

let singleton = null;

function getCampaignRunner(whatsapp) {
  if (!singleton) singleton = new CampaignRunner(whatsapp);
  return singleton;
}

module.exports = {
  CampaignRunner,
  getCampaignRunner,
  buildCampaignBody,
  QUICK_REPLY_FOOTER,
};
