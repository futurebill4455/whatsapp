/**
 * Background campaign queue runner — PM2-persistent, DB-backed.
 * Smart randomized delays + interactive Buttons/List (text fallback).
 */
const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const {
  Campaigns,
  CampaignRecipients,
  CampaignSteps,
  Settings,
} = require('../models');
const {
  buildQuickReplyFooter,
  parseButtonLabels,
  classifyButtonReply,
} = require('./waInteractive');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  const a = Math.max(0, Number(min) || 0);
  const b = Math.max(a, Number(max) || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function pacingFromMsgsPerMinute(msgsPerWindow, windowMinutes = 1) {
  const count = Math.max(1, Math.min(60, Number(msgsPerWindow) || 5));
  const mins = Math.max(0.25, Math.min(60, Number(windowMinutes) || 1));
  const rate = count / mins;
  const clamped = Math.max(0.1, Math.min(30, rate));
  const avgMs = Math.round(60_000 / clamped);
  const delay_min_ms = Math.max(2_000, Math.floor(avgMs * 0.4));
  const delay_max_ms = Math.max(delay_min_ms + 500, Math.ceil(avgMs * 1.65));
  return {
    msgs_per_minute: Math.round(clamped * 100) / 100,
    msgs_per_window: count,
    window_minutes: mins,
    delay_min_ms,
    delay_max_ms,
    avgMs,
  };
}

function hourlyCapFromLimit(hourlyLimit) {
  const hourly = Math.max(1, Math.min(500, Number(hourlyLimit) || 40));
  return {
    hourly_limit: hourly,
    batch_size: hourly,
    batch_window_ms: 60 * 60 * 1000,
  };
}

function nextRandomDelayMs(camp) {
  const mpm = Number(camp.msgs_per_minute);
  if (Number.isFinite(mpm) && mpm > 0) {
    const { delay_min_ms, delay_max_ms, avgMs } = pacingFromMsgsPerMinute(
      mpm,
      1
    );
    const roll = Math.random();
    let delay;
    if (roll < 0.2) {
      delay = randomBetween(delay_min_ms, Math.floor(avgMs * 0.75));
    } else if (roll < 0.4) {
      delay = randomBetween(Math.ceil(avgMs * 1.15), delay_max_ms);
    } else {
      delay = randomBetween(
        Math.floor(avgMs * 0.7),
        Math.ceil(avgMs * 1.3)
      );
    }
    delay += randomBetween(0, 900);
    return Math.max(delay_min_ms, Math.min(delay_max_ms + 900, delay));
  }
  return randomBetween(
    camp.delay_min_ms || 60_000,
    camp.delay_max_ms || 300_000
  );
}

function buildBody(
  text,
  useQuickReplies,
  isLastStep,
  quickReplyButtons,
  { forInteractive = false } = {}
) {
  let out = String(text || '').trim();
  if (useQuickReplies && isLastStep && !forInteractive) {
    out = `${out}${buildQuickReplyFooter(quickReplyButtons)}`;
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
    const intervalMs = Number(Settings.get('campaign_tick_ms')) || 3000;
    console.log(
      `[CampaignRunner] started (tick=${intervalMs}ms, PM2-persistent)`
    );
    this._timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[CampaignRunner] tick error:', err.message);
      });
    }, intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    setTimeout(() => {
      this.tick().catch(() => {});
    }, 1500);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async tick() {
    if (this._tickBusy || this._runningSend) return;
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
    const pacing = pacingFromMsgsPerMinute(camp.msgs_per_minute);
    const steps = [
      {
        step_order: 0,
        body_text: camp.body_text,
        content_type: camp.content_type || 'text',
        image_path: camp.image_path,
        delay_min_ms: camp.delay_min_ms || pacing.delay_min_ms,
        delay_max_ms: camp.delay_max_ms || pacing.delay_max_ms,
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

    const hourly =
      Number(camp.hourly_limit) > 0
        ? Number(camp.hourly_limit)
        : Math.max(1, Number(camp.batch_size) || 40);
    const windowMs =
      Number(camp.hourly_limit) > 0
        ? 60 * 60 * 1000
        : Math.max(60_000, Number(camp.batch_window_ms) || 3_600_000);

    const sentInWindow = CampaignRecipients.countSentInWindow(
      camp.id,
      windowMs
    );
    if (sentInWindow >= hourly) {
      const waitMs = randomBetween(90_000, 280_000);
      const nextAt = new Date(Date.now() + waitMs)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
      Campaigns.update(camp.id, { next_send_at: nextAt });
      console.log(
        `[CampaignRunner] #${camp.id} hourly cap ${sentInWindow}/${hourly} — cool-down ${Math.round(waitMs / 1000)}s`
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

    const delayMs = nextRandomDelayMs(camp);
    const nextAt = new Date(Date.now() + delayMs)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    Campaigns.update(camp.id, { next_send_at: nextAt });
    console.log(
      `[CampaignRunner] #${camp.id} next delay ${Math.round(delayMs / 1000)}s (random, ~${camp.msgs_per_minute || '?'} msg/min)`
    );
    this.emitStatus(camp.id);
  }

  async sendOne(camp, recipient) {
    const steps = this.resolveSteps(camp);
    const stepIdx = Math.max(0, Number(recipient.current_step) || 0);
    const step = steps[stepIdx] || steps[0];
    const isLast = stepIdx >= steps.length - 1;
    const phone = recipient.phone;
    const contentType = step.content_type || 'text';
    const imagePath = step.image_path || null;
    const wantInteractive =
      !!camp.use_quick_replies &&
      isLast &&
      parseButtonLabels(camp.quick_reply_buttons).length > 0;

    const plainBody = buildBody(
      step.body_text,
      camp.use_quick_replies,
      isLast,
      camp.quick_reply_buttons,
      { forInteractive: wantInteractive }
    );

    try {
      if (wantInteractive) {
        let media = null;
        if (
          contentType === 'image_text' &&
          imagePath &&
          fs.existsSync(imagePath)
        ) {
          media = MessageMedia.fromFilePath(imagePath);
        }
        await this.wa.sendInteractive(phone, {
          body: plainBody || step.body_text || ' ',
          buttons: camp.quick_reply_buttons,
          media,
          skipPacing: true,
          skipLimiter: false,
          lane: 'bulk',
          priority: 'low',
          footer: 'Tap a button to reply',
        });
      } else if (
        contentType === 'image_text' &&
        imagePath &&
        fs.existsSync(imagePath)
      ) {
        const media = MessageMedia.fromFilePath(imagePath);
        await this.wa.sendMedia(phone, media, {
          caption: plainBody,
          skipPacing: true,
          lane: 'bulk',
          priority: 'low',
          once: true,
        });
      } else {
        await this.wa.sendMessage(phone, plainBody, {
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
      .trim();
    if (!text) return false;

    const row = CampaignRecipients.findLatestSentByPhone(phone);
    if (!row) return false;

    let status = classifyButtonReply(text, row.quick_reply_buttons);
    if (!status) {
      const norm = text.toLowerCase();
      if (
        /^(interested|yes|1|i am interested|i'm interested)\b/.test(norm) ||
        norm === 'interested'
      ) {
        status = 'replied_interested';
      } else if (
        /^(not interested|no|2|not_interested)\b/.test(norm) ||
        norm === 'not interested'
      ) {
        status = 'replied_not_interested';
      }
    }
    if (!status) return false;

    CampaignRecipients.markReply(row.id, status, body);
    this.emitStatus(row.campaign_id);
    try {
      this.wa?.emit?.('webchat:message', {
        phone: String(phone).replace(/\D/g, ''),
        direction: 'in',
        body: String(body || ''),
        meta: {
          campaign_reply: status,
          campaign_id: row.campaign_id,
          interactive: true,
        },
      });
      this.wa?.emit?.('campaign:button', {
        phone: String(phone).replace(/\D/g, ''),
        label: text,
        status,
        campaign_id: row.campaign_id,
      });
    } catch (_) {}
    console.log(
      `[CampaignRunner] Button/reply from ${phone}: "${text}" → ${status}`
    );
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
  QUICK_REPLY_FOOTER: buildQuickReplyFooter(['Interested', 'Not Interested']),
  pacingFromMsgsPerMinute,
  hourlyCapFromLimit,
  nextRandomDelayMs,
  buildQuickReplyFooter,
  buildBody,
};
