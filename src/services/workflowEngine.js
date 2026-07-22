const { v4: uuidv4 } = require('uuid');
const {
  Settings,
  Workflows,
  WorkflowRuns,
  Submissions,
  InternalNumbers,
  ChatSessions,
} = require('../models');
const {
  parseExtra,
  formatExtraDetails,
  buildLeadVars,
  renderTemplate,
  buildForwardMessage,
  DEFAULT_FORWARD_TEMPLATE,
} = require('../utils/leadSummary');

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
    const keywords = String(n.data.keywords || 'hi,hello,hey,start')
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

/** Natural human-like delay: 3–5 seconds */
function humanDelayMs() {
  return 3000 + Math.floor(Math.random() * 2001);
}

class WorkflowEngine {
  constructor(whatsapp) {
    this.whatsapp = whatsapp;
  }

  getActiveGraph() {
    const workflow = Workflows.getActive();
    if (!workflow) return null;
    return { workflow, nodes: parseDrawflowGraph(workflow.graph) };
  }

  async handleIncomingMessage({ phone, body, chatId, replyTo }) {
    const started = Date.now();
    const active = this.getActiveGraph();
    if (!active) {
      return { handled: false, reason: 'no_active_workflow' };
    }

    const baseCtx = { phone, chatId, replyTo, message: body };

    // Resume Yes/No waiters first
    const waiting = WorkflowRuns.findWaiting(phone, 'yes_no');
    if (waiting) {
      const result = await this.resumeYesNo(waiting, body, active.nodes, baseCtx);
      console.log(`[Workflow] yes/no resume in ${Date.now() - started}ms`);
      if (result.handled) return result;
      // If user said Hi while waiting for Yes/No, fall through to start a new flow
      const greetings = ['hi', 'hello', 'hey', 'start', 'ഹായ്'];
      const norm = String(body || '').trim().toLowerCase();
      const isGreeting = greetings.some((g) => norm === g || norm.startsWith(`${g} `));
      if (!isGreeting) return result;
      console.log('[Workflow] Greeting received during Yes/No wait — starting fresh trigger');
    }

    // Recovery: confirmation pending but waiter was lost (e.g. confirmation send failed earlier)
    if (isYes(body) || isNo(body)) {
      const pending = Submissions.findPendingConfirmation(phone);
      if (pending) {
        console.log(`[Workflow] Recovering Yes/No for pending submission #${pending.id}`);
        if (isNo(body)) {
          await this.resendFormAfterDecline(pending, active.nodes, baseCtx);
          return { handled: true, reason: 'resent_form_recovery' };
        }
        await this.forwardLeadToDesk(pending, baseCtx);
        return { handled: true, reason: 'forwarded_recovery' };
      }
    }

    const triggers = findTriggerNodes(active.nodes, body);
    if (!triggers.length) {
      return { handled: false, reason: 'no_matching_trigger' };
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
      `[Forward] Sending lead #${submission.id} → desk "${target.label}" (${deskPhone}) via ${target.source || 'unknown'}\n${forwardText}`
    );

    try {
      // Resolve LID/@c.us chat id up front so inbound desk replies can match
      let deskChatId = null;
      try {
        deskChatId = await this.whatsapp.resolveOutboundChatId(deskPhone);
        console.log(`[Forward] Desk ${deskPhone} resolves to chat ${deskChatId}`);
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

      // Open persistent two-way chat bridge (survives server restarts)
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
          `[ChatBridge] Session #${session.id}[${session.session_code}] opened: customer ${phone} ↔ desk ${deskPhone} chat=${deskChatId || 'n/a'} (${company || target.label})`
        );

        const leadId = leadMsg?.id?._serialized || leadMsg?.id?.id;
        if (leadId) ChatSessions.trackMessage(session.id, 'system_to_desk', leadId, forwardText);

        // Tell desk how to reply for multi-customer routing
        try {
          const tip =
            `🔗 *Live chat opened* [#${session.session_code}]\n` +
            `Customer: ${phone} (${submission.customer_name || '—'})\n\n` +
            `Reply by *quoting* their messages (or include [#${session.session_code}]) so replies reach the right person.`;
          const tipMsg = await this.whatsapp.sendMessage(deskPhone, tip, {
            chatId: deskChatId || undefined,
          });
          const tipId = tipMsg?.id?._serialized || tipMsg?.id?.id;
          if (tipId) ChatSessions.trackMessage(session.id, 'system_to_desk', tipId, tip);
          const tipChat = tipMsg?._outboundChatId || this.whatsapp._lastOutboundChatId;
          if (tipChat) ChatSessions.bindDeskChatId(session.id, tipChat);
        } catch (tipErr) {
          console.warn('[ChatBridge] Desk tip message failed:', tipErr.message);
        }
      } catch (sessErr) {
        console.error('[ChatBridge] Failed to open session:', sessErr.message);
      }

      console.log(`[Forward] Lead #${submission.id} delivered to ${deskPhone} (${target.label})`);

      const codeHint = session?.session_code ? ` (ref [#${session.session_code}])` : '';
      const success =
        Settings.get('success_message') ||
        'Thank you! Your details have been confirmed and forwarded to our team.\n\n' +
          'You can now chat directly with the insurance desk here. Send *close* (or *ക്ലോസ്*) anytime to end the conversation.';
      try {
        await this.whatsapp.sendMessage(
          phone,
          success.includes('close') ? success : `${success}\n\nChat ref${codeHint}`,
          sendOpts(ctx)
        );
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

  async handleFormSubmit(submission) {
    const active = this.getActiveGraph();
    if (!active) return { handled: false };

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
      return { handled: false, reason: 'no_waiting_run' };
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

    // Always advance to Yes/No wait even if confirmation WhatsApp fails
    try {
      if (confirmation) {
        await this.whatsapp.sendMessage(submission.customer_phone, confirmation, {
          chatId: ctx.chatId,
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

    // No → cancel old lead and resend a fresh form link
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

    const formNode = Object.values(nodes).find((n) => n.type === 'form_submit');
    const triggerOrLink = Object.values(nodes).find((n) => n.type === 'send_form_link');
    const active = this.getActiveGraph();
    if (!active) {
      await this.whatsapp.sendGreetingFormLink?.(phone, sendOpts(ctx));
      return;
    }

    const newSub = Submissions.create({
      token: uuidv4(),
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

    const waitNodeId = formNode?.id || triggerOrLink?.id;
    if (waitNodeId && formNode) {
      WorkflowRuns.update(run.id, {
        status: 'waiting',
        current_node_id: formNode.id,
        waiting_for: 'form_submit',
        submission_token: newSub.token,
        context: { phone, chatId: ctx.chatId },
      });
    }

    const formLink = `${getBaseUrl()}/form/${newSub.token}`;
    await sleep(delay);
    const text =
      'No problem — let\'s start again.\n\n' +
      `Please refill your insurance details here:\n${formLink}`;
    try {
      await this.whatsapp.sendMessage(phone, text, sendOpts(ctx));
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

      // Persist context without non-serializable replyTo
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
            token: uuidv4(),
            customer_phone: phone,
            workflow_run_id: runId,
          });
        } else {
          Submissions.setWorkflowRun(submission.token, runId);
        }
        if (ctx.chatId) Submissions.setCustomerChatId(submission.token, ctx.chatId);

        const formLink = `${getBaseUrl()}/form/${submission.token}`;
        const vars = {
          ...ctx,
          business_name: Settings.get('business_name', 'SecureLife Insurance'),
          form_link: formLink,
          phone,
        };
        const text = renderTemplate(
          node.data.message ||
            'Welcome to *{{business_name}}*! 👋\n\nPlease fill your insurance details here:\n{{form_link}}',
          vars
        );

        const delay = humanDelayMs();
        console.log(`[Workflow] Human delay ${delay}ms before form link → ${phone}`);
        await sleep(delay);

        try {
          await this.whatsapp.sendMessage(phone, text, sendOpts(ctx));
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

        // forwardLeadToDesk never throws — handles logging + customer notify
        const result = await this.forwardLeadToDesk(submission, ctx);
        return {
          stop: true,
          status: result.ok ? 'completed' : 'completed',
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

module.exports = { WorkflowEngine, parseDrawflowGraph, renderTemplate, formatExtraDetails };
