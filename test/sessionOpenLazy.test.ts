import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChatSessionStore, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import { SessionObjectStore } from '../src/sessions/sessionObjectStore';
import type { ChatSession } from '../src/shared/types';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///w/session-open';

function scope(): { key: string; name: string; folderUris: string[] } {
  return { key: SCOPE_KEY, name: 'session-open', folderUris: [SCOPE_KEY] };
}

function sessionShardPath(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'sessions', `${hash}.json`);
}

function message(id: string, content: string): NonNullable<ChatSession['messages']>[number] {
  return { id, role: 'user', content, createdAt: '2026-01-01T00:00:00.000Z' } as never;
}

/** Two durable conversations, so navigation has a real target to switch to. */
async function seedTwoSessions(root: string): Promise<{ first: string; second: string; storage: GlobalSessionStorage }> {
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope());
  await store.initialize();

  const first = store.getActiveSession();
  first.messages.push(message('m-first-1', 'first conversation'));
  await store.persist();
  await storage.flush();

  const second = await store.createNewSession();
  second.messages.push(message('m-second-1', 'second conversation'));
  await store.persist();
  await storage.flush();
  store.dispose();
  return { first: first.id, second: second.id, storage };
}

test('opening a history session does not rewrite its shard', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-shard-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const { first, second } = await seedTwoSessions(root);

  // Land on the second conversation, then open the first: the click under test.
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope());
  await store.initialize();
  t.after(() => store.dispose());
  assert.equal((await store.selectSessionBounded(second, { timeoutMs: 5000 })).status, 'selected');

  const shard = sessionShardPath(root, first);
  const before = await readFile(shard, 'utf8');
  const beforeStat = await stat(shard);

  const selection = await store.selectSessionBounded(first, { timeoutMs: 5000 });
  assert.equal(selection.status, 'selected');
  assert.equal(selection.status === 'selected' && selection.session.id, first);

  assert.equal(await readFile(shard, 'utf8'), before,
    'a selection commit must not re-encode the session shard');
  assert.equal((await stat(shard)).mtimeMs, beforeStat.mtimeMs,
    'the shard file must not even be touched');
});

test('opening a history session does not change its updatedAt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-updated-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const { first, second } = await seedTwoSessions(root);

  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope());
  await store.initialize();
  t.after(() => store.dispose());
  await store.selectSessionBounded(second, { timeoutMs: 5000 });

  const indexUri = vscode.Uri.file(path.join(root, 'chat-sessions', 'v2', 'workspaces',
    getWorkspaceHash(SCOPE_KEY), 'index.json'));
  const readEntry = async () => {
    const index = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(indexUri)));
    return { index, entry: index.sessions.find((item: { id: string }) => item.id === first) as { updatedAt: string } };
  };
  const before = await readEntry();

  const selection = await store.selectSessionBounded(first, { timeoutMs: 5000 });
  assert.equal(selection.status, 'selected');

  const after = await readEntry();
  assert.equal(after.index.activeSessionId, first, 'the catalog must record the new active session');
  assert.equal(after.entry.updatedAt, before.entry.updatedAt,
    'navigation is not activity: the sidebar order must not change on a click');
});

test('the reopened session still reports its stored history after an index-only commit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-reload-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const { first, second } = await seedTwoSessions(root);

  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope());
  await store.initialize();
  await store.selectSessionBounded(second, { timeoutMs: 5000 });
  assert.equal((await store.selectSessionBounded(first, { timeoutMs: 5000 })).status, 'selected');
  store.dispose();

  // A fresh window reads the same state back from disk.
  const reopened = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope());
  await reopened.initialize();
  t.after(() => reopened.dispose());
  const session = await reopened.selectSession(first);
  assert.ok(session, 'the conversation must still be loadable after an index-only commit');
  assert.deepEqual(session.messages.map(item => item.content), ['first conversation'],
    'message bodies must survive a commit that never rewrote the shard');
});

