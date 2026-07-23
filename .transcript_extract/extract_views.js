const fs = require('fs');
const path = require('path');
const p =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/93c1067c-8095-4a2a-9dca-77911eddb757.jsonl';
const lines = fs.readFileSync(p, 'utf8').split(/\n/).filter(Boolean);

const picks = {
  'views/partials/nav.ejs': 5,
  'views/admin/login.ejs': 7,
  'views/admin/dashboard.ejs': 7,
  'views/admin/settings.ejs': 7,
  'views/admin/flow.ejs': 7,
  'views/admin/catalog.ejs': 8,
  'views/admin/submissions.ejs': 8,
  'views/admin/workflow.ejs': 51,
  'views/admin/form-builder.ejs': 107,
  'views/form-done.ejs': 83,
  'views/qr.ejs': 6,
  'public/css/workflow.css': 52,
  'public/js/workflow-builder.js': 52,
};

const outDir = path.join(__dirname, 'views_restore');
fs.mkdirSync(outDir, { recursive: true });

function normalize(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^.*whatsapp\//, '');
}

const extracted = {};
for (let i = 0; i < lines.length; i++) {
  let o;
  try {
    o = JSON.parse(lines[i]);
  } catch {
    continue;
  }
  const content = o?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const part of content) {
    if (part.type !== 'tool_use' || part.name !== 'Write') continue;
    const rel = normalize(part.input?.path || '');
    if (picks[rel] !== i) continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, part.input.contents, 'utf8');
    extracted[rel] = { i, len: part.input.contents.length };
  }
}

for (const i of [4, 335, 393]) {
  const o = JSON.parse(lines[i]);
  for (const part of o.message.content || []) {
    if (part.name === 'Write' && /server\.js$/.test(part.input?.path || '')) {
      fs.writeFileSync(path.join(outDir, `server_L${i}.js`), part.input.contents);
      extracted[`server_L${i}.js`] = { i, len: part.input.contents.length };
    }
  }
}

console.log(JSON.stringify(extracted, null, 2));
