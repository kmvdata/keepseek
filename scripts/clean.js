const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

for (const entry of ['out']) {
  fs.rmSync(path.join(root, entry), { recursive: true, force: true });
}
