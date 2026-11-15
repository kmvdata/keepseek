/* Temporary audit: every getConfiguration(...).get/inspect key with its file. */
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const ROOT = path.resolve(__dirname, '..');
const declared = new Set(Object.keys(pkg.contributes.configuration.properties).map((k) => k.replace(/^kmvdata\.keepseek\./, '')));
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
const found = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  text.forEach((line, i) => {
    const re = /\.(?:get|inspect)(?:<[^>]*>)?\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(line))) {
      const key = m[1];
      if (!/^[a-z][\w.]*$/i.test(key) || key.includes('-')) continue;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push(`${path.relative(ROOT, f)}:${i + 1}`);
    }
  });
}
for (const [key, refs] of [...found].sort()) {
  console.log(`${declared.has(key) ? 'DECLARED  ' : 'UNDECLARED'} ${key}\n    ${refs.join('\n    ')}`);
}