#!/usr/bin/env node
'use strict';

// Offline reset only: close VS Code first. No extension discovery, shared SQLite
// edits, keychain access, workspace traversal, or changes to other extensions.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ts = require('typescript');
const EXTENSION_IDS = ['keepseek.keepseek', 'kmvdata.keepseek'];
const NAMESPACE = 'com.kmvdata.keepseek';

function nativeRoot(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
    ? env.LOCALAPPDATA : path.win32.join(home, 'AppData', 'Local'), NAMESPACE);
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', NAMESPACE);
  return path.posix.join(env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share'), NAMESPACE);
}

function defaultUserDataDirectory() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Code');
}

const ownedSetting = key => key === 'keepseek' || key === 'kmvdata.keepseek'
  || key.startsWith('keepseek.') || key.startsWith('kmvdata.keepseek.');
const ownedCommand = command => typeof command === 'string'
  && (command.startsWith('keepseek.') || command.startsWith('kmvdata.keepseek.'));

/** Remove only matching top-level JSONC nodes; keep unrelated bytes/comments. */
function removeEntries(text, file, kind) {
  const source = ts.parseJsonText(file, text);
  if (source.parseDiagnostics.length) throw new Error(`Invalid JSONC; refusing to change ${file}`);
  const value = source.statements[0]?.expression;
  if (!value || (kind === 'settings' ? !ts.isObjectLiteralExpression(value) : !ts.isArrayLiteralExpression(value))) {
    throw new Error(`Unexpected JSONC shape; refusing to change ${file}`);
  }
  const entries = kind === 'settings' ? value.properties : value.elements;
  const selected = entries.map(entry => {
    if (kind === 'settings') return ts.isPropertyAssignment(entry) && ownedSetting(entry.name.text || '');
    if (!ts.isObjectLiteralExpression(entry)) return false;
    return entry.properties.some(property => ts.isPropertyAssignment(property)
      && property.name.text === 'command' && ts.isStringLiteral(property.initializer) && ownedCommand(property.initializer.text));
  });
  const ranges = [];
  for (let index = 0; index < entries.length; index++) {
    if (!selected[index]) continue;
    const start = index;
    while (index + 1 < entries.length && selected[index + 1]) index++;
    if (index + 1 < entries.length) ranges.push([entries[start].getStart(source), entries[index + 1].getStart(source)]);
    else if (start > 0) ranges.push([entries[start - 1].end, entries[index].end]);
    else ranges.push([entries[start].getStart(source), value.end - 1]);
  }
  let result = text;
  for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(end);
  if (ts.parseJsonText(file, result).parseDiagnostics.length) throw new Error(`Reset produced invalid JSONC: ${file}`);
  return result;
}

async function assertNoSymlinks(target) {
  let current = path.resolve(target);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function planReset({ userDataDirectory = defaultUserDataDirectory(), dataRoot = nativeRoot(), workspaceSettings = [] } = {}) {
  const user = path.join(path.resolve(userDataDirectory), 'User');
  const roots = [user];
  const profileRoot = path.join(user, 'profiles');
  await assertNoSymlinks(profileRoot);
  try {
    for (const entry of await fs.readdir(profileRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(profileRoot, entry.name));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const removals = [path.resolve(dataRoot), ...roots.flatMap(root => EXTENSION_IDS.map(id => path.join(root, 'globalStorage', id)))];
  const settings = [...roots.map(root => path.join(root, 'settings.json')), ...workspaceSettings.map(file => path.resolve(file))];
  const candidates = [...settings.map(file => ({ file, kind: 'settings' })),
    ...roots.map(root => ({ file: path.join(root, 'keybindings.json'), kind: 'keybindings' }))];
  const updates = [];
  for (const item of candidates) {
    await assertNoSymlinks(item.file);
    let before;
    try { before = await fs.readFile(item.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const after = removeEntries(before, item.file, item.kind);
    if (after !== before) updates.push({ file: item.file, before, after });
  }
  const directories = [];
  for (const directory of new Set(removals)) {
    await assertNoSymlinks(directory);
    try { if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`Expected data directory: ${directory}`); directories.push(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { directories, updates };
}

async function applyReset(plan) {
  // Validate every target and original setting before the first mutation.
  for (const target of [...plan.directories, ...plan.updates.map(item => item.file)]) await assertNoSymlinks(target);
  for (const item of plan.updates) {
    if (await fs.readFile(item.file, 'utf8') !== item.before) throw new Error(`Settings changed during reset: ${item.file}`);
  }
  for (const item of plan.updates) {
    const temporary = path.join(path.dirname(item.file), `.${NAMESPACE}-reset-${crypto.randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, item.after, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, item.file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  for (const directory of plan.directories) await fs.rm(directory, { recursive: true, force: true });
}

async function main(args) {
  let apply = false, userDataDirectory, dataRoot;
  const workspaceSettings = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--user-data-dir' || arg === '--workspace-settings') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if (arg === '--user-data-dir') userDataDirectory = value; else workspaceSettings.push(value);
    } else if (arg === '--help') {
      console.log('Close VS Code first. node scripts/reset-keepseek-data.cjs [--dry-run|--apply] [--user-data-dir PATH] [--workspace-settings PATH]');
      return;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  const plan = await planReset({ userDataDirectory, dataRoot, workspaceSettings });
  for (const directory of plan.directories) console.log(`Remove data: ${directory}`);
  for (const item of plan.updates) console.log(`Remove KeepSeek entries: ${item.file}`);
  if (apply) { await applyReset(plan); console.log('KeepSeek data and scoped settings reset.'); }
  else console.log('Dry run only. Close VS Code, then add --apply to execute.');
  console.log('Shared VS Code state databases and OS keychains are untouched. The new extension identity never reads old secrets or mementos.');
}

module.exports = { nativeRoot, removeEntries, planReset, applyReset };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
