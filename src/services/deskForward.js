/**
 * Form → catalog company desk routing + open two-way middleman session.
 * Desk phone comes from Companies (by id or name) → desk_phone.
 */
const { Settings, Submissions, Companies, ChatSessions } = require('../models');
const {
  buildForwardMessage,
  parseExtra,
  DEFAULT_FORWARD_TEMPLATE,
} = require('../utils/leadSummary');
const antiBan = require('./antiBan');

/**
 * Resolve catalog desk for a submission. No env / fallback numbers.
 * Prefers extra.company_id, then company name.
 * @returns {{ ok: true, phone: string, label: string, company_id?: number } | { ok: false, reason: string }}
 */
function resolveCatalogDesk(submission) {
  const extra = parseExtra(submission?.extra_json || submission?.extra);
  let company = null;

  if (extra?.company_id) {
    company = Companies.get(Number(extra.company_id));
    if (company && !company.is_active) company = null;
  }

  if (!company) {
    const companyName = String(submission?.company || '').trim();
    if (!companyName) {
      return { ok: false, reason: 'missing_company' };
    }
    company = Companies.findByName(companyName);
  }

  if (!company) {
    return { ok: false, reason: 'company_not_in_catalog' };
  }
  if (!company.is_active) {
    return { ok: false, reason: 'company_inactive' };
  }

  const deskPhone = String(company.desk_phone || '').replace(/\D/g, '');
  if (!deskPhone || deskPhone.length < 10) {
    return { ok: false, reason: 'desk_phone_missing' };
  }

  return {
    ok: true,
    phone: deskPhone,
    label: company.name || String(submission?.company || '').trim(),
    company_id: company.id,
  };
}

/**
 * Forward a submitted lead to the company desk WhatsApp and open a ChatSession.
 *
 * @param {object} whatsapp - WhatsAppService singleton
 * @param {object} submission - submissions row
 * @param {object} [ctx]
 * @returns {Promise<{ok:boolean, reason?:string, desk?:string, session_id?:number|null, session_code?:string|null}>}
 */
