const fs = require('fs');
const p = 'K:/keepseek/package.json';
const L = fs.readFileSync(p, 'utf8').split('\n');
const drop = new Set();
for (const [from, to] of [[321, 324], [375, 384], [401, 420]]) {
  for (let i = from; i <= to; i++) drop.add(i);
}
const keep = L.filter((_l, i) => !drop.has(i + 1));
const idx = keep.findIndex((line) => line.includes('"kmvdata.keepseek.skills.maxImplicitActivations"'));
if (idx < 0) throw new Error('maxImplicitActivations not found');
const closing = keep.findIndex((line, i) => i > idx && line.trim() === '},');
if (closing < 0) throw new Error('closing not found');
keep[closing] = keep[closing].replace(/\},\s*$/, '}');
const text = keep.join('\n');
const parsed = JSON.parse(text);
fs.writeFileSync(p, text);
const keys = Object.keys(parsed.contributes.configuration.properties);
console.log('config keys', keys.length);
console.log('still present:', keys.filter((k) => /maxDurationMs|authorizationPolicy|contextCompression|maxTurns|thinking$|enableCache/.test(k)));