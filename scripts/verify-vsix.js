const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { assertPackagedConfiguration } = require('./verify-configuration.cjs');

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

// html.ts constructs provider icon names dynamically. Verify the complete resource
// directory instead of maintaining a second list of supported providers here.
for (const resource of fs.readdirSync(path.join(root, 'resources'))) {
  if (/\.(svg|png)$/u.test(resource)) requiredEntries.add(`extension/resources/${resource}`);
}

const forbiddenEntries = [
  'extension/out/agentProtocol.js',
  'extension/out/agentRunner.js',
  'extension/out/contextUsage.js',
  'extension/out/fileContext.js',
  'extension/out/fileReference.js',
  'extension/out/referenceResources.js',
  'extension/out/workspaceTools.js',
  'extension/out/keybindings.js'
];

const entries = readZipEntries(vsixPath);
const packagedManifest = JSON.parse(readZipEntry(vsixPath, 'extension/package.json'));
assertPackagedConfiguration(packagedManifest, packageJson, readZipEntry(vsixPath, 'extension/out/shared/identity.js'));
if (`${packagedManifest.publisher}.${packagedManifest.name}` !== 'keepseek.keepseek'
  || packagedManifest.publisher !== packageJson.publisher || packagedManifest.version !== packageJson.version) {
  throw new Error('VSIX identity or version does not match the keepseek.keepseek baseline.');
}
const missing = [...requiredEntries].filter((entry) => !entries.has(entry));
const stale = forbiddenEntries.filter((entry) => entries.has(entry));
stale.push(...[...entries].filter((entry) => entry.startsWith('extension/.reasonix/')));

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(`VSIX is missing required runtime files:\n${missing.map((entry) => `  - ${entry}`).join('\n')}`);
  }
  if (stale.length) {
    console.error(`VSIX contains excluded build outputs or local metadata:\n${stale.map((entry) => `  - ${entry}`).join('\n')}`);
    console.error('Run bun run package:market so out/ is cleaned before packaging.');
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

function readZipEntry(filePath, name) {
  const buffer = fs.readFileSync(filePath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const end = offset + buffer.readUInt32LE(eocdOffset + 12);
  while (offset < end) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (buffer.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      const localOffset = buffer.readUInt32LE(offset + 42);
      const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataOffset, dataOffset + buffer.readUInt32LE(offset + 20));
      const method = buffer.readUInt16LE(offset + 10);
      if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression for ${name}`);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing ZIP entry: ${name}`);
}
