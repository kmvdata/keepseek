import * as vscode from 'vscode';
import {
  getConfiguredValidationTimeoutMs
} from '../../shared/config';
import type { KeepseekLanguage } from '../../shared/i18n';
import type {
  SafeNpmScript,
  ToolAuthorizationDecision,
  ValidationToolResult,
  WorkspaceDiagnosticItem,
  WorkspaceDiagnosticSummary
} from '../../shared/types';
import { RUN_VALIDATION_TOOL_NAME } from '../protocol';

const MAX_DIAGNOSTIC_ITEMS = 200;
const SAFE_NPM_SCRIPT_ORDER: SafeNpmScript[] = ['compile', 'lint', 'test'];
const SAFE_NPM_SCRIPTS = new Set<SafeNpmScript>(SAFE_NPM_SCRIPT_ORDER);
const HIGH_RISK_SCRIPT_PATTERN = /(?:\b(?:npm|pnpm|yarn)\s+(?:install|add|publish|deploy)\b|\bgit\s+push\b|\brm\s+(?:-[^\s]+\s+)*|\b(?:curl|wget)\b|\b(?:deploy|publish)\b)/iu;

export interface ValidationToolAdapter {
  readWorkspaceDiagnostics(language: KeepseekLanguage): Promise<string>;
  runSafeNpmScript(input: {
    script: SafeNpmScript;
    workspaceFolder?: string;
    language: KeepseekLanguage;
    signal?: AbortSignal;
    runDeadlineAt?: number;
    authorization: ToolAuthorizationDecision;
  }): Promise<string>;
}

export class ValidationToolService implements ValidationToolAdapter {
  public async readWorkspaceDiagnostics(_language: KeepseekLanguage): Promise<string> {
    return JSON.stringify(createWorkspaceDiagnosticSummary());
  }

