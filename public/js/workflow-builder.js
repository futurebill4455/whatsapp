(function () {
  const cfg = window.__WORKFLOW__;
  if (!cfg || typeof Drawflow === 'undefined') {
    console.error('[workflow] Drawflow or config missing');
    return;
  }

  const meta = cfg.nodeMeta || {};
  const editorEl = document.getElementById('drawflow');
  const palette = document.getElementById('nodePalette');
  const statusEl = document.getElementById('wfStatus');
  const nameInput = document.getElementById('workflowName');

  const editor = new Drawflow(editorEl);
  editor.reroute = true;
  editor.start();

  function setStatus(msg, ok) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'text-xs ' + (ok === false ? 'text-coral' : 'text-sea');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fieldHtml(fields, data) {
    if (!fields || !fields.length) {
      return '<div style="color:#94a3b8">No config</div>';
    }
    return fields
      .map(function (f) {
        const val = data && data[f.key] != null ? String(data[f.key]) : '';
        if (f.type === 'textarea') {
          return (
            '<label>' +
            escapeHtml(f.label) +
            '<textarea df-' +
            f.key +
            ' rows="2">' +
            escapeHtml(val) +
            '</textarea></label>'
          );
        }
        if (f.type === 'select' && Array.isArray(f.options)) {
          const opts = f.options
            .map(function (o) {
              return (
                '<option value="' +
                escapeHtml(o) +
                '"' +
                (o === val ? ' selected' : '') +
                '>' +
                escapeHtml(o) +
                '</option>'
              );
            })
            .join('');
          return (
            '<label>' +
            escapeHtml(f.label) +
            '<select df-' +
            f.key +
            '>' +
            opts +
            '</select></label>'
          );
        }
        return (
          '<label>' +
          escapeHtml(f.label) +
          '<input type="text" df-' +
          f.key +
          ' value="' +
          escapeHtml(val) +
          '" /></label>'
        );
      })
      .join('');
  }

  function nodeHtml(type, data) {
    const m = meta[type] || { title: type, color: '#334155', fields: [] };
    return (
      '<div class="title-box" style="background:' +
      (m.color || '#334155') +
      '">' +
      escapeHtml(m.title || type) +
      '</div><div class="box">' +
      fieldHtml(m.fields, data || {}) +
      '</div>'
    );
  }

  function enrichGraph(graph) {
    if (!graph || !graph.drawflow || !graph.drawflow.Home || !graph.drawflow.Home.data) {
      return graph;
    }
    const data = graph.drawflow.Home.data;
    Object.keys(data).forEach(function (id) {
      const node = data[id];
      if (!node) return;
      node.html = nodeHtml(node.name, node.data || {});
      const m = meta[node.name];
      if (m && m.category) node.class = 'node-' + m.category;
    });
    return graph;
  }

  function buildPalette() {
    if (!palette) return;
    palette.innerHTML = '';
    Object.keys(meta).forEach(function (type) {
      const m = meta[type];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wf-palette-btn';
      btn.innerHTML =
        '<span class="dot" style="background:' +
        (m.color || '#64748b') +
        '"></span>' +
        escapeHtml(m.title || type);
      btn.addEventListener('click', function () {
        const data = { label: m.title || type };
        if (m.fields) {
          m.fields.forEach(function (f) {
            data[f.key] = f.options ? f.options[0] : '';
          });
        }
        editor.addNode(
          type,
          m.inputs || 0,
          m.outputs || 1,
          100 + Math.random() * 160,
          100 + Math.random() * 220,
          'node-' + (m.category || 'action'),
          data,
          nodeHtml(type, data)
        );
      });
      palette.appendChild(btn);
    });
  }

  function loadGraph(graph) {
    try {
      editor.clear();
      if (graph && graph.drawflow) {
        editor.import(enrichGraph(JSON.parse(JSON.stringify(graph))));
      }
    } catch (err) {
      console.error('[workflow] import failed', err);
      setStatus('Could not load graph', false);
    }
  }

  buildPalette();
  loadGraph(cfg.graph);

  async function saveGraph() {
    const graph = editor.export();
    const name = nameInput ? nameInput.value.trim() : '';
    setStatus('Saving…');
    try {
      const res = await fetch('/api/workflows/' + cfg.id + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph: graph, name: name || undefined }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Save failed');
      setStatus('Saved at ' + new Date().toLocaleTimeString(), true);
    } catch (err) {
      setStatus(err.message || 'Save failed', false);
    }
  }

  async function activate() {
    setStatus('Activating…');
    try {
      const res = await fetch('/api/workflows/' + cfg.id + '/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Activate failed');
      setStatus('Workflow activated', true);
    } catch (err) {
      setStatus(err.message || 'Activate failed', false);
    }
  }

  const btnSave = document.getElementById('btnSave');
  const btnActivate = document.getElementById('btnActivate');
  if (btnSave) btnSave.addEventListener('click', saveGraph);
  if (btnActivate) btnActivate.addEventListener('click', activate);
})();
