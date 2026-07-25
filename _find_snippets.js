const fs = require('fs');
const path =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/93c1067c-8095-4a2a-9dca-77911eddb757.jsonl';
const lines = fs.readFileSync(path, 'utf8').split(/\n/);
const outDir = 'C:/Users/LENOVO/OneDrive/Desktop/whatsapp/_extracted/snippets';
fs.mkdirSync(outDir, { recursive: true });

const keywords = [
  'phoneMatchKeys',
  'phonesMatch',
  'tryUnlock',
  'resolveDeskInbound',
  'AccessUsers',
  'session_code',
  'DEFAULT_FORWARD_TEMPLATE',
  'buildDefaultWorkflowGraph',
  'NODE_META',
  'condition_access',
  'ai_assist',
  'sanitizeFormLink',
  'waiting_code',
  'findLatestOpen',
  'markConfirmed',
  'listActiveByDesk',
  'countOutboundSince',
  'buildForwardMessage',
];

let n = 0;
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
    const blob = JSON.stringify(part.input || {});
    if (!keywords.some((k) => blob.includes(k))) continue;
    const name = `${i + 1}_${part.name}_${(part.input?.path || 'x').split(/[/\\\\]/).pop()}`;
    fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify(part.input, null, 2));
    n++;
  }
});
console.log('wrote', n, 'snippets');

// also dump sibling prompt
const sib =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/subagents/7fdd8ff8-60fe-4ee7-824f-fb05fafeaa16.jsonl';
try {
  const first = fs.readFileSync(sib, 'utf8').split(/\n/)[0];
  const o = JSON.parse(first);
  fs.writeFileSync(
    'C:/Users/LENOVO/OneDrive/Desktop/whatsapp/_extracted/sibling_services_prompt.txt',
    o.message.content[0].text
  );
  console.log('sibling ok');
} catch (e) {
  console.log('sibling fail', e.message);
}
