/* Temporary audit: functions/getters exported from config.ts and their callers. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.ts$/.test(e.name)) files.push(f);
  }
}
walk(path.join(ROOT, 'src'));
walk(path.join(ROOT, 'test'));

for (const name of process.argv.slice(2)) {
  const hits = [];
  for (const f of files) {
    if (path.basename(f) === 'config.ts' && f.includes('src/shared')) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => { if (l.includes(name)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  console.log(`=== ${name}: ${hits.length} external refs`);
  hits.forEach((h) => console.log('  ' + h));
}