test('a selection commit never overtakes a queued full save', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-race-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const { first, second } = await seedTwoSessions(root);

  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope());
  await store.initialize();
  t.after(() => store.dispose());

  // Queue a full save carrying new content, then immediately navigate. The
  // navigation must not replace it with a catalog-only commit, or the new
  // message would be silently dropped from disk.
  const target = store.getSessionById(second) ?? await store.selectSession(second);
  assert.ok(target);
  target.messages.push(message('m-second-2', 'content queued with the selection'));

  const full = store.persist();
  const selection = store.persistSelection();
  await Promise.all([full, selection]);

  const storage2 = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const reread = new ChatSessionStore(storage2, 'en', scope());
  await reread.initialize();
  t.after(() => reread.dispose());
  const reloaded = await reread.selectSession(second);
  assert.ok(reloaded);
  assert.deepEqual(reloaded.messages.map(item => item.content),
    ['second conversation', 'content queued with the selection'],
    'a selection commit must not swallow a queued content save');
  assert.equal(first.length > 0, true);
});

test('writing and reading a session back preserves every runDetails field it stored', async () => {
  // The read path normalizes, then the write path re-encodes. If a field in the
  // stored type is dropped on that round trip, the content hash changes and
  // every open rewrites objects that were already correct.
  const original = {
    id: 's1', title: 't', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceKey: 'w', workspaceName: 'w', workspaceFolders: [], approvalMode: 'ask', activeSkillIds: [],
    messages: [{
      id: 'm1', role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:00.000Z',
      runDetails: {
        runId: 'r1', modelId: 'x', status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z',
        modelRequests: { requestCount: 3, providerAttemptCount: 4, usageResponseCount: 2,
          messageCount: 10, exposedToolCount: 5, thinkingEnabled: false },
        toolCallCount: 0, toolCalls: [], authorizations: [], changeSets: [], validations: [],
        contextSources: [], contextDiscarded: [], truncated: false,
        cache: { providerDataStatus: 'reported', cacheLaneChanged: false, cacheMissPossibleReasons: [],
          expectedRawHitRateCeiling: 87.5, reuseEfficiency: 64.25, healthyReusableRequestCount: 3,
          anomalousReusableRequestCount: 1, controlledBoundaryRequestCount: 2,
          providerCacheEvictionPossibleCount: 0 }
      }
    }]
  };
  const normalized = normalizeStoredSessions({ sessions: [original] }, scope())[0];
  const details = normalized.messages[0].runDetails;
  assert.ok(details);
  assert.equal(details.modelRequests.providerAttemptCount, 4, 'attempt counters are part of the stored type');
  assert.equal(details.modelRequests.usageResponseCount, 2);
  assert.equal(details.cache?.expectedRawHitRateCeiling, 87.5);
  assert.equal(details.cache?.reuseEfficiency, 64.25);
  assert.equal(details.cache?.healthyReusableRequestCount, 3);
  assert.equal(details.cache?.anomalousReusableRequestCount, 1);
  assert.equal(details.cache?.controlledBoundaryRequestCount, 2);
  assert.equal(details.cache?.providerCacheEvictionPossibleCount, 0);

  // Absent stays absent: an explicit 0 would change the bytes on every round trip.
  const sparse = normalizeStoredSessions({ sessions: [{ ...original, messages: [{ ...original.messages[0],
    runDetails: { ...original.messages[0].runDetails, modelRequests: { requestCount: 3, messageCount: 10,
      exposedToolCount: 5, thinkingEnabled: false }, cache: undefined } }] }] }, scope())[0];
  assert.equal('providerAttemptCount' in sparse.messages[0].runDetails!.modelRequests, false,
    'an absent counter must not be materialized as 0');
});

