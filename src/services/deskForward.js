/**
 * Form → company desk routing (no visual workflow builder).
 * Sends lead summary to the designated desk number and opens a two-way chat session.
 */
const {
  Settings,
  Submissions,
  InternalNumbers,
  ChatSessions,
} = require('../models');
const {
  buildForwardMessage,
  DEFAULT_FORWARD_TEMPLATE,
} = require('../utils/leadSummary');
const antiBan = require('./antiBan');

/**
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
  const insuranceType = submission.insurance_type;
  const company = submission.company;
  const notifyCustomer = ctx.notifyCustomer === true;
  const sendDeskTip = ctx.sendDeskTip === true;

  Submissions.markConfirmed(submission.id);
  if (ctx.chatId) {
    try {
      Submissions.setCustomerChatId(submission.token, ctx.chatId);
    } catch (_) {}
  }

  const target = InternalNumbers.resolveForType(insuranceType, company);
  if (!target || !target.phone) {
    console.error(
      `[DeskForward] No desk number for type="${insuranceType}" company="${company}"`
    );
    return { ok: false, reason: 'no_desk_number' };
  }

  const deskPhone = String(target.phone).replace(/\D/g, '');
  const forwardText = buildForwardMessage(
    submission,
    Settings.get('forward_template') || DEFAULT_FORWARD_TEMPLATE
  );

  console.log(
    `[DeskForward] Lead #${submission.id} → "${target.label}" (${deskPhone}) via ${target.source || 'catalog'}`
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
        company_name: company || target.label,
      });
      console.log(
        `[ChatBridge] Session #${session.id}[${session.session_code}] opened: ${phone} ↔ desk ${deskPhone}`
      );

      const leadId =
        leadMsg?.id?._serialized || leadMsg?.id?.$1 || leadMsg?.id?.id;
      if (leadId) {
        ChatSessions.trackMessage(session.id, 'system_to_desk', leadId, forwardText);
      }

      if (sendDeskTip) {
        try {
          const tip =
            `Live chat opened [#${session.session_code}]\n` +
            `Customer: ${phone} (${submission.customer_name || '—'})\n` +
            `Quote their messages (or include [#${session.session_code}]) to reply.`;
          const tipMsg = await whatsapp.sendMessage(deskPhone, tip, {
            chatId: deskChatId || undefined,
          });
          const tipId =
            tipMsg?.id?._serialized || tipMsg?.id?.$1 || tipMsg?.id?.id;
          if (tipId) {
            ChatSessions.trackMessage(session.id, 'system_to_desk', tipId, tip);
          }
          const tipChat = tipMsg?._outboundChatId || whatsapp._lastOutboundChatId;
          if (tipChat) ChatSessions.bindDeskChatId(session.id, tipChat);
        } catch (tipErr) {
          console.warn('[DeskForward] Desk tip failed:', tipErr.message);
        }
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
      label: target.label,
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

module.exports = { forwardLeadToDesk };
