/**
 * Visual workflow engine for insurance lead intake (Drawflow graphs).
 * Inbound starts when AccessGate matches Settings.common_access_code.
 * No per-user phone whitelist.
 */
const crypto = require('crypto');
const {
  Settings,
  Workflows,
  WorkflowRuns,
  Submissions,
  AccessGate,
} = require('../models');
const {
  buildLeadVars,
  renderTemplate,
  sanitizeFormLink,
} = require('../utils/leadSummary');
const { buildFormUrl } = require('../config/baseUrl');
const { forwardLeadToDesk: deskForwardLead } = require('./deskForward');
const antiBan = require('./antiBan');

let _engine = null;

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getEngine() {
  return _engine;
}

function parseDrawflowGraph(graph) {
  const data = graph?.drawflow?.Home?.data || {};
  const nodes = {};

  for (const [id, node] of Object.entries(data)) {
    const outputs = {};
    const outKeys = Object.keys(node.outputs || {});
    outKeys.forEach((key, index) => {
      const connections = (node.outputs[key]?.connections || []).map((c) =>
        String(c.node)
      );
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

/** Access-code triggers only — never keyword greetings. */
function findAccessTriggerNodes(nodes) {
  return Object.values(nodes).filter((n) => {
    if (n.type !== 'trigger_message') return false;
    const mode = String(n.data.trigger_mode || n.data.mode || 'access_code')
      .trim()
      .toLowerCase();
    // Default / missing mode = access_code (strict)
    return mode === 'access_code' || mode === '' || mode === 'code';
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
    inboundText: ctx.inboundText || ctx.message || undefined,
  };
}

function isYes(body) {
  return ['yes', 'y', 'ok', 'okay', 'confirm', 'അതെ'].includes(
    String(body || '')
      .trim()
      .toLowerCase()
  );
}

function isNo(body) {
  return ['no', 'n', 'cancel', 'ഇല്ല'].includes(
    String(body || '')
      .trim()
      .toLowerCase()
  );
}

function parseRunContext(run) {
  if (!run) return {};
  if (run.context && typeof run.context === 'object') return run.context;
  if (run.context_json) {
    try {
      return JSON.parse(run.context_json);
    } catch (_) {
      return {};
    }
  }
  return {};
}

/**
 * Stub AI assist — personalizes Settings.ai_assist_prompt / node prompt.
 * No external API.
 */
function buildAiAssistReply(promptTemplate, ctx = {}) {
  const name = ctx.name || ctx.customer_name || 'there';
  const phone = ctx.phone || '';
  const message = ctx.message || ctx.body || '';
  const business = Settings.get('business_name') || 'our team';

  const template =
    promptTemplate ||
    Settings.get('ai_assist_prompt') ||
    'Hi {{name}}, thanks for your message. {{business_name}} received: "{{message}}". We will assist you shortly. ({{phone}})';

  return renderTemplate(template, {
    name,
    phone,
    message,
    body: message,
    business_name: business,
    ...ctx,
  });
}

class WorkflowEngine {
  constructor(whatsapp) {
    this.whatsapp = whatsapp;
  }

  getActiveGraph() {
    const wf = Workflows.getActive();
    if (!wf || !wf.graph) return null;
    const nodes = parseDrawflowGraph(wf.graph);
    return { workflow: wf, nodes };
  }

  async forwardLeadToDesk(submission, ctx = {}) {
    return deskForwardLead(this.whatsapp, submission, ctx);
  }

  /**
   * Form POST → resume form_submit waiters or forward immediately.
   */
  async handleFormSubmit(submission) {
    if (!submission) return { handled: false, reason: 'no_submission' };

    const phone = submission.customer_phone;
    const active = this.getActiveGraph();

    // Resume any waiting form_submit run
    if (active && phone) {
      const waiting = WorkflowRuns.findWaiting(phone, 'form_submit');
      if (waiting) {
        const ctx = {
          ...parseRunContext(waiting),
          phone,
          chatId: submission.customer_chat_id || parseRunContext(waiting).chatId,
          submission_token: submission.token,
          submission,
          message: '',
        };
        const result = await this.continueFrom(
          waiting,
          waiting.current_node_id,
          active.nodes,
          ctx,
          { skipCurrentWait: true }
        );
        return { handled: true, ...result };
      }
    }

    // No waiter — forward lead + open bridge
    const result = await this.forwardLeadToDesk(submission, {
      phone,
      chatId: submission.customer_chat_id,
      notifyCustomer: false,
    });
    return { handled: true, forward: result };
  }

  async notifyFormSubmitted(submission) {
    return this.handleFormSubmit(submission);
  }

  /**
   * Inbound WhatsApp text. Starts when the shared common access code matches
   * (or a yes/no wait is pending for an already-running run).
   */
  async handleIncomingMessage({ phone, body, chatId, replyTo }) {
    const text = String(body || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const baseCtx = {
      phone,
      chatId,
      replyTo,
      message: text,
      inboundText: text,
    };

    const active = this.getActiveGraph();
    if (!active) {
      return { handled: false, reason: 'no_active_workflow' };
    }

    // Resume Yes/No waiters first (already authorized flows)
    const waitingYn = WorkflowRuns.findWaiting(phone, 'yes_no');
    if (waitingYn) {
      return this.resumeYesNo(waitingYn, text, active.nodes, baseCtx);
    }

    // Waiting for form — stay silent on chatter
    const waitingForm = WorkflowRuns.findWaiting(phone, 'form_submit');
    if (waitingForm) {
      return { handled: true, reason: 'awaiting_form_submit', silent: true };
    }

    // Common access code (Settings.common_access_code) — no user/phone whitelist
    const unlock = AccessGate.tryUnlock(phone, text);
    if (!unlock.ok) {
      if (unlock.reason === 'wrong_code') {
        console.warn(`[Workflow] Wrong access code from ${phone}`);
        const wrongMsg = String(Settings.get('access_wrong_code_message') || '').trim();
        if (wrongMsg) {
          try {
            await this.whatsapp.sendMessage(phone, wrongMsg, sendOpts(baseCtx));
          } catch (err) {
            console.error('[Workflow] wrong-code reply failed:', err.message);
          }
          return { handled: true, reason: 'wrong_code_replied' };
        }
      } else if (unlock.reason === 'not_configured') {
        console.warn('[Workflow] common_access_code is not configured');
      }
      // Noise / unrelated text — silent
      return { handled: true, reason: unlock.reason || 'unauthorized', silent: true };
    }

    baseCtx.matched_code = unlock.matchedCode;
    baseCtx.access_ok = true;

    const granted = String(Settings.get('access_granted_message') || '').trim();
    if (granted) {
      try {
        await this.whatsapp.sendMessage(phone, granted, sendOpts(baseCtx));
      } catch (err) {
        console.error('[Workflow] access-granted reply failed:', err.message);
      }
    }

    const welcome = String(Settings.get('flow_welcome_message') || '').trim();
    if (welcome) {
      try {
        await this.whatsapp.sendMessage(phone, welcome, sendOpts(baseCtx));
      } catch (err) {
        console.error('[Workflow] flow-welcome reply failed:', err.message);
      }
    }

    const triggers = findAccessTriggerNodes(active.nodes);
    if (!triggers.length) {
      console.warn('[Workflow] No access_code trigger node; sending form link directly');
      await this.whatsapp.sendFormLinkOnly(phone, {
        chatId,
        replyTo,
        inboundText: text,
      });
      return { handled: true, reason: 'form_link_fallback' };
    }

    const start = triggers[0];
    const run = WorkflowRuns.create({
      workflow_id: active.workflow.id,
      customer_phone: phone,
      context: {
        ...baseCtx,
        matched_code: unlock.matchedCode,
        access_ok: true,
      },
    });

    console.log(
      `[Workflow] Common access unlock code=${unlock.matchedCode} → run #${run.id} (${phone})`
    );

    return this.continueFrom(run, start.id, active.nodes, baseCtx);
  }

  async resumeYesNo(run, body, nodes, baseCtx) {
    const ctx = { ...parseRunContext(run), ...baseCtx };
    let output = null;
    if (isYes(body)) output = 'output_1';
    else if (isNo(body)) output = 'output_2';
    else {
      return { handled: true, reason: 'awaiting_yes_no', silent: true };
    }

    const node = nodes[String(run.current_node_id)];
    const targets = nextNodes(node, output);
    if (!targets.length) {
      WorkflowRuns.update(run.id, {
        status: 'completed',
        waiting_for: null,
        context: ctx,
      });
      return { handled: true, status: 'completed' };
    }

    WorkflowRuns.update(run.id, {
      status: 'running',
      waiting_for: null,
      context: ctx,
      current_node_id: targets[0],
    });

    return this.continueFrom(
      WorkflowRuns.get(run.id),
      targets[0],
      nodes,
      ctx
    );
  }

  /**
   * Walk the graph from nodeId, executing until wait / stop / end.
   */
  async continueFrom(run, nodeId, nodes, ctx, opts = {}) {
    let currentId = String(nodeId);
    let localCtx = { ...ctx };
    const visited = new Set();

    while (currentId) {
      if (visited.has(currentId)) {
        console.error('[Workflow] Cycle detected at node', currentId);
        WorkflowRuns.update(run.id, {
          status: 'failed',
          last_error: 'cycle_detected',
        });
        return { handled: true, status: 'failed', reason: 'cycle' };
      }
      visited.add(currentId);

      const node = nodes[currentId];
      if (!node) {
        WorkflowRuns.update(run.id, {
          status: 'completed',
          waiting_for: null,
          current_node_id: null,
          context: localCtx,
        });
        return { handled: true, status: 'completed' };
      }

      WorkflowRuns.update(run.id, {
        current_node_id: currentId,
        context: localCtx,
        status: 'running',
        waiting_for: null,
      });

      // form_submit wait: park until handleFormSubmit
      if (node.type === 'form_submit' && !opts.skipCurrentWait) {
        WorkflowRuns.update(run.id, {
          status: 'waiting',
          waiting_for: 'form_submit',
          submission_token: localCtx.submission_token || null,
          context: localCtx,
        });
        return { handled: true, wait: 'form_submit', run_id: run.id };
      }

      let result;
      try {
        result = await this.executeNode(node, localCtx, run);
      } catch (err) {
        console.error(`[Workflow] Node ${node.type} failed:`, err.message);
        WorkflowRuns.update(run.id, {
          status: 'failed',
          last_error: err.message,
          context: localCtx,
        });
        return { handled: true, status: 'failed', error: err.message };
      }

      if (result?.context) localCtx = { ...localCtx, ...result.context };
      if (result?.submission_token) {
        localCtx.submission_token = result.submission_token;
        WorkflowRuns.update(run.id, {
          submission_token: result.submission_token,
          context: localCtx,
        });
      }

      if (result?.wait) {
        WorkflowRuns.update(run.id, {
          status: 'waiting',
          waiting_for: result.wait,
          context: localCtx,
        });
        return { handled: true, wait: result.wait, run_id: run.id };
      }

      if (result?.stop) {
        WorkflowRuns.update(run.id, {
          status: result.status || 'completed',
          waiting_for: null,
          context: localCtx,
        });
        return { handled: true, status: result.status || 'completed' };
      }

      const outKey = result?.output || 'output_1';
      const targets = nextNodes(node, outKey);
      opts = {}; // only skip wait once
      if (!targets.length) {
        WorkflowRuns.update(run.id, {
          status: 'completed',
          waiting_for: null,
          current_node_id: null,
          context: localCtx,
        });
        return { handled: true, status: 'completed', context: localCtx };
      }
      currentId = targets[0];
    }

    return { handled: true, status: 'completed', context: localCtx };
  }

  async executeNode(node, ctx, run) {
    const phone = ctx.phone;
    const type = node.type;

    switch (type) {
      case 'trigger_message':
        return { output: 'output_1', context: ctx };

      case 'send_form_link': {
        let submission = null;
        if (ctx.submission_token) {
          submission = Submissions.getByToken(ctx.submission_token);
        }
        if (!submission || !['awaiting_form', 'awaiting_confirmation'].includes(submission.status)) {
          const existing = Submissions.findLatestOpen(phone);
          if (existing && existing.status === 'awaiting_form') {
            submission = existing;
          } else {
            submission = Submissions.create({
              token: newToken(),
              customer_phone: phone,
              customer_chat_id: ctx.chatId || null,
              workflow_run_id: run?.id || null,
            });
          }
        }
        if (ctx.chatId) {
          try {
            Submissions.setCustomerChatId(submission.token, ctx.chatId);
          } catch (_) {}
        }

        const formLink = sanitizeFormLink(buildFormUrl(submission.token));
        const vars = {
          ...ctx,
          form_link: formLink,
          business_name: Settings.get('business_name') || '',
          phone,
        };
        // Prefer node message, then Settings.form_link_message, then bare URL
        const template =
          String(node.data?.message || '').trim() ||
          String(Settings.get('form_link_message') || '').trim() ||
          '{{form_link}}';
        const outbound = renderTemplate(template, vars).trim() || formLink;
        await this.whatsapp.sendMessage(phone, outbound, sendOpts(ctx));
        console.log(`[Workflow] Form link → ${phone}: ${formLink}`);

        return {
          output: 'output_1',
          context: {
            ...ctx,
            submission_token: submission.token,
            form_link: formLink,
          },
          submission_token: submission.token,
        };
      }

      case 'form_submit':
        // Handled as wait in continueFrom; when resumed, pass through
        return { output: 'output_1', context: ctx };

      case 'forward_desk': {
        const submission = ctx.submission_token
          ? Submissions.getByToken(ctx.submission_token)
          : Submissions.findLatestOpen(phone);

        if (!submission) {
          console.error('[Workflow] forward_desk: no submission');
          return { stop: true, status: 'failed', context: ctx };
        }

        const result = await this.forwardLeadToDesk(submission, {
          ...ctx,
          notifyCustomer: false,
        });
        return {
          output: 'output_1',
          context: { ...ctx, forward_result: result },
          stop: !result.ok,
          status: result.ok ? undefined : 'failed',
        };
      }

      case 'send_text': {
        const vars = {
          ...ctx,
          ...buildLeadVars(
            ctx.submission_token
              ? Submissions.getByToken(ctx.submission_token)
              : { customer_phone: phone },
            ctx
          ),
          business_name: Settings.get('business_name') || '',
        };
        const text = renderTemplate(node.data.message || '', vars);
        if (text) {
          await this.whatsapp.sendMessage(phone, text, sendOpts(ctx));
        }
        return { output: 'output_1', context: ctx };
      }

      case 'condition_access': {
        // Authorized if this turn matched the common code, or an open form/session exists
        const unlocked =
          !!ctx.access_ok ||
          !!ctx.matched_code ||
          !!WorkflowRuns.findWaiting(phone, 'form_submit') ||
          !!Submissions.findLatestOpen(phone);
        return {
          output: unlocked ? 'output_1' : 'output_2',
          context: ctx,
        };
      }

      case 'condition_yes_no':
        return { wait: 'yes_no', context: ctx };

      case 'ai_assist': {
        const reply = buildAiAssistReply(node.data.prompt || node.data.message, {
          ...ctx,
          name: ctx.name || ctx.access_name,
          phone,
          message: ctx.message,
        });
        if (reply) {
          await this.whatsapp.sendMessage(phone, reply, sendOpts(ctx));
        }
        return { output: 'output_1', context: { ...ctx, ai_reply: reply } };
      }

      default:
        console.warn(`[Workflow] Unknown node type: ${type}`);
        return { output: 'output_1', context: ctx };
    }
  }
}

function bindEngine(whatsapp) {
  _engine = new WorkflowEngine(whatsapp);
  return _engine;
}

async function forwardLeadToDesk(submission, ctx = {}) {
  if (!_engine) throw new Error('WorkflowEngine not bound');
  return _engine.forwardLeadToDesk(submission, ctx);
}

async function notifyFormSubmitted(submission) {
  if (!_engine) throw new Error('WorkflowEngine not bound');
  return _engine.notifyFormSubmitted(submission);
}

module.exports = {
  WorkflowEngine,
  bindEngine,
  newToken,
  getEngine,
  forwardLeadToDesk,
  notifyFormSubmitted,
  parseDrawflowGraph,
  buildAiAssistReply,
};
