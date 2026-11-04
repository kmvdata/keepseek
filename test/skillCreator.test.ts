import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { SkillCreator } from '../src/skills/skillCreator';
import { parseSkillFrontmatter, parseSkillMetadata } from '../src/skills/skillMetadata';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { createEmptySession } from '../src/sessions/chatSessionStore';
import { loadSharedCodexConfig } from '../src/context/sharedCodexConfig';
import { SkillDiscovery } from '../src/skills/skillDiscovery';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';

test('concurrent Create Skill clicks produce one grouped proposal before any file write', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-create-clicks-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root), name: 'project', index: 0 }], isTrusted: true });
  const session = createEmptySession('en'); let count = 0;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    skillCreator: new SkillCreator(), language: 'en',
    sessionStore: { activeSessionId: session.id, getActiveSession: () => session, persist: async () => undefined },
    changeSets: { toWebviewState: () => [], addDraftEdits: (input: { edits: unknown[] }) => { count++; assert.equal(input.edits.length, 2); } },
    appendChangeSetTimelineMessage: () => ({ id: 'timeline' }), postState: () => undefined, postToWebview: () => undefined,
    t: (key: string) => key
  }) as { createSkillDraft(message: { type: 'createSkillDraft'; name: string; description: string; allowImplicit: boolean }): Promise<void> };
  const message = { type: 'createSkillDraft' as const, name: 'shared', description: 'Shared workflow', allowImplicit: false };
  await Promise.all([host.createSkillDraft(message), host.createSkillDraft(message)]);
  assert.equal(count, 1); await assert.rejects(readFile(path.join(root, '.agents/skills/shared/SKILL.md')));
});

for (const scenario of ['apply', 'conflict', 'discard', 'cancel'] as const) {
  test(`standard Skill creation groups both files; ${scenario} preserves existing Apply guarantees`, async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-create-shared-skill-')));
    const folder = { uri: vscode.Uri.file(root), name: 'project', index: 0 };
    Object.assign(vscode.workspace, { workspaceFolders: [folder], isTrusted: true });
    const session = createEmptySession('en');
    session.messages.push({ id: 'skill-dialog', role: 'assistant', content: 'Skill draft prepared', createdAt: new Date().toISOString(),
      contextMeta: { isProtected: true, protectedReason: 'draft_edit_result' } });
    const store = new ChangeSetStore(new SafeFileEditor(), { openDiff: async () => undefined } as never,
      { activeSessionId: session.id, getActiveSession: () => session, persist: async () => undefined } as never,
      vscode.Uri.file(path.join(root, 'storage')), key => key);
    t.after(async () => { await store.flush(); await rm(root, { recursive: true, force: true }); });
    const draft = new SkillCreator().createDraft({ workspaceFolder: folder, rawName: 'shared-review',
      description: 'Review: "quoted"\n中文说明', allowImplicit: false, language: 'en' });
    assert.equal(parseSkillFrontmatter(draft.content).description, 'Review: "quoted"\n中文说明');
    assert.equal(parseSkillMetadata(draft.files[1].content).allowImplicit, false);
    assert.doesNotMatch(draft.content, /keepseek|DraftEdit|userInvocable|allowImplicit/u);
    await assert.rejects(readFile(draft.targetUri.fsPath));
    const set = store.addDraftEdits({ sessionId: session.id, messageId: 'skill-dialog', edits: draft.files.map((file, i) => createFullTextDraftEdit({
      id: `skill-${i}`, uri: file.targetUri.toString(), label: file.label, action: 'create', content: file.content, reason: draft.reason
    })) })!;
    assert.equal(set.fileCount, 2);
    if (scenario === 'discard') {
      await store.discardAll(set.id); await assert.rejects(readFile(draft.targetUri.fsPath)); return;
    }
    if (scenario === 'conflict') {
      await mkdir(path.dirname(draft.files[1].targetUri.fsPath), { recursive: true });
      await writeFile(draft.files[1].targetUri.fsPath, 'USER CONTENT');
      const result = await store.applyAll(set.id);
      assert.ok(result?.failed.length); assert.equal(await readFile(draft.files[1].targetUri.fsPath, 'utf8'), 'USER CONTENT'); return;
    }
    if (scenario === 'cancel') {
      const result = await store.applyAll(set.id, { approvalForEdit: () => { throw new Error('Cancelled'); } });
      assert.equal(result?.appliedEditIds.length, 0); await assert.rejects(readFile(draft.targetUri.fsPath)); return;
    }
    const result = await store.applyAll(set.id); assert.equal(result?.appliedEditIds.length, 2);
    const second = await store.applyAll(set.id); assert.equal(second?.appliedEditIds.length ?? 0, 0);
    assert.equal(await readFile(draft.targetUri.fsPath, 'utf8'), draft.content);
    const config = await loadSharedCodexConfig({ folders: [folder], trusted: true, codexHome: vscode.Uri.file(path.join(root, 'empty-home')) });
    const [manifest] = await new SkillDiscovery({ includeUserSkills: false, includeAdminSkills: false }).discover(config);
    assert.equal(manifest.name, 'shared-review'); assert.equal(manifest.allowImplicit, false); assert.equal(manifest.enabled, true);
  });
}
