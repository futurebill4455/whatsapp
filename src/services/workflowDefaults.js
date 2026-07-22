/**
 * Default Drawflow export for the insurance lead workflow.
 * Node `name` values are the executable types used by the engine.
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
              keywords: 'hi,hello,hey,start,ഹായ്',
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
              message:
                'Welcome to *{{business_name}}*! 👋\n\nPlease fill out your insurance details:\n{{form_link}}',
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
            pos_x: 380,
            pos_y: 180,
          },
          '3': {
            id: 3,
            name: 'form_submit',
            data: {
              label: 'Receive Form Submit',
              confirmation_message:
                'Hi {{name}}, please confirm your details:\n\n• Name: {{name}}\n• Type: {{insurance_type}}\n• Company: {{company}}\n{{details}}\n\n*Is this correct?* Reply *Yes* or *No*.',
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
            pos_x: 700,
            pos_y: 180,
          },
          '4': {
            id: 4,
            name: 'condition_yes_no',
            data: {
              label: 'Condition / If-Else',
              yes_keywords: 'yes,y,confirm,ok,okay',
              no_keywords: 'no,n,cancel',
            },
            class: 'node-condition',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '3', input: 'output_1' }] },
            },
            outputs: {
              output_1: { connections: [{ node: '5', output: 'input_1' }] },
              output_2: { connections: [{ node: '6', output: 'input_1' }] },
            },
            pos_x: 1020,
            pos_y: 180,
          },
          '5': {
            id: 5,
            name: 'forward_desk',
            data: {
              label: 'Forward to Internal Desk',
              success_message:
                'Thank you! Your details have been confirmed and forwarded to our team.',
            },
            class: 'node-action',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '4', input: 'output_1' }] },
            },
            outputs: { output_1: { connections: [] } },
            pos_x: 1360,
            pos_y: 80,
          },
          '6': {
            id: 6,
            name: 'send_text',
            data: {
              label: 'Resend Form (No)',
              message:
                'No problem — we will send a fresh form link shortly. Please refill your details.',
            },
            class: 'node-action',
            html: '',
            typenode: false,
            inputs: {
              input_1: { connections: [{ node: '4', input: 'output_2' }] },
            },
            outputs: { output_1: { connections: [] } },
            pos_x: 1360,
            pos_y: 300,
          },
        },
      },
    },
  };
}

const NODE_META = {
  trigger_message: {
    title: 'When chat message received',
    category: 'trigger',
    inputs: 0,
    outputs: 1,
    outputLabels: ['Out'],
    color: '#f59e0b',
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

module.exports = { buildDefaultWorkflowGraph, NODE_META };
