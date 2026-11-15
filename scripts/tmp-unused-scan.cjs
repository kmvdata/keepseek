/* Temporary audit script: find exported symbols with no reference outside their defining file. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) files.push(full);
  }
}
walk(path.join(ROOT, 'src'));
walk(path.join(ROOT, 'test'));
walk(path.join(ROOT, 'scripts'));

const sources = new Map();
for (const f of files) sources.set(f, fs.readFileSync(f, 'utf8'));

const exportRe = /^export\s+(?:async\s+)?(?:abstract\s+)?(?:declare\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const reExportDefault = /^export\s+default/m;

const results = [];
for (const [f, text] of sources) {
  if (f.includes(`${path.sep}test${path.sep}`) && !f.endsWith('runTests.ts')) continue;
  const names = new Set();
  let m;
  exportRe.lastIndex = 0;
  while ((m = exportRe.exec(text))) names.add(m[1]);
  // export { a, b } lists
  const listRe = /^export\s*\{([^}]*)\}/gm;
  while ((m = listRe.exec(text))) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
    }
  }
  for (const name of names) {
    const wordRe = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    let outside = 0;
    for (const [g, gtext] of sources) {
      if (g === f) continue;
      wordRe.lastIndex = 0;
      if (wordRe.test(gtext)) { outside++; break; }
    }
    // count internal uses beyond declaration (rough)
    const own = (text.match(wordRe) || []).length;
    if (!outside) results.push({ file: path.relative(ROOT, f), name, ownUses: own });
  }
}

for (const r of results.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`${r.file}\t${r.name}\tinternal=${r.ownUses}`);
}
console.log(`TOTAL ${results.length}`);