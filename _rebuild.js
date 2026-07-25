const fs = require('fs');
const path =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/93c1067c-8095-4a2a-9dca-77911eddb757.jsonl';
const lines = fs.readFileSync(path, 'utf8').split(/\n/);

const files = {
  'src/models/index.js': null,
  'src/utils/seed.js': null,
  'src/utils/leadSummary.js': null,
  'src/services/workflowDefaults.js': null,
  'scripts/ensure-css.js': null,
};

function norm(p) {
  return String(p || '').replace(/\\/g, '/');
}

function matchKey(p) {
  const n = norm(p);
  for (const k of Object.keys(files)) {
    if (n.endsWith(k)) return k;
  }
  return null;
}

const ops = [];
lines.forEach((line, i) => {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  const content = obj?.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part.type !== 'tool_use') continue;
    if (part.name === 'Write') {
      const key = matchKey(part.input?.path);
      if (!key) continue;
      ops.push({ i: i + 1, type: 'Write', key, contents: part.input.contents || '' });
    }
    if (part.name === 'StrReplace') {
      const key = matchKey(part.input?.path);
      if (!key) continue;
      ops.push({
        i: i + 1,
        type: 'StrReplace',
        key,
        old_string: part.input.old_string || '',
        new_string: part.input.new_string || '',
        replace_all: !!part.input.replace_all,
      });
    }
  }
});

const failures = [];
for (const op of ops) {
  if (op.type === 'Write') {
    files[op.key] = op.contents;
    continue;
  }
  let cur = files[op.key];
  if (cur == null) {
    failures.push({ i: op.i, key: op.key, reason: 'no base' });
    continue;
  }
  if (!cur.includes(op.old_string)) {
    failures.push({
      i: op.i,
      key: op.key,
      reason: 'old_string not found',
      oldPreview: op.old_string.slice(0, 80),
    });
    continue;
  }
  if (op.replace_all) {
    files[op.key] = cur.split(op.old_string).join(op.new_string);
  } else {
    files[op.key] = cur.replace(op.old_string, op.new_string);
  }
}

const outDir = 'C:/Users/LENOVO/OneDrive/Desktop/whatsapp/_extracted/final';
fs.mkdirSync(outDir, { recursive: true });
for (const [k, v] of Object.entries(files)) {
  if (v == null) {
    console.log('MISSING', k);
    continue;
  }
  const name = k.replace(/\//g, '__');
  fs.writeFileSync(`${outDir}/${name}`, v, 'utf8');
  console.log('OK', k, v.length);
}
console.log('ops', ops.length, 'failures', failures.length);
fs.writeFileSync(`${outDir}/_failures.json`, JSON.stringify(failures, null, 2));
console.log(failures.slice(0, 20));
