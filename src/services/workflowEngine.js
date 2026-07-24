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
  buildConfirmationMessage,
  buildFormLinkParts,
  sanitizeFormLink,
} = require('../utils/leadSummary');
const { buildFormUrl } = require('../config/baseUrl');

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
    inboundText: ctx.inboundText || ctx.body || undefined,
  };
}

function isYes(body) {
  return ['yes', 'y', 'confirm', 'ok', 'okay'].includes(String(body || '').trim().toLowerCase());
}

function isNo(body) {
  return ['no', 'n', 'cancel'].includes(String(body || '').trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelayMs() {
  try {
    return require('./antiBan').humanJitterMs();
  } catch (_) {
    return 3000 + Math.floor(Math.random() * 4001);
  }
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

/** True when a ChatFlow row is a greeting → form-link starter (not brochure/address/etc.). */
function isFormLinkChatFlow(flow) {
  if (!flow) return false;
  if (String(flow.response_template || '').includes('{{form_link}}')) return true;
  const keys = String(flow.trigger_keyword || '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const greetings = new Set([
    'hi',
    'hello',
    'hey',
    'start',
    'ഹായ്',
    ...getSettingsTriggerKeywords(),
  ]);
  return keys.some((k) => greetings.has(k));
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
      // Only greeting / form-link ChatFlow + Settings keywords start the form workflow.
      // Custom keywords (brochure, address, …) are handled in whatsapp.js — do not steal them.
      const settingsKeys = getSettingsTriggerKeywords();
      const chatFlow = ChatFlow.findByKeyword(body);
      const isFormFlow =
        matchesTriggerKeywords(body, settingsKeys) || isFormLinkChatFlow(chatFlow);
      if (!isFormFlow) {
        return { handled: false, reason: 'no_matching_trigger' };
      }
      const anyTrigger = Object.values(active.nodes).find((n) => n.type === 'trigger_message');
      if (!anyTrigger) {
        return this.handleLegacyTrigger(phone, body, baseCtx);
      }
      triggers.push(anyTrigger);
    }

    const open = Submissions.findLatestOpen(phone);
    if (open && open.status === 'awaiting_confirmation') {
      await this.forwardLeadToDesk(open, {
        ...baseCtx,
        notifyCustomer: false,
        sendDeskTip: false,
      });
      return { handled: true, reason: 'legacy_pending_forwarded' };
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
    const isFormFlow =
      matchesTriggerKeywords(body, settingsKeys) || isFormLinkChatFlow(flow);
    if (!isFormFlow) {
      return { handled: false, reason: 'no_active_workflow' };
    }

    const open = Submissions.findLatestOpen(phone);
    if (open && open.status === 'awaiting_confirmation') {
      await this.forwardLeadToDesk(open, {
        ...baseCtx,
        notifyCustomer: false,
        sendDeskTip: false,
      });
      return { handled: true, reason: 'legacy_pending_forwarded' };
    }

    await this.sendLegacyFormLink(phone, baseCtx, isFormLinkChatFlow(flow) ? flow : null);
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

    const formLink = sanitizeFormLink(buildFormUrl(submission.token));
    // Bare form URL only — no welcome greeting
    await this.whatsapp.sendMessage(phone, formLink, sendOpts(ctx));
    return submission;
  }

  /**
   * Compile lead summary and send to internal desk ONLY.
   * Opens two-way session immediately. Customer is not notified by default.
   * Delegates to deskForward (no Drawflow / WorkflowRuns).
   */
  async forwardLeadToDesk(submission, ctx = {}) {
    const { forwardLeadToDesk } = require('./deskForward');
    return forwardLeadToDesk(this.whatsapp, submission, ctx);
  }

  /**
   * After web form submit — forward to desk + open two-way (no customer confirmation).
   */
  async notifyFormSubmitted(submission) {
    return this.handleFormSubmit(submission);
  }

  async handleFormSubmit(submission) {
    const result = await this.forwardLeadToDesk(submission, {
      phone: submission.customer_phone,
      chatId: submission.customer_chat_id || undefined,
      notifyCustomer: false,
      sendDeskTip: false,
    });
    return { handled: true, reason: 'desk_forward_instant_bridge', ...result };
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

    const formLink = sanitizeFormLink(buildFormUrl(newSub.token));
    try {
      await this.whatsapp.sendMessage(phone, formLink, sendOpts(ctx));
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

        const formLink = sanitizeFormLink(buildFormUrl(submission.token));
        const vars = {
          ...ctx,
          business_name: Settings.get('business_name', 'SecureLife Insurance'),
          form_link: formLink,
          phone,
        };

        try {
          // Bare URL only — no welcome greeting text
          await this.whatsapp.sendMessage(phone, formLink, sendOpts(ctx));
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
  const whatsapp = require('./whatsapp');
  const desk = require('./deskForward');
  return desk.forwardLeadToDesk(whatsapp, submission, ctx);
}

async function notifyFormSubmitted(submission) {
  const whatsapp = require('./whatsapp');
  return whatsapp.notifyFormSubmitted(submission);
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
