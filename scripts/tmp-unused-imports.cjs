/* Temporary audit: imports that resolve to a module and are never referenced in the file itself. */
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
const importRe = /import\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([\s\S]*?)\})?\s+from\s+'([^']+)'/g;
const results = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const fLocal = path.resolve(f);
  importRe.lastIndex = 0;
  let m;
  while ((m = importRe.exec(text))) {
    const [, isType, dflt, named, spec] = m;
    if (!spec.startsWith('.')) continue;
    if (/side-effect/.test(spec)) continue;
    const names = [];
    if (dflt) names.push(dflt);
    if (named) {
      for (const part of named.split(',')) {
        const t = part.trim();
        if (!t) continue;
        const nm = t.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.push(nm);
      }
    }
    const body = text.slice(0, m.index) + text.slice(m.index + m[0].length);
    const unused = names.filter((n) => {
      const re = new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
      const hits = body.match(re) || [];
      // a name used only in a type position across the rest is still a use; counts >0 means used
      return hits.length === 0;
    });
    if (unused.length) results.push(`${path.relative(ROOT, f)}: imported ${unused.join(', ')} from '${spec}' — UNUSED`);
  }
}
results.sort().forEach((r) => console.log(r));
console.log('TOTAL', results.length);