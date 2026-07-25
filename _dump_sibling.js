const fs = require('fs');
const path =
  'C:/Users/LENOVO/.cursor/projects/c-Users-LENOVO-OneDrive-Desktop-whatsapp/agent-transcripts/93c1067c-8095-4a2a-9dca-77911eddb757/subagents/7fdd8ff8-60fe-4ee7-824f-fb05fafeaa16.jsonl';
const text = fs.readFileSync(path, 'utf8');
const obj = JSON.parse(text.split(/\n/)[0]);
const q = obj.message.content[0].text;
fs.writeFileSync('C:/Users/LENOVO/OneDrive/Desktop/whatsapp/_extracted/sibling_services_prompt.txt', q);
console.log(q.length);
