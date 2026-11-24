import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  classifyObjects, collectRootHashes, expandReachable, parseManifest, walkReferences
} from '../src/sessions/sessionObjectGc';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const H = (seed: string) => digest(seed);

/** An encoded node is what the store actually writes: JSON with refs inline. */
const node = (value: unknown) => JSON.stringify(value);

test('a manifest contributes its header, every message body, and every checkpoint', () => {
  const header = H('header');
  const body1 = H('body1');
  const body2 = H('body2');
  const checkpoint = H('checkpoint');
  const roots = collectRootHashes({
    header,
    messages: [{ body: body1 }, { body: body2, checkpoint }]
  });
  assert.deepEqual([...roots].sort(), [header, body1, body2, checkpoint].sort());
});

test('an inline header exposes its child references', () => {
  const child = H('child');
  const inline = { kind: 'object', entries: [['a', { ref: child }]] };
  const roots = collectRootHashes({ header: digest(JSON.stringify(inline)), headerInline: inline, messages: [] });
  assert.equal(roots.has(child), true, 'a nested ref must be treated as live');
});

test('hash-shaped strings anywhere in the tree are treated as references', () => {
  // Over-approximating the live set can only cost a missed deletion. Missing one
  // reference would delete the only copy of someone's history, so the sweep is
  // deliberately generous about what counts as a reference.
  const deep = H('deep');
  const roots = new Set<string>();
  walkReferences({ a: [{ b: { ref: deep } }], c: 'not-a-hash' }, roots);
  assert.equal(roots.has(deep), true);
  assert.equal(roots.size, 1, 'a non-hash string is not a reference');
});

test('reaching one object discovers the objects it references', async () => {
  // A hash is always the digest of the bytes on disk, so the fixtures must be
  // named by their own content or the integrity check would reject them.
  const leafBody = node({ kind: 'text', text: 'hello' });
  const leaf = digest(leafBody);
  const rootBody = node({ kind: 'array', values: [{ ref: leaf }] });
  const root = digest(rootBody);
  const objects = new Map([[root, rootBody], [leaf, leafBody]]);
  const result = await expandReachable(new Set([root]), async hash => objects.get(hash));
  assert.equal(result.undecidable, undefined);
  assert.deepEqual([...result.live].sort(), [root, leaf].sort());
});

test('a missing referenced object is not fatal: it is an interrupted write', async () => {
  const absent = H('absent');
  const rootBody = node({ kind: 'array', values: [{ ref: absent }] });
  const root = digest(rootBody);
  const objects = new Map([[root, rootBody]]);
  const result = await expandReachable(new Set([root]), async hash => objects.get(hash));
  assert.equal(result.undecidable, undefined, 'a vanished object must not block collection');
  assert.equal(result.live.has(root), true);
});

test('a corrupt object makes the target undecidable instead of collectable', async () => {
  // Its content no longer matches its hash, so the graph beneath it is unknown.
  // Guessing here would delete live objects, so the whole session is skipped.
  const root = H('root');
  const result = await expandReachable(new Set([root]), async () => 'content that does not hash to root');
  assert.match(result.undecidable ?? '', /integrity/u);
});

test('an unreadable object makes the target undecidable', async () => {
  const result = await expandReachable(new Set([H('x')]), async () => { throw new Error('EIO'); });
  assert.match(result.undecidable ?? '', /unreadable/u);
});

test('a manifest is refused when its version, header, or inline hash disagrees', () => {
  assert.match(('error' in parseManifest('not json') ? 'error' : ''), /error/u);
  assert.match(('error' in parseManifest(JSON.stringify({ version: 3 })) ? 'error' : ''), /error/u);
  const badHeader = parseManifest(JSON.stringify({ version: 4, header: 'nope', messages: [] }));
  assert.equal('error' in badHeader, true);
  // An inline header whose serialized form does not hash to `header` means the
  // manifest and its nodes disagree; the live set cannot be trusted.
  const inline = { kind: 'text', text: 'a' };
  const mismatch = parseManifest(JSON.stringify({
    version: 4, header: H('something else'), headerInline: inline, messages: []
  }));
  assert.equal('error' in mismatch, true);
  const ok = parseManifest(JSON.stringify({
    version: 4, header: digest(JSON.stringify(inline)), headerInline: inline, messages: []
  }));
  assert.equal('error' in ok, false);
});

test('classification separates live, orphan and non-object entries', () => {
  const live = H('live');
  const orphan = H('orphan');
  const { orphans, liveCount, unknown } = classifyObjects(
    [`${live}.json`, `${orphan}.json`, 'writer.lock', 'notes.txt'],
    new Set([live])
  );
  assert.deepEqual(orphans, [orphan]);
  assert.equal(liveCount, 1);
  // The writer lock and stray files are counted but never deleted.
  assert.equal(unknown, 2);
});

test('classification never treats a live object as an orphan', () => {
  const live = H('live');
  const { orphans } = classifyObjects([`${live}.json`], new Set([live]));
  assert.deepEqual(orphans, [], 'a referenced object must survive unchanged');
});