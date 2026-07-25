/**
 * Default Drawflow export for the insurance lead workflow.
 * Node `name` values are the executable types used by the engine.
 */

const NODE_META = {
  trigger_message: {
    title: 'When common access code received',
    category: 'trigger',
    inputs: 0,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#f59e0b',
    fields: [
      { key: 'trigger_mode', label: 'Mode', type: 'select', options: ['access_code'] },
      { key: 'keywords', label: 'Keywords (unused — code comes from Settings)', type: 'text' },
    ],
  },
  send_form_link: {
    title: 'Send Web Form Link',
    category: 'action',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#0d7377',
    fields: [{ key: 'message', label: 'Message', type: 'textarea' }],
  },
  form_submit: {
    title: 'Receive Form Submit',
    category: 'event',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#6366f1',
  },
  forward_desk: {
    title: 'Forward to Internal Desk',
    category: 'action',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#0d7377',
  },
  send_text: {
    title: 'Send Text Message',
    category: 'action',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#334155',
    fields: [{ key: 'message', label: 'Message', type: 'textarea' }],
  },
  condition_access: {
    title: 'Check Access Code / Session',
    category: 'condition',
    inputs: 1,
    outputs: 2,
    outputLabels: ['Authorized', 'Denied'],
    color: '#7c3aed',
  },
  condition_yes_no: {
    title: 'Condition / If-Else',
    category: 'condition',
    inputs: 1,
    outputs: 2,
    outputLabels: ['Yes', 'No'],
    color: '#c45c26',
  },
  ai_assist: {
    title: 'AI Assist Reply',
    category: 'action',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#0891b2',
    fields: [{ key: 'prompt', label: 'Assist prompt', type: 'textarea' }],
  },
};

/**
 * Default graph: trigger access_code → send_form_link → form_submit → forward_desk
 */
function buildDefaultWorkflowGraph() {
  return {
    drawflow: {
      Home: {
        data: {
          '1': {
            id: 1,
            name: 'trigger_message',
            data: {
              label: 'When common access code received',
              trigger_mode: 'access_code',
              keywords: '',
            },
            class: 'node-trigger',
            html: '',
            typenode: false,
            inputs: {},
            outputs: {
              output_1: { connections: [{ node: '2', output: 'input_1' }] },
            },
            pos_x: 80,
            pos_y: 180,
          },
          '2': {
            id: 2,
            name: 'send_form_link',
            data: {
              label: 'Send Web Form Link',
              message: '{{form_link}}',
            },
            class: 'node-action',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '1', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [{ node: '3', output: 'input_1' }] },
            },
            pos_x: 420,
            pos_y: 180,
          },
          '3': {
            id: 3,
            name: 'form_submit',
            data: {
              label: 'Receive Form Submit',
              confirmation_message: '',
            },
            class: 'node-event',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '2', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [{ node: '4', output: 'input_1' }] },
            },
            pos_x: 760,
            pos_y: 180,
          },
          '4': {
            id: 4,
            name: 'forward_desk',
            data: {
              label: 'Forward to Company Desk',
            },
            class: 'node-action',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '3', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [] },
            },
            pos_x: 1100,
            pos_y: 180,
          },
        },
      },
    },
  };
}

module.exports = { NODE_META, buildDefaultWorkflowGraph };
