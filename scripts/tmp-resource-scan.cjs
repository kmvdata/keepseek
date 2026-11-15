/* Temporary audit: which resource/image/doc files are referenced anywhere. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const textFiles = [];
function walk(dir, skip) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.some((s) => e.name === s)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, skip);
    else if (/\.(ts|js|cjs|mjs|json|md|html|css|svg|png|yml|yaml)$/.test(e.name)) textFiles.push(f);
  }
}
walk(ROOT, ['node_modules', 'out', 'out-test', '.git', 'images', 'resources', '.dsh-acl-recovery']);
const corpus = textFiles.filter((f) => !/\.(png)$/.test(f)).map((f) => ({ f, text: fs.readFileSync(f, 'utf8') }));

function referenced(name, selfPath) {
  const base = path.basename(name);
  return corpus.filter(({ f, text }) => f !== selfPath && text.includes(base)).map(({ f }) => path.relative(ROOT, f));
}

for (const dir of ['resources', 'images']) {
  console.log(`=== ${dir}`);
  for (const e of fs.readdirSync(path.join(ROOT, dir))) {
    const refs = referenced(e, path.join(ROOT, dir, e));
    console.log(`  ${e}: ${refs.length ? refs.slice(0, 4).join(', ') : 'UNREFERENCED'}`);
  }
}