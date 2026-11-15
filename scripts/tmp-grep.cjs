/* Temporary audit: strings that look like configuration keys. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
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
for (const t of targets) {
  console.log('=== ' + t);
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(t)) console.log(`  ${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
}