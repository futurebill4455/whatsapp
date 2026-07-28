/**
 * Background campaign queue runner — PM2-persistent, DB-backed.
 * Supports schedule_at, multi-step sequences, random delays + batch caps.
 */
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const {
  Campaigns,
  CampaignRecipients,
  CampaignSteps,
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

function buildBody(text, useQuickReplies, isLastStep) {
  let out = String(text || '').trim();
  if (useQuickReplies && isLastStep) {
    out = `${out}${QUICK_REPLY_FOOTER}`;
  }
  return out;
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
    console.log(`[CampaignRunner] started (tick=${intervalMs}ms)`);
    this._timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[CampaignRunner] tick error:', err.message);
      });
    }, intervalMs);
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
    // Never compete with auto-chat / media forwarding
    if (this.wa?.coreBusy) return;
    this._tickBusy = true;
    try {
      if (!this.wa?.ready || !this.wa?.client) return;
      const campaigns = Campaigns.listRunnable();
      for (const camp of campaigns) {
        if (this.wa?.coreBusy) break;
        await this.processCampaign(camp);
      }
    } finally {
      this._tickBusy = false;
    }
  }

  resolveSteps(camp) {
    const extra = CampaignSteps.listByCampaign(camp.id);
    // Step 0 = campaign primary message; extras are follow-ups
    const steps = [
      {
        step_order: 0,
        body_text: camp.body_text,
        content_type: camp.content_type || 'text',
        image_path: camp.image_path,
        delay_min_ms: camp.delay_min_ms,
        delay_max_ms: camp.delay_max_ms,
      },
      ...extra.map((s, i) => ({
        ...s,
        step_order: s.step_order != null ? s.step_order : i + 1,
      })),
    ];
    return steps.sort((a, b) => a.step_order - b.step_order);
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

    if (camp.next_send_at) {
      const nextLocal = Date.parse(String(camp.next_send_at).replace(' ', 'T'));
      if (Number.isFinite(nextLocal) && Date.now() < nextLocal) return;
    }

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

    const steps = this.resolveSteps(camp);
    const stepIdx = Math.max(0, Number(recipient.current_step) || 0);
    const step = steps[stepIdx] || steps[0];
    const delayMs = randomBetween(
      step?.delay_min_ms || camp.delay_min_ms || 60_000,
      step?.delay_max_ms || camp.delay_max_ms || 300_000
    );
    const nextAt = new Date(Date.now() + delayMs)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    Campaigns.update(camp.id, { next_send_at: nextAt });
    this.emitStatus(camp.id);
  }

  async sendOne(camp, recipient) {
    const steps = this.resolveSteps(camp);
    const stepIdx = Math.max(0, Number(recipient.current_step) || 0);
    const step = steps[stepIdx] || steps[0];
    const isLast = stepIdx >= steps.length - 1;
    const body = buildBody(step.body_text, camp.use_quick_replies, isLast);
    const phone = recipient.phone;
    const contentType = step.content_type || 'text';
    const imagePath = step.image_path || null;

    try {
      if (contentType === 'image_text' && imagePath && fs.existsSync(imagePath)) {
        const media = MessageMedia.fromFilePath(imagePath);
        await this.wa.sendMedia(phone, media, {
          caption: body,
          skipPacing: true,
          lane: 'bulk',
          priority: 'low',
          once: true,
        });
      } else {
        await this.wa.sendMessage(phone, body, {
          skipPacing: true,
          lane: 'bulk',
          priority: 'low',
        });
      }

      if (!isLast) {
        CampaignRecipients.advanceStep(recipient.id, stepIdx + 1);
        console.log(
          `[CampaignRunner] #${camp.id} → ${phone} step ${stepIdx + 1}/${steps.length}`
        );
      } else {
        CampaignRecipients.markSent(recipient.id);
        console.log(`[CampaignRunner] SENT #${camp.id} → ${phone}`);
      }
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
  QUICK_REPLY_FOOTER,
};
