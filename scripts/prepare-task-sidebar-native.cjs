/* Offline native QA only. Creates a fresh project/profile under the OS temp
 * directory, never opens a transport or touches a user's sessions/settings.
 * Run after `bun run build:test`; open the printed workspace and press F5. */
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');

async function main() {
  const repository = resolve(__dirname, '..');
  require(join(repository, 'out-test/test/registerVscodeStub.js'));
  const vscode = require(join(repository, 'out-test/test/stubs/vscode.js'));
  const { GlobalSessionStorage } = require(join(repository, 'out-test/src/sessions/globalSessionStorage.js'));
  const { ChatSessionStore } = require(join(repository, 'out-test/src/sessions/chatSessionStore.js'));
  const { ProjectExecutionOwner } = require(join(repository, 'out-test/src/tasks/projectOwner.js'));
  const { taskUsageLaneFingerprint, taskUsageFingerprint } = require(join(repository, 'out-test/src/tasks/taskUsageSnapshot.js'));
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-sidebar-native-'));
  const project = join(directory, 'project');
  const driver = join(directory, 'driver');
  const profile = join(directory, 'profile');
  const storagePath = join(profile, 'User', 'globalStorage', 'keepseek.keepseek');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(driver, { recursive: true }), mkdir(storagePath, { recursive: true })]);
  await writeFile(join(project, 'example.txt'), 'Offline sidebar QA fixture. No model credentials or execution queue.\n');
  const projectUri = vscode.Uri.file(project);
  vscode.workspace.workspaceFolders = [{ uri: projectUri, name: 'Sidebar QA' }];
  const owner = await ProjectExecutionOwner.acquire({ projectUri });
  if (!owner.isOwner) throw new Error(owner.reason);
  try {
    const projectId = owner.projectId;
    const base = join(storagePath, 'project-assistant', projectId);
    await mkdir(base, { recursive: true });
    const storage = new GlobalSessionStorage(vscode.Uri.file(storagePath));
    const store = new ChatSessionStore(storage, 'zh-CN', { key: `project:${projectId}`, name: 'KeepSeek', folderUris: [projectUri.toString()] });
    await store.initialize();
    const cards = [], snapshots = [];
    const now = Date.now();
    const specs = [
      ['completed', 'A · 已完成，保留25%上下文', 25, 32000],
      ['failed', 'B · 失败，独立64K窗口', 62.5, 64000],
      ['interrupted', 'C · 中断待继续，暂无统计', null, 32000],
      ['cancelled', 'D · 已停止，真实0%上下文', 0, 128000],
      ['completed', 'E · 超过24小时，仅全部任务可见', 18, 64000],
      ...Array.from({ length: 15 }, (_, index) => ['completed', `滚动任务 ${index + 1} · 测试长标题与稳定位置`, index * 5, 32000])
    ];
    for (const [index, [state, title, percent, max]] of specs.entries()) {
      const createdAt = new Date(now - (index === 4 ? 26 * 3600000 : (60 - index) * 60000)).toISOString();
      const lastActivityAt = new Date(now - (index === 4 ? 25 * 3600000 : 5 * 60000)).toISOString();
      const sessionId = randomUUID(), taskCardId = randomUUID(), rootTaskId = randomUUID(), segmentId = randomUUID();
      const snapshot = { modelId: `offline-${max}`, protocol: 'openai-compatible', endpoint: 'https://offline.invalid/v1',
        rootUri: projectUri.toString(), cwdUri: projectUri.toString(), approvalMode: 'ask', executionMode: 'normal', skillIds: [] };
      await store.createDetachedSession({ id: sessionId, title, createdAt, updatedAt: lastActivityAt,
        projectScopeUri: projectUri.toString(), messages: [
          { id: randomUUID(), role: 'user', content: `${title}。这是一份本地界面验收数据，不会发送请求。`, createdAt },
          { id: randomUUID(), role: 'assistant', content: '仅用于布局、草稿、焦点和历史查看。状态及用量为预置测试数据；不代表真实执行或验证通过。', createdAt: lastActivityAt }
        ] });
      const card = { version: 1, projectId, taskCardId, sessionId, rootTaskId, segmentId, generation: 1, revision: 1,
        title, snapshot, state, sessionCreated: true, associationRequestId: randomUUID(), dependencies: [], inputIds: [],
        createdAt, updatedAt: lastActivityAt, firstSubmittedAt: createdAt, firstSubmittedAtSource: 'user_input',
        lastActivityAt, archived: false, usedMs: 12345 + index * 1000, costByCurrency: index === 2 ? {} : { USD: index * 0.001 }, usageIncomplete: index === 2 };
      cards.push(card);
      if (percent !== null) snapshots.push({ version: 1,
        identity: { projectId, taskCardId, sessionId, rootTaskId, segmentId, generation: 1, hostId: 'offline-fixture', runtimeId: 'offline-worker-' + index },
        laneFingerprint: taskUsageFingerprint({ modelId: snapshot.modelId, context: max }), configurationFingerprint: taskUsageLaneFingerprint(snapshot),
        projectionRevision: 1, capturedAt: lastActivityAt, sequence: 1, recordedAt: lastActivityAt,
        usage: { usedTokensEstimate: percent * max / 100, maxTokensEstimate: max, usedPercent: percent }, status: 'last_known' });
    }
    await storage.flush();
    await writeFile(join(base, 'project-tasks.json'), JSON.stringify({ version: 1, projectId, revision: 1, cards, inputs: [], events: [] }));
    await writeFile(join(base, 'task-context-usage.json'), JSON.stringify({ version: 1, projectId, snapshots }));
    const workspace = join(directory, 'Task_Sidebar_QA.code-workspace');
    await writeFile(workspace, JSON.stringify({ folders: [{ path: driver }],
      launch: { version: '0.2.0', configurations: [{ name: 'Offline KeepSeek sidebar QA', type: 'extensionHost', request: 'launch',
        args: [`--extensionDevelopmentPath=${repository}`, `--user-data-dir=${profile}`, `--extensions-dir=${join(directory, 'extensions')}`, project],
        outFiles: [`${repository}/out/**/*.js`] }] } }, null, 2));
    const args = ['--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${join(directory, 'extensions')}`,
      `--extensionDevelopmentPath=${repository}`, project];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    console.log(JSON.stringify({ workspace, project, profile, storagePath, projectId, cards: cards.length,
      launchCommand: (process.platform === 'win32' ? 'code ' : 'env -u VSCODE_IPC_HOOK_CLI code ') + args.map(quote).join(' '),
      instructions: 'Use launchCommand for a fully separate VS Code instance, then KeepSeek: Open Chat. F5 workspace is an alternative; verify the debugger honors profile flags. Do not Continue/submit display fixtures.' }, null, 2));
  } finally { await owner.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
