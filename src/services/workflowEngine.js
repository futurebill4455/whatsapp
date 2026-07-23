/**
 * Visual workflow engine for insurance lead intake (Drawflow graphs).
 * Falls back to ChatFlow / Settings when no active workflow graph exists.
 */
const crypto = require('crypto');
const {
  Settings,
  Workflows,
  WorkflowRuns,
  Submissions,
  InternalNumbers,
  ChatSessions,
  ChatFlow,
} = require('../models');
const {
  buildLeadVars,
  renderTemplate,
  buildForwardMessage,
  buildConfirmationMessage,
  buildFormLinkParts,
  sanitizeFormLink,
  DEFAULT_FORWARD_TEMPLATE,
} = require('../utils/leadSummary');

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parseDrawflowGraph(graph) {
  const data = graph?.drawflow?.Home?.data || {};
  const nodes = {};

  for (const [id, node] of Object.entries(data)) {
    const outputs = {};
    const outKeys = Object.keys(node.outputs || {});
    outKeys.forEach((key, index) => {
      const connections = (node.outputs[key]?.connections || []).map((c) => String(c.node));
      outputs[key] = connections;
      outputs[`_${index}`] = connections;
    });

    nodes[String(id)] = {
      id: String(id),
      type: node.name,
      data: node.data || {},
      outputs,
      pos: { x: node.pos_x, y: node.pos_y },
    };
  }

  return nodes;
}

