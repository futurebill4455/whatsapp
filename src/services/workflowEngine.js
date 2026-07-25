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
  ChatSessions,
} = require('../models');
const {
  buildLeadVars,
  renderTemplate,
  sanitizeFormLink,
} = require('../utils/leadSummary');
const { buildFormUrl, getBaseUrl } = require('../config/baseUrl');
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

async function resolveSenderProfileName(replyTo) {
  if (!replyTo) return '';
  const fromData =
    replyTo._data?.notifyName ||
    replyTo._data?.verifiedName ||
    replyTo.notifyName ||
    '';
  try {
    const contact = await replyTo.getContact();
    const name =
      contact?.pushname ||
      contact?.name ||
      contact?.shortName ||
      contact?.verifiedName ||
      fromData ||
      '';
    return String(name || '').trim();
  } catch (_) {
    return String(fromData || '').trim();
  }
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
   * Always ensures the lead is forwarded to the company desk + bridge opens.
   */
  async handleFormSubmit(submission) {
    if (!submission) return { handled: false, reason: 'no_submission' };

    const phone = submission.customer_phone;
    const active = this.getActiveGraph();
    let workflowResult = null;

    // Resume any waiting form_submit run (by phone or submission token)
    if (active) {
      const waiting =
        WorkflowRuns.findWaitingBySubmissionToken?.(submission.token, 'form_submit') ||
        (phone && WorkflowRuns.findWaiting(phone, 'form_submit')) ||
        null;

      if (waiting) {
        const ctx = {
          ...parseRunContext(waiting),
          phone,
          chatId: submission.customer_chat_id || parseRunContext(waiting).chatId,
          submission_token: submission.token,
          submission,
          message: '',
        };
        console.log(
          `[Workflow] Form submit resume run #${waiting.id} for ${phone || submission.token}`
        );
        try {
          workflowResult = await this.continueFrom(
            waiting,
            waiting.current_node_id,
            active.nodes,
            ctx,
            { skipCurrentWait: true }
          );
        } catch (err) {
          console.error('[Workflow] Form submit resume failed:', err.message);
        }
      }
    }

    // Safety net: always forward if lead is not yet at desk
    const fresh = Submissions.get(submission.id) || submission;
    if (fresh.status !== 'forwarded') {
      console.log(
        `[Workflow] Ensuring desk forward for lead #${fresh.id} (status=${fresh.status})`
      );
      const forward = await this.forwardLeadToDesk(fresh, {
        phone,
        chatId: fresh.customer_chat_id || submission.customer_chat_id,
        notifyCustomer: false,
      });
      return {
        handled: true,
        forward,
        workflow: workflowResult || undefined,
      };
    }

    // Already forwarded by workflow — ensure bridge exists
    const existing =
      ChatSessions.findActiveByCustomer(phone) ||
      (fresh.customer_chat_id
        ? ChatSessions.findActiveByCustomerChatId(fresh.customer_chat_id)
        : null);
    if (!existing) {
      console.warn(
        `[Workflow] Lead #${fresh.id} forwarded but no active bridge — re-opening`
      );
      const forward = await this.forwardLeadToDesk(fresh, {
        phone,
        chatId: fresh.customer_chat_id,
        notifyCustomer: false,
        force: true,
        bridgeOnly: true,
      });
      return { handled: true, forward, workflow: workflowResult || undefined };
    }

    return {
      handled: true,
      forward: {
        ok: true,
        reason: 'already_forwarded',
        session_id: existing.id,
        session_code: existing.session_code,
        desk: existing.desk_phone,
      },
      workflow: workflowResult || undefined,
    };
  }

  async notifyFormSubmitted(submission) {
    return this.handleFormSubmit(submission);
  }

  /**
   * Inbound WhatsApp text. Starts when the shared common access code matches
   * (or a yes/no wait is pending for an already-running run).
   * Any phone / @lid chat can unlock — no per-number whitelist.
   */
  async handleIncomingMessage({ phone, body, chatId, replyTo }) {
    const text = String(body || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    // Stable peer id: real MSISDN when known, otherwise chat JID / opaque id
    const peerId =
      String(phone || '').trim() ||
      String(chatId || '')
        .replace(/@.+$/, '')
        .replace(/\D/g, '') ||
      String(chatId || 'unknown');

    const baseCtx = {
      phone: peerId,
      chatId: chatId || undefined,
      replyTo,
      message: text,
      inboundText: text,
    };

    console.log(
      `[Workflow] Inbound peer=${peerId || '?'} chatId=${chatId || '?'} text="${text.slice(0, 60)}"`
    );

    const active = this.getActiveGraph();
    const waitOpts = { chatId: chatId || null };

    // Resume Yes/No waiters first (already unlocked flows) — scoped to this peer/chat
    if (active) {
      const waitingYn = WorkflowRuns.findWaiting(peerId, 'yes_no', waitOpts);
      if (waitingYn) {
        return this.resumeYesNo(waitingYn, text, active.nodes, baseCtx);
      }

      // Waiting for form — stay silent on chatter UNLESS they re-send the access code
      const waitingForm = WorkflowRuns.findWaiting(peerId, 'form_submit', waitOpts);
      if (waitingForm) {
        const reUnlock = AccessGate.tryUnlock(peerId, text);
        if (!reUnlock.ok) {
          console.log(`[Workflow] Awaiting form submit for ${peerId} — silent`);
          return { handled: true, reason: 'awaiting_form_submit', silent: true };
        }
        console.log(`[Workflow] Access code re-sent while awaiting form — resending link`);
        const profileName = await resolveSenderProfileName(replyTo);
        await this.whatsapp.sendFormLinkOnly(peerId, {
          chatId,
          replyTo,
          inboundText: text,
          name: profileName,
        });
        return { handled: true, reason: 'form_link_resent' };
      }
    }

    // Common access code — universal for every sender (phone / LID / new number)
    const unlock = AccessGate.tryUnlock(peerId, text);
    console.log(
      `[Workflow] AccessGate → ok=${unlock.ok} reason=${unlock.reason} matched=${unlock.matchedCode || ''} peer=${peerId}`
    );

    if (!unlock.ok) {
      return { handled: true, reason: 'ignored_silent', silent: true };
    }

    baseCtx.matched_code = unlock.matchedCode;
    baseCtx.access_ok = true;

    const profileName = await resolveSenderProfileName(replyTo);
    if (profileName) {
      baseCtx.name = profileName;
      baseCtx.profile_name = profileName;
    }

    if (!active) {
      console.warn('[Workflow] No active workflow — form-link fallback');
      await this.whatsapp.sendFormLinkOnly(peerId, {
        chatId,
        replyTo,
        inboundText: text,
        name: profileName,
      });
      return { handled: true, reason: 'no_workflow_form_fallback' };
    }

    const triggers = findAccessTriggerNodes(active.nodes);
    if (!triggers.length) {
      console.warn('[Workflow] No access_code trigger node; sending form link directly');
      await this.whatsapp.sendFormLinkOnly(peerId, {
        chatId,
        replyTo,
        inboundText: text,
        name: profileName,
      });
      return { handled: true, reason: 'form_link_fallback' };
    }

    const start = triggers[0];
    const run = WorkflowRuns.create({
      workflow_id: active.workflow.id,
      customer_phone: peerId,
      context: {
        ...baseCtx,
        matched_code: unlock.matchedCode,
        access_ok: true,
        name: profileName || undefined,
        chatId: chatId || undefined,
      },
    });

    console.log(
      `[Workflow] Common access unlock code=${unlock.matchedCode} → run #${run.id} peer=${peerId} chatId=${chatId || '—'} name=${profileName || '—'}`
    );
    console.log(`[Workflow] Form links use base URL: ${getBaseUrl()}`);

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
        const name = ctx.name || ctx.profile_name || '';
        const customTemplate = String(
          node.data?.message || Settings.get('form_link_message') || ''
        ).trim();

        // Split: natural text bubble, then bare URL (with typing + 2–5s gaps)
        await this.whatsapp.sendNaturalFormPair(phone, formLink, {
          ...sendOpts(ctx),
          name,
          customTemplate:
            customTemplate === '{{form_link}}' ? '' : customTemplate,
        });
        console.log(`[Workflow] Form pair → ${phone}: ${formLink} (base=${getBaseUrl()})`);

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