async function forwardLeadToDesk(whatsapp, submission, ctx = {}) {
  if (!whatsapp || !submission) {
    return { ok: false, reason: 'missing_args' };
  }

  // Already forwarded — still ensure a bridge exists when possible
  if (submission.status === 'forwarded' && !ctx.force) {
    const existing =
      ChatSessions.findActiveByCustomer(submission.customer_phone) ||
      (submission.customer_chat_id
        ? ChatSessions.findActiveByCustomerChatId(submission.customer_chat_id)
        : null);
    if (existing) {
      return {
        ok: true,
        reason: 'already_forwarded',
        desk: existing.desk_phone,
        session_id: existing.id,
        session_code: existing.session_code,
      };
    }
  }

  const phone = ctx.phone || submission.customer_phone;
  const customerChatId =
    ctx.chatId || submission.customer_chat_id || null;
  const notifyCustomer = ctx.notifyCustomer === true;
  const bridgeOnly = ctx.bridgeOnly === true || (submission.status === 'forwarded' && ctx.force);

  try {
    if (!bridgeOnly) Submissions.markConfirmed?.(submission.id);
  } catch (_) {}

  if (customerChatId) {
    try {
      Submissions.setCustomerChatId(submission.token, customerChatId);
    } catch (_) {}
  }

  const target = resolveCatalogDesk(submission);
  if (!target.ok) {
    console.error(
      `[DeskForward] Catalog desk resolve failed for company="${submission.company}": ${target.reason}`
    );
    return { ok: false, reason: target.reason || 'no_desk_number' };
  }

  const deskPhone = target.phone;
  const companyLabel = target.label;
  const forwardText = buildForwardMessage(
    submission,
    Settings.get('forward_template') || DEFAULT_FORWARD_TEMPLATE
  );

  console.log(
    `[DeskForward] Lead #${submission.id} → catalog "${companyLabel}" (${deskPhone})${bridgeOnly ? ' [bridge-only]' : ''}`
  );

  try {
    let deskChatId = null;
    try {
      if (typeof whatsapp.resolveOutboundChatId === 'function') {
        deskChatId = await whatsapp.resolveOutboundChatId(deskPhone);
      }
    } catch (resErr) {
      console.warn('[DeskForward] Desk chat resolve failed:', resErr.message);
    }

    let leadMsg = null;
    if (!bridgeOnly) {
      leadMsg = await whatsapp.sendMessage(deskPhone, forwardText, {
        chatId: deskChatId || undefined,
        skipTyping: true,
        skipPacing: false,
      });
      deskChatId =
        leadMsg?._outboundChatId || whatsapp._lastOutboundChatId || deskChatId;
      Submissions.markForwarded(submission.id, deskPhone);
    } else if (submission.desk_phone) {
      // Prefer previously stored desk chat when re-opening bridge
      try {
        deskChatId =
          deskChatId ||
          (await whatsapp.resolveOutboundChatId(submission.desk_phone));
      } catch (_) {}
    }

    let session = null;
    try {
      // Open bridge immediately so two-way chat works right after the lead lands
      await antiBan.sleep(antiBan.randInt(250, 600));
      session = ChatSessions.open({
        submission_id: submission.id,
        customer_phone: phone,
        customer_chat_id: customerChatId,
        desk_phone: deskPhone,
        desk_chat_id: deskChatId,
        company_name: companyLabel,
      });
      console.log(
        `[ChatBridge] Session #${session.id}[${session.session_code}] opened: ${phone} ↔ ${deskPhone}`
      );

      const leadId =
        leadMsg?.id?._serialized || leadMsg?.id?.id || leadMsg?.id;
      if (leadId) {
        ChatSessions.trackMessage(
          session.id,
          'system_to_desk',
          String(leadId),
          forwardText
        );
      }

      // Tip so multi-lead desks can route with [#CODE] or by quoting the lead
      try {
        const tip =
          `🟢 Live chat opened [#${session.session_code}]\n` +
          `Customer: ${submission.customer_name || phone}\n` +
          `Reply here to chat. Quote this lead or include [#${session.session_code}] if you have multiple chats.\n` +
          `Send Close or CLS to end.`;
        await antiBan.sleep(antiBan.randInt(400, 900));
        const tipMsg = await whatsapp.sendMessage(deskPhone, tip, {
          chatId: deskChatId || undefined,
          skipTyping: true,
          skipPacing: true,
          skipLimiter: true,
        });
        const tipId =
          tipMsg?.id?._serialized || tipMsg?.id?.id || tipMsg?.id;
        if (tipId) {
          ChatSessions.trackMessage(
            session.id,
            'system_to_desk',
            String(tipId),
            tip
          );
        }
      } catch (tipErr) {
        console.warn('[DeskForward] Bridge tip failed:', tipErr.message);
      }
    } catch (sessErr) {
      console.error('[DeskForward] Session open failed:', sessErr.message);
    }

    if (notifyCustomer && !bridgeOnly) {
      try {
        await whatsapp.sendMessage(
          phone,
          Settings.get('success_message') ||
            'Thank you! Your details have been sent to our team. You can reply here anytime.',
          {
            chatId: customerChatId || undefined,
            replyTo: ctx.replyTo,
            inboundText: ctx.inboundText,
            skipTyping: true,
            skipPacing: true,
          }
        );
      } catch (err) {
        console.error('[DeskForward] Customer notify failed:', err.message);
      }
    }

    return {
      ok: true,
      desk: deskPhone,
      label: companyLabel,
      session_id: session?.id || null,
      session_code: session?.session_code || null,
      bridgeOnly,
    };
  } catch (err) {
    console.error(
      `[DeskForward] FAILED lead #${submission.id} → ${deskPhone}:`,
      err.message
    );
    return {
      ok: false,
      reason: 'send_failed',
      error: err.message,
      desk: deskPhone,
    };
  }
}

module.exports = {
  forwardLeadToDesk,
  resolveCatalogDesk,
};
