const fs = require('fs');
const path = require('path');

const transcript =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/93c1067c-8095-4a2a-9dca-77911eddb757.jsonl';
const lines = fs.readFileSync(transcript, 'utf8').split(/\n/).filter(Boolean);
const outDir = __dirname;
const CUTOFF = 415; // before free-tier strip

function collectToolCalls(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((x) => collectToolCalls(x, out));
    return out;
  }
  if (obj.name && obj.input) out.push({ name: obj.name, input: obj.input });
  for (const v of Object.values(obj)) collectToolCalls(v, out);
  return out;
}

function normPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

const targets = [
  'src/config/db.js',
  'src/models/index.js',
  'src/services/whatsapp.js',
  'src/routes/index.js',
  'src/utils/seed.js',
  'src/utils/leadsummary.js',
  'src/services/workflowengine.js',
  'views/form.ejs',
];

const nameMap = {
  'src/config/db.js': 'db.js',
  'src/models/index.js': 'models.js',
  'src/services/whatsapp.js': 'whatsapp.js',
  'src/routes/index.js': 'routes.js',
  'src/utils/seed.js': 'seed.js',
  'src/utils/leadsummary.js': 'leadSummary.js',
  'src/services/workflowengine.js': 'workflowEngine.js',
  'views/form.ejs': 'form.ejs',
};

const state = {};

for (let idx = 0; idx < CUTOFF - 1 && idx < lines.length; idx++) {
  let j;
  try {
    j = JSON.parse(lines[idx]);
  } catch {
    continue;
  }
  for (const t of collectToolCalls(j)) {
    if (!t.input) continue;
    if (t.name === 'Write' && t.input.path && t.input.contents != null) {
      const np = normPath(t.input.path);
      const hit = targets.find((t2) => np.endsWith(t2));
      if (hit) {
        state[hit] = {
          line: idx + 1,
          contents: t.input.contents,
          via: 'Write',
          misses: 0,
        };
      }
    }
    if (t.name === 'StrReplace' && t.input.path) {
      const np = normPath(t.input.path);
      const hit = targets.find((t2) => np.endsWith(t2));
      if (
        hit &&
        state[hit] &&
        t.input.old_string != null &&
        t.input.new_string != null
      ) {
        const c = state[hit].contents;
        if (c.includes(t.input.old_string)) {
          const all = !!t.input.replace_all;
          state[hit].contents = all
            ? c.split(t.input.old_string).join(t.input.new_string)
            : c.replace(t.input.old_string, t.input.new_string);
          state[hit].line = idx + 1;
          state[hit].via = 'StrReplace';
        } else {
          state[hit].misses = (state[hit].misses || 0) + 1;
        }
      }
    }
  }
}

for (const [k, file] of Object.entries(nameMap)) {
  const v = state[k];
  if (!v) {
    console.log('MISSING', k);
    continue;
  }
  fs.writeFileSync(path.join(outDir, file), v.contents);
  console.log(
    file,
    'last@',
    v.line,
    'via',
    v.via,
    'len',
    v.contents.length,
    'misses',
    v.misses || 0
  );
}
