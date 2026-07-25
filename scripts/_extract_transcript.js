const fs = require('fs');
const path = require('path');

const root = path.join(
  process.env.USERPROFILE,
  '.cursor',
  'projects',
  'c-Users-LENOVO-OneDrive-Desktop-whatsapp',
  'agent-transcripts',
  '93c1067c-8095-4a2a-9dca-77911eddb757'
);
const outDir = path.join(process.cwd(), '.transcript_recover');
fs.mkdirSync(outDir, { recursive: true });

const targets = ['chromiumLaunch.js', 'deskForward.js', 'workflowEngine.js', 'whatsapp.js'];
const found = {};

function scanFile(filePath, label) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('Write')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const parts = obj?.message?.content || [];
    for (const p of parts) {
      if (p.name !== 'Write' || !p.input?.contents || !p.input?.path) continue;
      for (const t of targets) {
        if (String(p.input.path).replace(/\\/g, '/').endsWith(t) || String(p.input.path).includes(t)) {
          found[t] = {
            label,
            line: i + 1,
            len: p.input.contents.length,
            contents: p.input.contents,
            srcPath: p.input.path,
          };
        }
      }
    }
  }
}

scanFile(path.join(root, '93c1067c-8095-4a2a-9dca-77911eddb757.jsonl'), 'main');
const sub = path.join(root, 'subagents');
for (const f of fs.readdirSync(sub)) {
  if (!f.endsWith('.jsonl')) continue;
  scanFile(path.join(sub, f), f);
}

for (const t of targets) {
  if (!found[t]) {
    console.log('MISSING', t);
    continue;
  }
  const out = path.join(outDir, t);
  fs.writeFileSync(out, found[t].contents, 'utf8');
  console.log('WROTE', t, 'from', found[t].label, 'L' + found[t].line, 'len=' + found[t].len);
}