  public async runSafeNpmScript(input: {
    script: SafeNpmScript;
    workspaceFolder?: string;
    language: KeepseekLanguage;
    signal?: AbortSignal;
    runDeadlineAt?: number;
    authorization: ToolAuthorizationDecision;
  }): Promise<string> {
    const startedAt = Date.now();
    const createResult = (result: Partial<ValidationToolResult>): ValidationToolResult => ({
      ok: false,
      kind: 'npm_script',
      script: input.script,
      authorized: false,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      authorization: input.authorization,
      ...result
    });

    if (!SAFE_NPM_SCRIPTS.has(input.script)) {
      return JSON.stringify(createResult({
        error: localizeValidation(input.language, 'unsupportedScript', input.script)
      }));
    }
    if (!vscode.workspace.isTrusted) {
      return JSON.stringify(createResult({
        error: localizeValidation(input.language, 'untrusted')
      }));
    }
    if (input.signal?.aborted) {
      return JSON.stringify(createResult({
        error: localizeValidation(input.language, 'stopped')
      }));
    }

    const workspaceFolder = findWorkspaceFolder(input.workspaceFolder);
    if (!workspaceFolder) {
      return JSON.stringify(createResult({
        error: localizeValidation(input.language, 'workspaceMissing')
      }));
    }

    const scriptDefinition = await readNpmScript(workspaceFolder, input.script);
    if (!scriptDefinition) {
      return JSON.stringify(createResult({
        workspaceFolder: workspaceFolder.name,
        error: localizeValidation(input.language, 'scriptMissing', input.script)
      }));
    }
    if (HIGH_RISK_SCRIPT_PATTERN.test(scriptDefinition)) {
      return JSON.stringify(createResult({
        workspaceFolder: workspaceFolder.name,
        error: localizeValidation(input.language, 'scriptUnsafe', input.script)
      }));
    }

    const expectedScope = input.script === 'test' ? 'validation_test' : 'validation_compile_lint';
    if (!input.authorization.allowed
      || input.authorization.toolName !== RUN_VALIDATION_TOOL_NAME
      || input.authorization.riskLevel !== 'medium'
      || input.authorization.scope !== expectedScope) {
      return JSON.stringify(createResult({
        workspaceFolder: workspaceFolder.name,
        authorization: input.authorization,
        error: localizeValidation(input.language, 'notAuthorized')
      }));
    }

    const configuredTimeoutMs = getConfiguredValidationTimeoutMs();
    const deadlineTimeoutMs = typeof input.runDeadlineAt === 'number'
      ? Math.max(0, input.runDeadlineAt - Date.now())
      : configuredTimeoutMs;
    const timeoutMs = Math.min(configuredTimeoutMs, deadlineTimeoutMs);
    if (timeoutMs <= 0) {
      return JSON.stringify(createResult({
        workspaceFolder: workspaceFolder.name,
        authorized: true,
        timedOut: true,
        error: localizeValidation(input.language, 'timedOut')
      }));
    }

    const task = createValidationTask(workspaceFolder, input.script);
    try {
      const outcome = await executeTaskAndWait(task, timeoutMs, input.signal);
      const diagnostics = createWorkspaceDiagnosticSummary();
      const ok = !outcome.timedOut && !outcome.aborted && outcome.exitCode === 0;
      return JSON.stringify(createResult({
        ok,
        workspaceFolder: workspaceFolder.name,
        taskName: task.name,
        authorized: true,
        exitCode: outcome.exitCode,
        durationMs: Date.now() - startedAt,
        timedOut: outcome.timedOut,
        diagnostics,
        error: ok
          ? undefined
          : outcome.aborted
            ? localizeValidation(input.language, 'stopped')
            : outcome.timedOut
              ? localizeValidation(input.language, 'timedOut')
              : localizeValidation(input.language, 'failed', input.script, outcome.exitCode)
      }));
    } catch (error) {
      return JSON.stringify(createResult({
        workspaceFolder: workspaceFolder.name,
        authorized: true,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }
}

export async function getAvailableSafeValidationScripts(): Promise<SafeNpmScript[]> {
  if (!vscode.workspace.isTrusted) {
    return [];
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }
  const definitions = await Promise.all(SAFE_NPM_SCRIPT_ORDER.map(async (script) => ({
    script,
    definition: await readNpmScript(workspaceFolder, script)
  })));
  return definitions
    .filter((entry): entry is { script: SafeNpmScript; definition: string } =>
      typeof entry.definition === 'string' && !HIGH_RISK_SCRIPT_PATTERN.test(entry.definition)
    )
    .map(({ script }) => script);
}

function createWorkspaceDiagnosticSummary(): WorkspaceDiagnosticSummary {
  const items: WorkspaceDiagnosticItem[] = [];
  const counts = {
    errors: 0,
    warnings: 0,
    information: 0,
    hints: 0
  };
  let total = 0;

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      continue;
    }
    for (const diagnostic of diagnostics) {
      total += 1;
      const severity = getDiagnosticSeverity(diagnostic.severity);
      counts[severity === 'error'
        ? 'errors'
        : severity === 'warning'
          ? 'warnings'
          : severity === 'information'
            ? 'information'
            : 'hints'] += 1;
      if (items.length >= MAX_DIAGNOSTIC_ITEMS) {
        continue;
      }
      items.push({
        uri: uri.toString(),
        path: vscode.workspace.asRelativePath(uri, false),
        severity,
        message: compactText(diagnostic.message, 800),
        source: diagnostic.source,
        code: getDiagnosticCode(diagnostic.code),
        startLine: diagnostic.range.start.line + 1,
        startColumn: diagnostic.range.start.character + 1,
        endLine: diagnostic.range.end.line + 1,
        endColumn: diagnostic.range.end.character + 1
      });
    }
  }

  return {
    ok: true,
    total,
    ...counts,
    truncated: total > items.length,
    items
  };
}

function getDiagnosticSeverity(severity: vscode.DiagnosticSeverity): WorkspaceDiagnosticItem['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    default:
      return 'hint';
  }
}

function getDiagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }
  return code && (typeof code.value === 'string' || typeof code.value === 'number')
    ? String(code.value)
    : undefined;
}

function findWorkspaceFolder(requested: string | undefined): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const target = requested?.trim();
  if (!target) {
    return folders[0];
  }
  return folders.find((folder) =>
    folder.name === target
    || folder.uri.fsPath === target
    || folder.uri.toString() === target
  );
}