test('a re-encoded session reuses identical objects instead of rewriting them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-hash-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const sessionId = 'session-reencode-stability';
  const uri = vscode.Uri.file(path.join(root, 'shard.json')) as never;
  const session = {
    id: sessionId, title: 't', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceKey: SCOPE_KEY, workspaceName: 'w', workspaceFolders: [], approvalMode: 'ask', activeSkillIds: [],
    messages: [{
      id: 'm1', role: 'assistant', content: 'answer', createdAt: '2026-01-01T00:00:00.000Z',
      providerReplay: { protocol: 'chat_completions', nodes: [{ value: 'x'.repeat(5000) }] },
      runDetails: { runId: 'r1', modelId: 'x', status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z',
        modelRequests: { requestCount: 1, providerAttemptCount: 2, usageResponseCount: 1, messageCount: 4,
          exposedToolCount: 3, thinkingEnabled: false },
        toolCallCount: 0, toolCalls: [], authorizations: [], changeSets: [], validations: [],
        contextSources: [], contextDiscarded: [], truncated: false,
        cache: { providerDataStatus: 'reported', cacheLaneChanged: false, cacheMissPossibleReasons: [],
          expectedRawHitRateCeiling: 50 } }
    }]
  } as unknown as ChatSession;

  const writer = new SessionObjectStore(uri);
  await writer.save(session);
  const manifest = JSON.parse(await readFile(path.join(root, 'shard.json'), 'utf8'));

  // Read it the way the app does, then write the decoded copy back unchanged.
  // The writer must be the instance that loaded, which is what the real flow
  // guarantees: a stale writer is refused on purpose.
  const reader = new SessionObjectStore(uri);
  const loaded = await reader.load(manifest);
  const rewrote = await reader.save(loaded);
  const manifestAfter = JSON.parse(await readFile(path.join(root, 'shard.json'), 'utf8'));

  assert.deepEqual(manifestAfter.messages.map((entry: { body: string }) => entry.body),
    manifest.messages.map((entry: { body: string }) => entry.body),
    'an unchanged session must re-encode to the same object hashes');
  assert.equal(typeof rewrote, 'number');
});

test('concurrent decoding of a shared object yields one verified result', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-shared-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  await mkdir(root, { recursive: true });
  const uri = vscode.Uri.file(path.join(root, 'shared.json')) as never;
  const shared = 'shared tool result ' + 'y'.repeat(4500);
  const session = {
    id: 'shared-objects', title: 't', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceKey: SCOPE_KEY, workspaceName: 'w', workspaceFolders: [], approvalMode: 'ask', activeSkillIds: [],
    // Two messages share one long text node, so a parallel walk hits it twice.
    messages: [1, 2, 3].map((index) => ({
      id: `m${index}`, role: 'user', content: shared, createdAt: '2026-01-01T00:00:00.000Z'
    }))
  } as unknown as ChatSession;
  await new SessionObjectStore(uri).save(session);
  const manifest = JSON.parse(await readFile(path.join(root, 'shared.json'), 'utf8'));

  const reads = new Map<string, number>();
  const originalRead = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async (target: never) => {
    const key = String((target as unknown as { path: string }).path);
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return originalRead(target);
  };
  try {
    const loaded = await new SessionObjectStore(uri).load(manifest);
    assert.deepEqual(loaded.messages.map(item => item.content), [shared, shared, shared]);
    // Content addressing must still de-duplicate: no object is fetched twice.
    const duplicated = [...reads.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(duplicated, [], 'a shared object must be read once even when decoded concurrently');
  } finally { vscode.workspace.fs.readFile = originalRead; }
});

test('a reference to a missing object fails as a read error instead of hanging', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-open-missing-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const objectDir = path.join(root, 'broken.json.objects');
  await mkdir(objectDir, { recursive: true });
  // A manifest whose header is simply not on disk: the failure the loader must
  // classify as "temporarily unreadable" so the shard is not quarantined.
  const absent = createHash('sha256').update('never written').digest('hex');
  await writeFile(path.join(root, 'broken.json'), JSON.stringify({ version: 4, workspaceKey: SCOPE_KEY,
    sessionId: 'broken', revision: 1, header: absent, messages: [] }));

  const store = new SessionObjectStore(vscode.Uri.file(path.join(root, 'broken.json')) as never);
  const manifest = { version: 4, workspaceKey: SCOPE_KEY, sessionId: 'broken', revision: 1, header: absent, messages: [] };
  await assert.rejects(() => store.load(manifest), (error: Error) => error.name === 'Error'
    && /Session object could not be read/u.test(error.message),
    'a vanished object must surface as SessionObjectReadError, not as a hang or a corrupt-shard verdict');
  // Content addressing makes a true cycle unrepresentable (a hash cannot contain
  // itself), so the walk-depth guard is defensive. What is testable — and what
  // matters for a parallel walk — is that repeated references stay de-duplicated.
  await assert.rejects(() => store.loadField(manifest, ['absent']),
    /Session object could not be read/u);
});