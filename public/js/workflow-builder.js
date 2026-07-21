(function () {
  const cfg = window.__WORKFLOW__;
  if (!cfg || typeof Drawflow === 'undefined') {
    console.error('Workflow builder: Drawflow or config missing');
    return;
  }

  const meta = cfg.nodeMeta || {};
  const editor = new Drawflow(document.getElementById('drawflow'));
  editor.reroute = true;
  editor.reroute_fix_width = 3;
  editor.force_first_input = false;
  editor.start();

  let selectedId = null;

  function classFor(type) {
    const cat = (meta[type] && meta[type].category) || 'action';
    return 'node-' + cat;
  }

  function previewText(type, data) {
    data = data || {};
    if (type === 'trigger_message') return 'Keywords: ' + (data.keywords || 'hi');
    if (type === 'send_form_link') return (data.message || '').slice(0, 80);
    if (type === 'form_submit') return 'Waits for web form · then confirmation';
    if (type === 'condition_yes_no') return 'Yes → out 1 · No → out 2';
    if (type === 'forward_desk') return 'Routes by insurance type';
    if (type === 'send_text') return (data.message || '').slice(0, 80);
    return type;
  }

  function nodeHtml(type, data) {
    data = data || {};
    const title = data.label || (meta[type] && meta[type].title) || type;
    const outs = (meta[type] && meta[type].outputLabels) || ['Out'];
    const ports = outs.map(function (l, i) {
      return '<span class="right">' + l + (outs.length > 1 ? ' · ' + (i + 1) : '') + '</span>';
    }).join('');
    return (
      '<div class="df-node-card">' +
        '<div class="df-type">' + ((meta[type] && meta[type].category) || 'node') + '</div>' +
        '<div class="df-title">' + escapeHtml(title) + '</div>' +
        '<div class="df-meta">' + escapeHtml(previewText(type, data)) + '</div>' +
      '</div>' +
      '<div class="df-ports"><span>In</span>' + ports + '</div>'
    );
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function registerTypes() {
    Object.keys(meta).forEach(function (type) {
      const m = meta[type];
      editor.registerNode(
        type,
        nodeHtml(type, { label: m.title }),
        {},
        m.inputs || 0,
        m.outputs || 1,
        classFor(type)
      );
    });
  }

  function enrichLoadedHtml() {
    const data = editor.drawflow.drawflow.Home.data;
    Object.keys(data).forEach(function (id) {
      const n = data[id];
      const el = document.getElementById('node-' + id);
      if (!el) return;
      el.classList.add(classFor(n.name));
      const html = nodeHtml(n.name, n.data);
      const content = el.querySelector('.drawflow_content_node');
      if (content) content.innerHTML = html;
    });
  }

  function addNodeAt(type, x, y) {
    const m = meta[type];
    if (!m) return;
    const defaults = defaultData(type);
    const id = editor.addNode(
      type,
      m.inputs || 0,
      m.outputs || 1,
      x,
      y,
      classFor(type),
      defaults,
      nodeHtml(type, defaults)
    );
    return id;
  }

  function defaultData(type) {
    switch (type) {
      case 'trigger_message':
        return { label: 'When chat message received', keywords: 'hi,hello,hey' };
      case 'send_form_link':
        return {
          label: 'Send Web Form Link',
          message: 'Welcome to *{{business_name}}*!\n\nFill this form:\n{{form_link}}',
        };
      case 'form_submit':
        return {
          label: 'Receive Form Submit',
          confirmation_message:
            'Hi {{name}}, confirm:\n• {{insurance_type}} / {{company}}\nReply Yes or No.',
        };
      case 'condition_yes_no':
        return {
          label: 'Condition / If-Else',
          yes_keywords: 'yes,y,confirm,ok,okay',
          no_keywords: 'no,n,cancel',
        };
      case 'forward_desk':
        return {
          label: 'Forward to Internal Desk',
          success_message: 'Thank you! Details forwarded to our team.',
        };
      case 'send_text':
        return { label: 'Send Text Message', message: 'Hello from the workflow.' };
      default:
        return { label: type };
    }
  }

  // Load saved graph
  registerTypes();
  if (cfg.graph && cfg.graph.drawflow) {
    editor.import(cfg.graph);
    setTimeout(enrichLoadedHtml, 50);
  }

  // Palette drag → canvas drop
  const palette = document.getElementById('palette');
  let dragType = null;

  palette.querySelectorAll('.wf-palette-item').forEach(function (item) {
    item.addEventListener('dragstart', function (e) {
      dragType = item.getAttribute('data-node');
      e.dataTransfer.setData('node', dragType);
      e.dataTransfer.effectAllowed = 'move';
    });
  });

  const canvas = document.getElementById('drawflow');
  canvas.addEventListener('dragover', function (e) {
    e.preventDefault();
  });
  canvas.addEventListener('drop', function (e) {
    e.preventDefault();
    const type = e.dataTransfer.getData('node') || dragType;
    if (!type) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / editor.zoom - editor.precanvas.clientLeft - (editor.precanvas.getBoundingClientRect().x - rect.x) / editor.zoom;
    const y = (e.clientY - rect.top) / editor.zoom - (editor.precanvas.getBoundingClientRect().y - rect.y) / editor.zoom;
    // Simpler positioning using Drawflow helpers
    const pos_x = e.clientX * (editor.precanvas.clientWidth / (editor.precanvas.clientWidth * editor.zoom)) - editor.precanvas.getBoundingClientRect().x * (editor.precanvas.clientWidth / (editor.precanvas.clientWidth * editor.zoom));
    const pos_y = e.clientY * (editor.precanvas.clientHeight / (editor.precanvas.clientHeight * editor.zoom)) - editor.precanvas.getBoundingClientRect().y * (editor.precanvas.clientHeight / (editor.precanvas.clientHeight * editor.zoom));
    addNodeAt(type, pos_x, pos_y);
  });

  // Inspector
  const form = document.getElementById('inspector-form');
  const empty = document.getElementById('inspector-empty');
  const fields = document.getElementById('insp-fields');

  editor.on('nodeSelected', function (id) {
    selectedId = String(id);
    const node = editor.getNodeFromId(id);
    if (!node) return;
    empty.classList.add('hidden');
    form.classList.remove('hidden');
    document.getElementById('insp-id').value = id;
    document.getElementById('insp-type').value = node.name;
    document.getElementById('insp-label').value = (node.data && node.data.label) || '';
    renderFields(node.name, node.data || {});
  });

  editor.on('nodeUnselected', function () {
    selectedId = null;
    form.classList.add('hidden');
    empty.classList.remove('hidden');
  });

  function renderFields(type, data) {
    fields.innerHTML = '';
    const schema = fieldSchema(type);
    schema.forEach(function (f) {
      const label = document.createElement('label');
      label.textContent = f.label;
      fields.appendChild(label);
      let input;
      if (f.multiline) {
        input = document.createElement('textarea');
        input.className = 'wf-textarea';
        input.rows = 5;
      } else {
        input = document.createElement('input');
        input.className = 'wf-input';
        input.type = 'text';
      }
      input.id = 'field-' + f.key;
      input.value = data[f.key] != null ? data[f.key] : (f.default || '');
      fields.appendChild(input);
    });
  }

  function fieldSchema(type) {
    if (type === 'trigger_message') {
      return [{ key: 'keywords', label: 'Trigger keywords (comma-separated)', default: 'hi,hello' }];
    }
    if (type === 'send_form_link') {
      return [{ key: 'message', label: 'WhatsApp message ({{form_link}}, {{business_name}})', multiline: true }];
    }
    if (type === 'form_submit') {
      return [{ key: 'confirmation_message', label: 'Confirmation after submit', multiline: true }];
    }
    if (type === 'condition_yes_no') {
      return [
        { key: 'yes_keywords', label: 'Yes keywords', default: 'yes,y,ok' },
        { key: 'no_keywords', label: 'No keywords', default: 'no,n,cancel' },
      ];
    }
    if (type === 'forward_desk') {
      return [{ key: 'success_message', label: 'Customer success message', multiline: true }];
    }
    if (type === 'send_text') {
      return [{ key: 'message', label: 'Message body', multiline: true }];
    }
    return [];
  }

  document.getElementById('insp-apply').addEventListener('click', function () {
    if (!selectedId) return;
    const node = editor.getNodeFromId(selectedId);
    const type = node.name;
    const data = Object.assign({}, node.data || {});
    data.label = document.getElementById('insp-label').value.trim() || data.label;
    fieldSchema(type).forEach(function (f) {
      const el = document.getElementById('field-' + f.key);
      if (el) data[f.key] = el.value;
    });
    editor.updateNodeDataFromId(selectedId, data);
    const el = document.getElementById('node-' + selectedId);
    if (el) {
      const content = el.querySelector('.drawflow_content_node');
      if (content) content.innerHTML = nodeHtml(type, data);
    }
  });

  document.getElementById('insp-delete').addEventListener('click', function () {
    if (!selectedId) return;
    if (!confirm('Delete this node?')) return;
    editor.removeNodeId('node-' + selectedId);
    selectedId = null;
    form.classList.add('hidden');
    empty.classList.remove('hidden');
  });

  async function save() {
    const graph = editor.export();
    const res = await fetch('/api/admin/workflows/' + cfg.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graph: graph }),
    });
    if (!res.ok) {
      alert('Save failed');
      return;
    }
    flashSave();
  }

  function flashSave() {
    const btn = document.getElementById('btn-save');
    const old = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(function () { btn.textContent = old; }, 1400);
  }

  document.getElementById('btn-save').addEventListener('click', save);

  document.getElementById('btn-activate').addEventListener('click', async function () {
    await save();
    const res = await fetch('/api/admin/workflows/' + cfg.id + '/activate', { method: 'POST' });
    if (res.ok) {
      const pill = document.getElementById('wf-status');
      pill.textContent = 'Active';
      pill.classList.add('live');
    }
  });

  document.getElementById('btn-reset').addEventListener('click', async function () {
    if (!confirm('Replace canvas with the default insurance workflow?')) return;
    const res = await fetch('/api/admin/workflows/' + cfg.id + '/reset-default', { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      editor.clear();
      editor.import(json.workflow.graph);
      setTimeout(enrichLoadedHtml, 50);
    }
  });
})();