async function readNpmScript(workspaceFolder: vscode.WorkspaceFolder, script: SafeNpmScript): Promise<string | undefined> {
  try {
    const packageJsonUri = vscode.Uri.joinPath(workspaceFolder.uri, 'package.json');
    const bytes = await vscode.workspace.fs.readFile(packageJsonUri);
    if (bytes.byteLength > 1_000_000) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      return undefined;
    }
    const value = (scripts as Record<string, unknown>)[script];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function createValidationTask(workspaceFolder: vscode.WorkspaceFolder, script: SafeNpmScript): vscode.Task {
  const problemMatchers = script === 'compile'
    ? ['$tsc']
    : script === 'lint'
      ? ['$eslint-stylish']
      : [];
  const task = new vscode.Task(
    { type: 'keepseek-validation', script },
    workspaceFolder,
    `KeepSeek: npm run ${script}`,
    'keepseek',
    new vscode.ProcessExecution('npm', ['run', script], { cwd: workspaceFolder.uri.fsPath }),
    problemMatchers
  );
  task.presentationOptions = {
    echo: true,
    reveal: vscode.TaskRevealKind.Silent,
    focus: false,
    panel: vscode.TaskPanelKind.Dedicated,
    showReuseMessage: true,
    clear: true,
    close: false
  };
  return task;
}

async function executeTaskAndWait(
  task: vscode.Task,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ exitCode?: number; timedOut: boolean; aborted: boolean }> {
  let execution: vscode.TaskExecution | undefined;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { exitCode?: number; timedOut: boolean; aborted: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      processEndDisposable.dispose();
      taskEndDisposable.dispose();
      signal?.removeEventListener('abort', abortHandler);
      resolve(result);
    };
    const processEndDisposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (execution && event.execution === execution) {
        finish({ exitCode: event.exitCode, timedOut: false, aborted: false });
      }
    });
    const taskEndDisposable = vscode.tasks.onDidEndTask((event) => {
      if (execution && event.execution === execution) {
        finish({ exitCode: undefined, timedOut: false, aborted: false });
      }
    });
    const abortHandler = () => {
      void execution?.terminate();
      finish({ exitCode: undefined, timedOut: false, aborted: true });
    };

    signal?.addEventListener('abort', abortHandler, { once: true });
    const timer = setTimeout(() => {
      void execution?.terminate();
      finish({ exitCode: undefined, timedOut: true, aborted: false });
    }, timeoutMs);

    void vscode.tasks.executeTask(task).then((startedExecution) => {
      execution = startedExecution;
      if (signal?.aborted) {
        abortHandler();
      }
    }, (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        processEndDisposable.dispose();
        taskEndDisposable.dispose();
        signal?.removeEventListener('abort', abortHandler);
        reject(error);
      }
    });
  });
}

function localizeValidation(
  language: KeepseekLanguage,
  key: 'unsupportedScript' | 'untrusted' | 'stopped' | 'workspaceMissing' | 'scriptMissing' | 'scriptUnsafe' | 'notAuthorized' | 'timedOut' | 'failed',
  script?: string,
  exitCode?: number
): string {
  const en: Record<typeof key, string> = {
    unsupportedScript: `Validation script "${script ?? ''}" is not in KeepSeek's fixed allowlist.`,
    untrusted: 'Controlled validation is disabled because the workspace is not trusted.',
    stopped: 'The validation task was stopped.',
    workspaceMissing: 'Open a workspace folder before running validation.',
    scriptMissing: `package.json does not define the safe "${script ?? ''}" script.`,
    scriptUnsafe: `The "${script ?? ''}" script contains a command that KeepSeek does not allow automatically.`,
    notAuthorized: 'The user did not authorize this validation task.',
    timedOut: 'The validation task reached its time limit and was stopped.',
    failed: `The "${script ?? ''}" validation task exited with code ${exitCode ?? 'unknown'}.`
  };
  const zh: Record<typeof key, string> = {
    unsupportedScript: `验证脚本“${script ?? ''}”不在 KeepSeek 的固定允许列表中。`,
    untrusted: '当前工作区未受信任，不能运行受控验证。',
    stopped: '验证任务已停止。',
    workspaceMissing: '请先打开工作区文件夹，再运行验证。',
    scriptMissing: `package.json 未定义安全脚本“${script ?? ''}”。`,
    scriptUnsafe: `脚本“${script ?? ''}”包含 KeepSeek 不允许自动执行的命令。`,
    notAuthorized: '用户未授权本次验证任务。',
    timedOut: '验证任务达到时间上限，已停止。',
    failed: `验证任务“${script ?? ''}”退出，代码为 ${exitCode ?? '未知'}。`
  };
  return (language === 'en' ? en : zh)[key];
}

function compactText(value: string, maxLength: number): string {
  const compacted = String(value || '').replace(/\s+/gu, ' ').trim();
  return compacted.length <= maxLength ? compacted : `${compacted.slice(0, maxLength - 1)}…`;
}
