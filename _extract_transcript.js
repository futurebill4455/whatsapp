const fs = require('fs');
const path =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/93c1067c-8095-4a2a-9dca-77911eddb757.jsonl';
const lines = fs.readFileSync(path, 'utf8').split(/\n/);
console.log('lines', lines.length);
let writeCount = 0;
const sample = [];
const outDir = 'C:/Users/LENOVO/OneDrive/Desktop/whatsapp/_extracted';
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  'models/index.js',
  'utils/seed.js',
  'utils/leadSummary.js',
  'services/workflowDefaults.js',
  'scripts/ensure-css.js',
];

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
    if (part.type === 'tool_use' && part.name === 'Write') {
      writeCount++;
      const p = String(part.input?.path || '').replace(/\\/g, '/');
      if (targets.some((t) => p.endsWith(t))) {
        const base = p.split('/').slice(-2).join('_');
        const contents = part.input?.contents || '';
        sample.push({ i: i + 1, path: p, len: contents.length });
        fs.writeFileSync(`${outDir}/${i + 1}_${base}`, contents, 'utf8');
      }
    }
    if (part.type === 'tool_use' && part.name === 'StrReplace') {
      const p = String(part.input?.path || '').replace(/\\/g, '/');
      if (targets.some((t) => p.endsWith(t))) {
        sample.push({
          i: i + 1,
          path: p,
          kind: 'StrReplace',
          oldLen: (part.input?.old_string || '').length,
          newLen: (part.input?.new_string || '').length,
        });
        fs.writeFileSync(
          `${outDir}/${i + 1}_str_${p.split('/').pop()}.json`,
          JSON.stringify(
            {
              path: p,
              old_string: part.input?.old_string,
              new_string: part.input?.new_string,
            },
            null,
            2
          ),
          'utf8'
        );
      }
    }
  }
});
console.log('writeCount', writeCount);
console.log(JSON.stringify(sample, null, 2));
