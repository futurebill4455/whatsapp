/**
 * Default Drawflow export for the insurance lead workflow.
 * Node `name` values are the executable types used by the engine.
 */

const NODE_META = {
  trigger_message: {
    title: 'When chat message received',
    category: 'trigger',
    inputs: 0,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#f59e0b',
  },
  condition_access: {
    title: 'Check User / Access Code',
    category: 'condition',
    inputs: 1,
    outputs: 2,
    outputLabels: ['Authorized', 'Denied'],
    color: '#7c3aed',
  },
  send_form_link: {
    title: 'Send Web Form Link',
    category: 'action',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#0d7377',
  },
  form_submit: {
    title: 'Receive Form Submit',
    category: 'event',
    inputs: 1,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#6366f1',
  },
  condition_yes_no: {
    title: 'Condition / If-Else',
    category: 'condition',
    inputs: 1,
    outputs: 2,
    outputLabels: ['Yes', 'No'],
    color: '#c45c26',
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
  },
};

/**
 * Default graph: any message → access code check → bare form link (denied = silence).
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
              label: 'When chat message received',
              keywords: '*,any',
            },
            class: 'node-trigger',
            html: '',
            typenode: false,
            inputs: {},
            outputs: {
              output_1: { connections: [{ node: '2', output: 'input_1' }] },
            },
            pos_x: 60,
            pos_y: 200,
          },
          '2': {
            id: 2,
            name: 'condition_access',
            data: {
              label: 'Check User / Access Code',
              mode: 'code',
            },
            class: 'node-condition',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '1', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [{ node: '3', output: 'input_1' }] },
              output_2: { connections: [] },
            },
            pos_x: 340,
            pos_y: 180,
          },
          '3': {
            id: 3,
            name: 'send_form_link',
            data: {
              label: 'Send Web Form Link',
              message: '{{form_link}}',
            },
            class: 'node-action',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '2', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [{ node: '4', output: 'input_1' }] },
            },
            pos_x: 660,
            pos_y: 120,
          },
          '4': {
            id: 4,
            name: 'form_submit',
            data: {
              label: 'Receive Form Submit',
              confirmation_message: '',
            },
            class: 'node-event',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '3', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [{ node: '5', output: 'input_1' }] },
            },
            pos_x: 960,
            pos_y: 120,
          },
          '5': {
            id: 5,
            name: 'forward_desk',
            data: {
              label: 'Forward to Company Desk',
            },
            class: 'node-action',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '4', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [] },
            },
            pos_x: 1260,
            pos_y: 120,
          },
        },
      },
    },
  };
}

module.exports = { NODE_META, buildDefaultWorkflowGraph };
