const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const vsixPath = path.resolve(root, process.argv[2] || `${packageJson.name}-${packageJson.version}.vsix`);

const requiredEntries = new Set([
  'extension/package.json',
  normalizeVsixEntry(path.posix.join('extension', normalizePackagePath(packageJson.main || ''))),
  normalizeVsixEntry(path.posix.join('extension', normalizePackagePath(packageJson.icon || ''))),
  'extension/out/provider/KeepseekChatViewProvider.js',
  'extension/out/workspace/gitIgnore.js'
]);

for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
  requiredEntries.add(normalizeVsixEntry(path.posix.join('extension/node_modules', dependencyName, 'package.json')));
}

const forbiddenEntries = [
  'extension/out/agentProtocol.js',
  'extension/out/agentRunner.js',
  'extension/out/contextUsage.js',
  'extension/out/fileContext.js',
  'extension/out/fileReference.js',
  'extension/out/referenceResources.js',
  'extension/out/workspaceTools.js'
];

const entries = readZipEntries(vsixPath);
const missing = [...requiredEntries].filter((entry) => !entries.has(entry));
const stale = forbiddenEntries.filter((entry) => entries.has(entry));

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(`VSIX is missing required runtime files:\n${missing.map((entry) => `  - ${entry}`).join('\n')}`);
  }
  if (stale.length) {
    console.error(`VSIX contains stale legacy build outputs:\n${stale.map((entry) => `  - ${entry}`).join('\n')}`);
    console.error('Run npm run build so out/ is cleaned before packaging.');
  }
  process.exit(1);
}

console.log(`Verified ${path.relative(root, vsixPath)} (${entries.size} entries).`);

function normalizePackagePath(value) {
  return String(value || '').replace(/^[.][/\\]/u, '').replace(/\\/gu, '/');
}

function normalizeVsixEntry(value) {
  return value.replace(/\\/gu, '/').replace(/^\/+/u, '');
}

function readZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const end = centralDirectoryOffset + centralDirectorySize;
  const entries = new Set();

  let offset = centralDirectoryOffset;
  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid VSIX central directory at byte ${offset}.`);
    }

    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    entries.add(buffer.toString('utf8', nameStart, nameEnd));
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  throw new Error('Invalid VSIX: could not find ZIP end of central directory.');
}
