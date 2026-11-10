const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { nativeRoot, removeEntries, planReset, applyReset } = require('./reset-keepseek-data.cjs');

test('scoped reset preserves unrelated settings and comments and handles JSONC trailing commas', () => {
  const input = '{\n // Keep this comment\n "editor.fontSize": 14,\n "keepseek.model": "old",\n "kmvdata.keepseek.old": true,\n}';
  const result = removeEntries(input, 'settings.json', 'settings');
  assert.match(result, /Keep this comment/u);
  assert.match(result, /"editor.fontSize": 14/u);
  assert.doesNotMatch(result, /keepseek/u);
  assert.equal(removeEntries('{"keepseek.a": 1,}', 'settings.json', 'settings'), '{}');
  assert.equal(removeEntries('[{"command":"keepseek.openChat"},]', 'keybindings.json', 'keybindings'), '[]');
  assert.throws(() => removeEntries('{broken', 'settings.json', 'settings'), /Invalid JSONC/u);
  assert.equal(nativeRoot('linux', '/home/test', { XDG_DATA_HOME: '/data' }), '/data/com.kmvdata.keepseek');
});

test('offline plan changes nothing until apply and touches only exact extension directories', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reset-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userDataDirectory = path.join(directory, 'Code');
  const user = path.join(userDataDirectory, 'User');
  const storage = path.join(user, 'globalStorage');
  const dataRoot = path.join(directory, 'com.kmvdata.keepseek');
  for (const id of ['keepseek.keepseek', 'kmvdata.keepseek', 'other.extension']) {
    await fs.mkdir(path.join(storage, id), { recursive: true });
    await fs.writeFile(path.join(storage, id, 'data.json'), 'private');
  }
  await fs.mkdir(dataRoot);
  await fs.writeFile(path.join(dataRoot, 'account.json'), 'private');
  await fs.writeFile(path.join(storage, 'state.vscdb'), 'shared database');
  await fs.writeFile(path.join(user, 'settings.json'), '{"editor.fontSize":14,"keepseek.language":"en-US"}');
  const plan = await planReset({ userDataDirectory, dataRoot });
  assert.equal(plan.directories.length, 3);
  assert.equal(await fs.readFile(path.join(dataRoot, 'account.json'), 'utf8'), 'private');
  assert.match(await fs.readFile(path.join(user, 'settings.json'), 'utf8'), /keepseek/u);
  await applyReset(plan);
  await assert.rejects(fs.stat(dataRoot), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(storage, 'keepseek.keepseek')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(storage, 'other.extension', 'data.json'), 'utf8'), 'private');
  assert.equal(await fs.readFile(path.join(storage, 'state.vscdb'), 'utf8'), 'shared database');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(user, 'settings.json'), 'utf8')), { 'editor.fontSize': 14 });
});

test('offline reset refuses symbolic links and malformed configuration before any deletion', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reset-refusal-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userDataDirectory = path.join(directory, 'Code');
  const dataRoot = path.join(directory, 'native');
  await fs.mkdir(path.join(userDataDirectory, 'User'), { recursive: true });
  await fs.mkdir(dataRoot);
  await fs.writeFile(path.join(dataRoot, 'safe'), 'keep');
  const settings = path.join(userDataDirectory, 'User', 'settings.json');
  await fs.writeFile(settings, '{broken');
  await assert.rejects(planReset({ userDataDirectory, dataRoot }), /Invalid JSONC/u);
  assert.equal(await fs.readFile(path.join(dataRoot, 'safe'), 'utf8'), 'keep');
  await fs.writeFile(settings, '{}');
  const link = path.join(directory, 'link');
  await fs.symlink(dataRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planReset({ userDataDirectory, dataRoot: link }), /symbolic link/u);
});
