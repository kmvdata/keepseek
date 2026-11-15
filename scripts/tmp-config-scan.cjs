/* Temporary audit script: list every configuration key actually read by getConfiguration. */
const fs = require('fs');
const path = require('path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const declared = Object.keys(pkg.contributes.configuration.properties);

const keys = new Set();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (/\.ts$/.test(e.name)) {
      const text = fs.readFileSync(f, 'utf8');
      const re = /\.(?:get|inspect)(?:<[^>]*>)?\(\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(text))) keys.add(m[1]);
    }
  }
}
walk(path.join(__dirname, '..', 'src'));
walk(path.join(__dirname, '..', 'test'));

const ns = 'kmvdata.keepseek.';
const declaredShort = declared.map((k) => k.startsWith(ns) ? k.slice(ns.length) : k);
console.log('DECLARED BUT NEVER READ:');
for (const k of declaredShort) if (!keys.has(k)) console.log('  ' + k);
console.log('READ BUT NOT DECLARED:');
for (const k of keys) if (!declaredShort.includes(k) && !k.startsWith('kmvdata.')) console.log('  ' + k);