function findTriggerNodes(nodes, messageBody) {
  const normalized = String(messageBody || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
  return Object.values(nodes).filter((n) => {
    if (n.type !== 'trigger_message') return false;
    const keywords = String(n.data.keywords || 'hi,hello,hey,start,ഹായ്')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    return keywords.some(
      (k) => normalized === k || normalized.startsWith(`${k} `) || normalized.startsWith(`${k},`)
    );
  });
}

function nextNodes(node, outputKey = 'output_1') {
  if (!node) return [];
  return node.outputs[outputKey] || node.outputs._0 || [];
}

function sendOpts(ctx) {
  return {
    chatId: ctx.chatId || undefined,
    replyTo: ctx.replyTo || undefined,
  };
}

function isYes(body) {
  return ['yes', 'y', 'confirm', 'ok', 'okay'].includes(String(body || '').trim().toLowerCase());
}

function isNo(body) {
  return ['no', 'n', 'cancel'].includes(String(body || '').trim().toLowerCase());
}

function getBaseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs() {
  return 3000 + Math.floor(Math.random() * 2001);
}

function getSettingsTriggerKeywords() {
  return String(Settings.get('trigger_keywords') || 'hi,hello,hey,start,ഹായ്')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function matchesTriggerKeywords(body, keywords) {
  const normalized = String(body || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
  return keywords.some(
    (k) => normalized === k || normalized.startsWith(`${k} `) || normalized.startsWith(`${k},`)
  );
}

class WorkflowEngine {
  constructor(whatsapp) {
    this.whatsapp = whatsapp;
  }

  getActiveGraph() {
    const workflow = Workflows.getActive();
    if (!workflow) return null;
    const nodes = parseDrawflowGraph(workflow.graph);
    if (!Object.keys(nodes).length) return null;
    return { workflow, nodes };
  }

  /**
   * @param {object} whatsappOrPayload — either whatsapp service, or {phone,body,chatId,replyTo}
   * @param {object} [message]
   * @param {object} [peer] — {phone, chatId, body}
   */
  async handleIncomingMessage(whatsappOrPayload, message, peer) {
    // Support both signatures:
    //   handleIncomingMessage({ phone, body, chatId, replyTo })
    //   handleIncomingMessage(whatsapp, message, { phone, chatId, body })
    let phone;
    let body;
    let chatId;
    let replyTo;

    if (peer && typeof peer === 'object') {
      if (whatsappOrPayload && whatsappOrPayload !== this.whatsapp) {
        this.whatsapp = whatsappOrPayload;
      }
      phone = peer.phone;
      chatId = peer.chatId;
      body = peer.body != null ? peer.body : String(message?.body || '');
      replyTo = message;
    } else {
      const payload = whatsappOrPayload || {};
      phone = payload.phone;
      body = payload.body;
      chatId = payload.chatId;
      replyTo = payload.replyTo;
    }

    const started = Date.now();
    const baseCtx = { phone, chatId, replyTo, message: body };
    const active = this.getActiveGraph();

    // Resume Yes/No waiters first when a graph exists
    if (active) {
      const waiting = WorkflowRuns.findWaiting(phone, 'yes_no');
      if (waiting) {
        const result = await this.resumeYesNo(waiting, body, active.nodes, baseCtx);
        console.log(`[Workflow] yes/no resume in ${Date.now() - started}ms`);
        if (result.handled) return result;
        const greetings = getSettingsTriggerKeywords();
        if (!matchesTriggerKeywords(body, greetings)) return result;
        console.log('[Workflow] Greeting during Yes/No wait — starting fresh trigger');
      }
    }

    // Recovery: confirmation pending but waiter was lost
    if (isYes(body) || isNo(body)) {
      const pending = Submissions.findPendingConfirmation(phone);
      if (pending) {
        console.log(`[Workflow] Recovering Yes/No for pending submission #${pending.id}`);
        if (isNo(body)) {
          if (active) {
            await this.resendFormAfterDecline(pending, active.nodes, baseCtx);
          } else {
            Submissions.markCancelled(pending.id);
            await this.whatsapp.sendMessage(
              phone,
              Settings.get('cancel_message') || 'Cancelled. Send *Hi* to start again.',
              sendOpts(baseCtx)
            );
            // Optional resend without graph
            await this.sendLegacyFormLink(phone, baseCtx);
          }
          return { handled: true, reason: 'resent_form_recovery' };
        }
        await this.forwardLeadToDesk(pending, baseCtx);
        return { handled: true, reason: 'forwarded_recovery' };
      }
    }

    if (!active) {
      return this.handleLegacyTrigger(phone, body, baseCtx);
    }

    const triggers = findTriggerNodes(active.nodes, body);
    if (!triggers.length) {
      // Also accept Settings / ChatFlow keywords even if workflow node keywords differ
      const settingsKeys = getSettingsTriggerKeywords();
      const chatFlow = ChatFlow.findByKeyword(body);
      if (!matchesTriggerKeywords(body, settingsKeys) && !chatFlow) {
        return { handled: false, reason: 'no_matching_trigger' };
      }
      // Fall through using first trigger node in graph (or legacy if none)
      const anyTrigger = Object.values(active.nodes).find((n) => n.type === 'trigger_message');
      if (!anyTrigger) {
        return this.handleLegacyTrigger(phone, body, baseCtx);
      }
      triggers.push(anyTrigger);
    }

    const open = Submissions.findLatestOpen(phone);
    if (open && open.status === 'awaiting_confirmation') {
      await this.whatsapp.sendMessage(
        phone,
        Settings.get('already_pending_message') ||
          'You already have a pending request. Reply Yes / No to confirm.',
        sendOpts(baseCtx)
      );
      return { handled: true, reason: 'already_pending' };
    }

    const run = WorkflowRuns.create({
      workflow_id: active.workflow.id,
      customer_phone: phone,
      context: { phone, chatId, message: body },
    });

    try {
      const result = await this.executeFrom(run.id, triggers[0].id, active.nodes, baseCtx);
      console.log(`[Workflow] trigger→form executed in ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      console.error(`[Workflow] Trigger flow failed (${err.message}) — allowing legacy fallback`);
      return { handled: false, reason: 'workflow_send_failed', error: err.message };
    }
  }

  /**
   * ChatFlow / Settings fallback when no active Drawflow graph.
   */
  async handleLegacyTrigger(phone, body, baseCtx) {
    const settingsKeys = getSettingsTriggerKeywords();
    const flow = ChatFlow.findByKeyword(body);
    if (!flow && !matchesTriggerKeywords(body, settingsKeys)) {
      return { handled: false, reason: 'no_active_workflow' };
    }

    const open = Submissions.findLatestOpen(phone);
    if (open && open.status === 'awaiting_confirmation') {
      await this.whatsapp.sendMessage(
        phone,
        Settings.get('already_pending_message') ||
          'You already have a pending request. Reply Yes / No to confirm.',
        sendOpts(baseCtx)
      );
      return { handled: true, reason: 'already_pending' };
    }

    await this.sendLegacyFormLink(phone, baseCtx, flow);
    return { handled: true, reason: 'legacy_form_link' };
  }

  async sendLegacyFormLink(phone, ctx = {}, flow = null) {
    let submission = Submissions.findLatestOpen(phone);
    if (!submission || submission.status !== 'awaiting_form') {
      submission = Submissions.create({
        token: newToken(),
        customer_phone: phone,
      });
    }
    if (ctx.chatId) {
      try {
        Submissions.setCustomerChatId(submission.token, ctx.chatId);
      } catch (_) {}
    }

    const formLink = sanitizeFormLink(`${getBaseUrl()}/form/${submission.token}`);
    const vars = {
      business_name: Settings.get('business_name', 'SecureLife Insurance'),
      form_link: formLink,
      phone,
    };
    const template =
      flow?.response_template ||
      'Welcome to *{{business_name}}*! 👋\n\nPlease fill your insurance details here:\n\n{{form_link}}';
    const { intro, link, footer } = buildFormLinkParts(template, vars);
    await sleep(humanDelayMs());
    await this.whatsapp.sendMessage(phone, intro, sendOpts(ctx));
    if (link) {
      await sleep(250);
      await this.whatsapp.sendMessage(phone, link, sendOpts({ ...ctx, replyTo: undefined }));
    }
    if (footer) {
      await sleep(200);
      await this.whatsapp.sendMessage(phone, footer, sendOpts({ ...ctx, replyTo: undefined }));
    }
    return submission;
  }

  /**
   * Compile lead summary and send to internal desk. Never throws — logs + notifies customer.
   */
  async forwardLeadToDesk(submission, ctx = {}) {
    const phone = ctx.phone || submission.customer_phone;
    const insuranceType = submission.insurance_type;
    const company = submission.company;

    Submissions.markConfirmed(submission.id);
    if (ctx.chatId) {
      try {
        Submissions.setCustomerChatId(submission.token, ctx.chatId);
      } catch (_) {}
    }

    const target = InternalNumbers.resolveForType(insuranceType, company);
    if (!target || !target.phone) {
      console.error(
        `[Forward] No internal desk number configured for type="${insuranceType}" company="${company}"`
      );
      try {
        await this.whatsapp.sendMessage(
          phone,
          'Your details are confirmed, but no internal desk number is configured yet. Our team will follow up shortly.',
          sendOpts(ctx)
        );
      } catch (err) {
        console.error('[Forward] Failed to notify customer (no desk):', err.message);
      }
      return { ok: false, reason: 'no_desk_number' };
    }

    const deskPhone = String(target.phone).replace(/\D/g, '');
    const forwardText = buildForwardMessage(
      submission,
      Settings.get('forward_template') || DEFAULT_FORWARD_TEMPLATE
    );

    console.log(
      `[Forward] Sending lead #${submission.id} → desk "${target.label}" (${deskPhone}) via ${target.source || 'unknown'}`
    );

    try {
      let deskChatId = null;
      try {
        if (typeof this.whatsapp.resolveOutboundChatId === 'function') {
          deskChatId = await this.whatsapp.resolveOutboundChatId(deskPhone);
          console.log(`[Forward] Desk ${deskPhone} resolves to chat ${deskChatId}`);
        }
      } catch (resErr) {
        console.warn('[Forward] Could not resolve desk chat id:', resErr.message);
      }

      const leadMsg = await this.whatsapp.sendMessage(deskPhone, forwardText, {
        chatId: deskChatId || undefined,
      });
      deskChatId =
        leadMsg?._outboundChatId ||
        this.whatsapp._lastOutboundChatId ||
        deskChatId;

      Submissions.markForwarded(submission.id, deskPhone);

      let session = null;
      try {
        session = ChatSessions.open({
          submission_id: submission.id,
          customer_phone: phone,
          customer_chat_id: ctx.chatId || submission.customer_chat_id || null,
          desk_phone: deskPhone,
          desk_chat_id: deskChatId,
          company_name: company || target.label,
        });
        console.log(
          `[ChatBridge] Session #${session.id}[${session.session_code}] opened: customer ${phone} ↔ desk ${deskPhone}`
        );

        const leadId = leadMsg?.id?._serialized || leadMsg?.id?.$1 || leadMsg?.id?.id;
        if (leadId) ChatSessions.trackMessage(session.id, 'system_to_desk', leadId, forwardText);

        try {
          const tip =
            `🔗 *Live chat opened* [#${session.session_code}]\n` +
            `Customer: ${phone} (${submission.customer_name || '—'})\n\n` +
            `Reply by *quoting* their messages (or include [#${session.session_code}]) so replies reach the right person.`;
          const tipMsg = await this.whatsapp.sendMessage(deskPhone, tip, {
            chatId: deskChatId || undefined,
          });
          const tipId = tipMsg?.id?._serialized || tipMsg?.id?.$1 || tipMsg?.id?.id;
          if (tipId) ChatSessions.trackMessage(session.id, 'system_to_desk', tipId, tip);
          const tipChat = tipMsg?._outboundChatId || this.whatsapp._lastOutboundChatId;
          if (tipChat) ChatSessions.bindDeskChatId(session.id, tipChat);
        } catch (tipErr) {
          console.warn('[ChatBridge] Desk tip message failed:', tipErr.message);
        }
      } catch (sessErr) {
        console.error('[ChatBridge] Failed to open session:', sessErr.message);
      }

      const codeHint = session?.session_code ? ` (ref [#${session.session_code}])` : '';
      const success =
        Settings.get('success_message') ||
        'Thank you! Your details have been confirmed and forwarded to our team.\n\n' +
          'You can now chat directly with the insurance desk here. Send *close* (or *ക്ലോസ്*) anytime to end the conversation.';
      try {
        const msg = success.toLowerCase().includes('close')
          ? success
          : `${success}\n\nSend *close* anytime to end the chat${codeHint}.`;
        await this.whatsapp.sendMessage(phone, msg, sendOpts(ctx));
      } catch (err) {
        console.error('[Forward] Desk OK but customer success message failed:', err.message);
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
        `[Forward] FAILED sending lead #${submission.id} to desk "${target.label}" (${deskPhone}):`,
        err.message
      );
      try {
        await this.whatsapp.sendMessage(
          phone,
          'Your details are confirmed. We could not reach the internal desk automatically — our admin has been notified and will follow up shortly.',
          sendOpts(ctx)
        );
      } catch (notifyErr) {
        console.error('[Forward] Also failed to notify customer after desk error:', notifyErr.message);
      }
      return { ok: false, reason: 'send_failed', error: err.message, desk: deskPhone };
    }
  }

  /**
   * After web form submit — send Yes/No confirmation (workflow waiter or Settings template).
   */
  async notifyFormSubmitted(submission) {
    return this.handleFormSubmit(submission);
  }

  async handleFormSubmit(submission) {
    const active = this.getActiveGraph();
    if (!active) {
      const text = buildConfirmationMessage(
        submission,
        Settings.get('confirmation_template')
      );
      try {
        await this.whatsapp.sendMessage(submission.customer_phone, text, {
          chatId: submission.customer_chat_id || undefined,
        });
      } catch (err) {
        console.error('[Workflow] Legacy confirmation failed:', err.message);
      }
      return { handled: true, reason: 'legacy_confirmation' };
    }

    let waiting = null;
    if (submission.workflow_run_id) {
      waiting = WorkflowRuns.get(submission.workflow_run_id);
    }
    if (!waiting || waiting.waiting_for !== 'form_submit') {
      waiting = WorkflowRuns.findWaitingByToken(submission.token, 'form_submit');
    }
    if (!waiting || waiting.waiting_for !== 'form_submit') {
      waiting = WorkflowRuns.findWaiting(submission.customer_phone, 'form_submit');
    }
    if (!waiting) {
      // No waiter — still send confirmation and arm yes_no if possible
      const vars = buildLeadVars(submission);
      const formNode = Object.values(active.nodes).find((n) => n.type === 'form_submit');
      const confirmation = renderTemplate(
        formNode?.data?.confirmation_message ||
          Settings.get('confirmation_template') ||
          'Hi {{name}}, please confirm your details:\n\n• Name: {{name}}\n• Insurance Type: {{insurance_type}}\n• Company: {{company}}\n{{details}}\n\n*Is this correct?* Reply *Yes* or *No*.',
        vars
      );
      try {
        await this.whatsapp.sendMessage(submission.customer_phone, confirmation, {
          chatId: submission.customer_chat_id || undefined,
        });
      } catch (err) {
        console.error('[Workflow] Confirmation (no waiter) failed:', err.message);
      }

      const yesNo = Object.values(active.nodes).find((n) => n.type === 'condition_yes_no');
      if (yesNo) {
        const run = WorkflowRuns.create({
          workflow_id: active.workflow.id,
          customer_phone: submission.customer_phone,
          submission_token: submission.token,
          context: {
            phone: submission.customer_phone,
            chatId: submission.customer_chat_id,
            submission_token: submission.token,
            ...vars,
          },
        });
        Submissions.setWorkflowRun(submission.token, run.id);
        WorkflowRuns.update(run.id, {
          status: 'waiting',
          current_node_id: yesNo.id,
          waiting_for: 'yes_no',
          submission_token: submission.token,
        });
      }
      return { handled: true, reason: 'confirmation_without_waiter' };
    }

    const vars = buildLeadVars(submission, {
      phone: submission.customer_phone,
      chatId: waiting.context?.chatId,
    });
    const ctx = {
      ...waiting.context,
      ...vars,
      submission_token: submission.token,
      replyTo: undefined,
    };

    WorkflowRuns.update(waiting.id, {
      status: 'running',
      waiting_for: null,
      context: ctx,
      submission_token: submission.token,
    });

    const nodeId = waiting.current_node_id;
    const node = active.nodes[nodeId];
    if (!node) return { handled: false };

    const confirmation = renderTemplate(
      node.data.confirmation_message ||
        Settings.get('confirmation_template') ||
        'Hi {{name}}, please confirm your details:\n\n• Name: {{name}}\n• Insurance Type: {{insurance_type}}\n• Company: {{company}}\n{{details}}\n\n*Is this correct?* Reply *Yes* or *No*.',
      ctx
    );

    try {
      if (confirmation) {
        await this.whatsapp.sendMessage(submission.customer_phone, confirmation, {
          chatId: ctx.chatId || submission.customer_chat_id,
        });
      }
    } catch (err) {
      console.error(
        `[Workflow] Confirmation WhatsApp failed for ${submission.customer_phone} (still waiting for Yes/No):`,
        err.message
      );
    }

    const outs = nextNodes(node, 'output_1');
    if (!outs.length) {
      WorkflowRuns.update(waiting.id, { status: 'completed', waiting_for: null });
      return { handled: true };
    }

    return this.executeFrom(waiting.id, outs[0], active.nodes, ctx);
  }

  async resumeYesNo(runRow, body, nodes, baseCtx = {}) {
    const run = WorkflowRuns.get(runRow.id);
    const node = nodes[run.current_node_id];
    if (!node || node.type !== 'condition_yes_no') {
      return { handled: false };
    }

    const lower = String(body || '').trim().toLowerCase();
    const yesKeys = String(node.data.yes_keywords || 'yes,y,confirm,ok,okay')
      .split(',')
      .map((k) => k.trim().toLowerCase());
    const noKeys = String(node.data.no_keywords || 'no,n,cancel')
      .split(',')
      .map((k) => k.trim().toLowerCase());

    let branch = null;
    if (yesKeys.includes(lower)) branch = 'output_1';
    else if (noKeys.includes(lower)) branch = 'output_2';
    else return { handled: false, reason: 'unmatched_reply' };

    const ctx = {
      ...run.context,
      ...baseCtx,
      reply: body,
      branch,
      chatId: baseCtx.chatId || run.context?.chatId,
      replyTo: baseCtx.replyTo,
    };

    WorkflowRuns.update(run.id, {
      status: 'running',
      waiting_for: null,
      context: { ...ctx, replyTo: undefined },
    });

    if (branch === 'output_2') {
      const sub = run.submission_token ? Submissions.getByToken(run.submission_token) : null;
      if (sub) Submissions.markCancelled(sub.id);
      WorkflowRuns.update(run.id, { status: 'completed', waiting_for: null });
      await this.resendFormAfterDecline(sub || { customer_phone: ctx.phone }, nodes, ctx);
      return { handled: true, reason: 'resent_form' };
    }

    if (run.submission_token) {
      const sub = Submissions.getByToken(run.submission_token);
      if (sub) Submissions.markConfirmed(sub.id);
    }

    const outs = nextNodes(node, branch);
    if (!outs.length) {
      WorkflowRuns.update(run.id, { status: 'completed', waiting_for: null });
      return { handled: true };
    }
    return this.executeFrom(run.id, outs[0], nodes, ctx);
  }

  /**
   * After customer replies No: issue a new form link and wait for form_submit again.
   */
  async resendFormAfterDecline(oldSubmission, nodes, ctx) {
    const phone = ctx.phone || oldSubmission.customer_phone;
    const delay = humanDelayMs();
    console.log(`[Workflow] Customer declined — resending form in ${delay}ms`);

    const formNode = Object.values(nodes || {}).find((n) => n.type === 'form_submit');
    const active = this.getActiveGraph();
    if (!active) {
      await this.sendLegacyFormLink(phone, ctx);
      return;
    }

    const newSub = Submissions.create({
      token: newToken(),
      customer_phone: phone,
    });
    if (ctx.chatId) Submissions.setCustomerChatId(newSub.token, ctx.chatId);

    const run = WorkflowRuns.create({
      workflow_id: active.workflow.id,
      customer_phone: phone,
      submission_token: newSub.token,
      context: { phone, chatId: ctx.chatId, message: 'refill' },
    });
    Submissions.setWorkflowRun(newSub.token, run.id);

    if (formNode) {
      WorkflowRuns.update(run.id, {
        status: 'waiting',
        current_node_id: formNode.id,
        waiting_for: 'form_submit',
        submission_token: newSub.token,
        context: { phone, chatId: ctx.chatId },
      });
    }

    const formLink = sanitizeFormLink(`${getBaseUrl()}/form/${newSub.token}`);
    await sleep(delay);
    const template =
      "No problem — let's start again.\n\nPlease refill your insurance details here:\n\n{{form_link}}";
    const { intro, link, footer } = buildFormLinkParts(template, { form_link: formLink });
    try {
      await this.whatsapp.sendMessage(phone, intro, sendOpts(ctx));
      if (link) {
        await sleep(250);
        await this.whatsapp.sendMessage(phone, link, sendOpts({ ...ctx, replyTo: undefined }));
      }
      if (footer) {
        await sleep(200);
        await this.whatsapp.sendMessage(phone, footer, sendOpts({ ...ctx, replyTo: undefined }));
      }
      console.log(`[Workflow] Refill form link sent to ${phone}: ${formLink}`);
    } catch (err) {
      console.error('[Workflow] Failed to resend form link:', err.message);
    }
  }

  async executeFrom(runId, nodeId, nodes, ctx = {}) {
    let currentId = String(nodeId);
    const visited = new Set();
    const maxSteps = 40;

    for (let step = 0; step < maxSteps; step++) {
      if (!currentId || visited.has(currentId)) break;
      visited.add(currentId);

      const node = nodes[currentId];
      if (!node) {
        WorkflowRuns.update(runId, {
          status: 'failed',
          last_error: `Missing node ${currentId}`,
          waiting_for: null,
        });
        return { handled: false, error: 'missing_node' };
      }

      const persistCtx = { ...ctx, replyTo: undefined };
      WorkflowRuns.update(runId, {
        status: 'running',
        current_node_id: currentId,
        waiting_for: null,
        context: persistCtx,
      });

      let result;
      try {
        result = await this.executeNode(runId, node, ctx);
      } catch (err) {
        console.error(`[Workflow] Node ${node.type} failed:`, err.message);
        WorkflowRuns.update(runId, {
          status: 'failed',
          last_error: err.message,
          waiting_for: null,
        });
        throw err;
      }

      if (result.context) ctx = { ...ctx, ...result.context };
      if (result.submission_token) {
        WorkflowRuns.update(runId, {
          submission_token: result.submission_token,
          context: { ...ctx, replyTo: undefined },
        });
      }

      if (result.wait) {
        WorkflowRuns.update(runId, {
          status: 'waiting',
          current_node_id: currentId,
          waiting_for: result.wait,
          context: { ...(result.context || ctx), replyTo: undefined },
          submission_token: result.submission_token || ctx.submission_token || undefined,
        });
        return { handled: true, waiting: result.wait, runId };
      }

      if (result.stop) {
        WorkflowRuns.update(runId, {
          status: result.status || 'completed',
          waiting_for: null,
          context: { ...ctx, replyTo: undefined },
        });
        return { handled: true, runId };
      }

      const outKey = result.output || 'output_1';
      const next = nextNodes(node, outKey);
      if (!next.length) {
        WorkflowRuns.update(runId, {
          status: 'completed',
          waiting_for: null,
          context: { ...ctx, replyTo: undefined },
        });
        return { handled: true, runId };
      }
      currentId = next[0];
    }

    WorkflowRuns.update(runId, {
      status: 'failed',
      last_error: 'Max steps exceeded',
      waiting_for: null,
    });
    return { handled: false, error: 'max_steps' };
  }

  async executeNode(runId, node, ctx) {
    switch (node.type) {
      case 'trigger_message':
        return { output: 'output_1' };

      case 'send_form_link': {
        const phone = ctx.phone;
        let submission = Submissions.findLatestOpen(phone);
        if (!submission || submission.status !== 'awaiting_form') {
          submission = Submissions.create({
            token: newToken(),
            customer_phone: phone,
            workflow_run_id: runId,
          });
        } else {
          Submissions.setWorkflowRun(submission.token, runId);
        }
        if (ctx.chatId) Submissions.setCustomerChatId(submission.token, ctx.chatId);

        const formLink = sanitizeFormLink(`${getBaseUrl()}/form/${submission.token}`);
        const vars = {
          ...ctx,
          business_name: Settings.get('business_name', 'SecureLife Insurance'),
          form_link: formLink,
          phone,
        };
        const { intro, link, footer } = buildFormLinkParts(
          node.data.message ||
            'Welcome to *{{business_name}}*! 👋\n\nPlease fill your insurance details here:\n\n{{form_link}}',
          vars
        );

        const delay = humanDelayMs();
        console.log(`[Workflow] Human delay ${delay}ms before form link → ${phone}`);
        await sleep(delay);

        try {
          await this.whatsapp.sendMessage(phone, intro, sendOpts(ctx));
          if (link) {
            await sleep(250);
            await this.whatsapp.sendMessage(phone, link, sendOpts({ ...ctx, replyTo: undefined }));
          }
          if (footer) {
            await sleep(200);
            await this.whatsapp.sendMessage(phone, footer, sendOpts({ ...ctx, replyTo: undefined }));
          }
          console.log(`[Workflow] Form link sent to ${phone}: ${formLink}`);
        } catch (err) {
          console.error(`[Workflow] Failed to send form link to ${phone}:`, err.message);
          throw err;
        }

        return {
          output: 'output_1',
          context: { ...ctx, ...vars, submission_token: submission.token, replyTo: ctx.replyTo },
          submission_token: submission.token,
        };
      }

      case 'form_submit':
        return {
          wait: 'form_submit',
          submission_token: ctx.submission_token,
          context: ctx,
        };

      case 'condition_yes_no':
        return { wait: 'yes_no', context: ctx };

      case 'forward_desk': {
        const submission = ctx.submission_token
          ? Submissions.getByToken(ctx.submission_token)
          : null;

        if (!submission) {
          console.error('[Workflow] forward_desk: no submission found for token', ctx.submission_token);
          try {
            await this.whatsapp.sendMessage(
              ctx.phone,
              'Your confirmation was received, but we could not locate your form details. Please send *Hi* to start again.',
              sendOpts(ctx)
            );
          } catch (_) {}
          return { stop: true, status: 'failed', context: ctx };
        }

        const result = await this.forwardLeadToDesk(submission, ctx);
        return {
          stop: true,
          status: 'completed',
          context: { ...ctx, forwarded_to: result.desk || null, forward_ok: result.ok },
        };
      }

      case 'send_text': {
        const text = renderTemplate(node.data.message || '', {
          ...ctx,
          business_name: Settings.get('business_name', 'Insurance'),
        });
        if (text) {
          try {
            await this.whatsapp.sendMessage(ctx.phone, text, sendOpts(ctx));
          } catch (err) {
            console.error('[Workflow] send_text failed:', err.message);
          }
        }
        return { output: 'output_1', context: ctx };
      }

      default:
        console.warn('[Workflow] Unknown node type:', node.type);
        return { output: 'output_1' };
    }
  }
}

/** Lazy singleton bound when WhatsApp service constructs the engine */
let _singleton = null;

function bindEngine(whatsapp) {
  _singleton = new WorkflowEngine(whatsapp);
  return _singleton;
}

function getEngine() {
  if (!_singleton) {
    throw new Error('WorkflowEngine not bound — WhatsApp service must call bindEngine first');
  }
  return _singleton;
}

async function handleIncomingMessage(...args) {
  return getEngine().handleIncomingMessage(...args);
}

async function forwardLeadToDesk(submission, ctx) {
  return getEngine().forwardLeadToDesk(submission, ctx);
}

async function notifyFormSubmitted(submission) {
  return getEngine().notifyFormSubmitted(submission);
}

module.exports = {
  WorkflowEngine,
  parseDrawflowGraph,
  bindEngine,
  getEngine,
  handleIncomingMessage,
  forwardLeadToDesk,
  notifyFormSubmitted,
  renderTemplate,
  newToken,
};
