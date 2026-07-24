/**
 * Form → catalog company desk routing + open two-way middleman session.
 * Desk phone comes only from Companies.findByName(submission.company).desk_phone.
 */
const { Settings, Submissions, Companies, ChatSessions } = require('../models');
const {
  buildForwardMessage,
  DEFAULT_FORWARD_TEMPLATE,
} = require('../utils/leadSummary');
const antiBan = require('./antiBan');

/**
 * Resolve catalog desk for a submission. No env / fallback numbers.
 * @returns {{ ok: true, phone: string, label: string } | { ok: false, reason: string }}
 */
function resolveCatalogDesk(submission) {
  const companyName = String(submission?.company || '').trim();
  if (!companyName) {
    return { ok: false, reason: 'missing_company' };
  }

  const company = Companies.findByName(companyName);
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
    label: company.name || companyName,
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

  const phone = ctx.phone || submission.customer_phone;
  const notifyCustomer = ctx.notifyCustomer === true;

  try {
    Submissions.markConfirmed?.(submission.id);
  } catch (_) {}

  if (ctx.chatId) {
    try {
      Submissions.setCustomerChatId(submission.token, ctx.chatId);
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
    `[DeskForward] Lead #${submission.id} → catalog "${companyLabel}" (${deskPhone})`
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

    // antiBan pacing happens inside whatsapp.sendMessage
    const leadMsg = await whatsapp.sendMessage(deskPhone, forwardText, {
      chatId: deskChatId || undefined,
    });
    deskChatId =
      leadMsg?._outboundChatId || whatsapp._lastOutboundChatId || deskChatId;

    Submissions.markForwarded(submission.id, deskPhone);

    let session = null;
    try {
      await antiBan.sleep(antiBan.sessionSpacingMs());
      session = ChatSessions.open({
        submission_id: submission.id,
        customer_phone: phone,
        customer_chat_id: ctx.chatId || submission.customer_chat_id || null,
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
    } catch (sessErr) {
      console.error('[DeskForward] Session open failed:', sessErr.message);
    }

    if (notifyCustomer) {
      try {
        await whatsapp.sendMessage(
          phone,
          Settings.get('success_message') ||
            'Thank you! Your details have been sent to our team.',
          {
            chatId: ctx.chatId || submission.customer_chat_id || undefined,
            replyTo: ctx.replyTo,
            inboundText: ctx.inboundText,
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
