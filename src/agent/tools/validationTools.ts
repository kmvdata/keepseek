import { redactSensitiveReviewText } from '../../approvals/approvalPolicy';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawnDurablyGated } from '../../runs/durableSpawn';
import { terminateProcessTree } from '../../runs/draftRunExecutor';
import { inspectValidationSnapshot, ValidationUnavailableError, type ValidationSnapshot } from './validationSnapshot';
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
import { hasValidationBlockingRisk } from './validationRisk';
import { assertProjectMutationLease, beginProjectDurableOperation, getProjectExecutionContext, withProjectMutationPhase } from '../../tasks/projectResources';
import type { RecoveryMetadataSummary } from '../../shared/recoveryMetadataInspection';

const MAX_DIAGNOSTIC_ITEMS = 200;
const SAFE_NPM_SCRIPT_ORDER: SafeNpmScript[] = ['compile', 'lint', 'test'];
const SAFE_NPM_SCRIPTS = new Set<SafeNpmScript>(SAFE_NPM_SCRIPT_ORDER);

/** Legacy validation results live inside session checkpoints, not a standalone
 * validation catalog. Explicit diagnostics may inspect the independent owner
 * journal, and must report unavailable instead of reading historical bodies. */
export function inspectValidationRecoveryMetadata(operations: readonly { kind: string; state: string; processState?: string }[], legacyOwner: boolean): RecoveryMetadataSummary {
  const records = operations.filter(operation => operation.kind === 'validation');
  const summary: RecoveryMetadataSummary = { availability: records.length ? 'found' : legacyOwner ? 'unavailable' : 'missing',
    records: records.length, states: {}, unsettled: 0, unknown: 0, filesRead: 0, bytesRead: 0,
    malformedFiles: 0, inaccessibleFiles: 0, truncated: false, scope: 'extension_storage', settlementProof: false };
  for (const record of records) {
    const state = ['intent', 'dispatched', 'completed', 'not_dispatched', 'result_unknown'].includes(record.state) ? record.state : 'unrecognized';
    summary.states[state] = (summary.states[state] ?? 0) + 1;
    if (!['completed', 'not_dispatched'].includes(state) && record.processState !== 'ended') summary.unsettled++;
    if (state === 'result_unknown' || state === 'unrecognized') summary.unknown++;
  }
  return summary;
}

export interface ValidationToolAdapter {
  readWorkspaceDiagnostics(language: KeepseekLanguage): Promise<string>;
  runSafeNpmScript(input: {
    script: SafeNpmScript;
    workspaceFolder?: string;
    language: KeepseekLanguage;
    signal?: AbortSignal;
    runDeadlineAt?: number;
    authorization: ToolAuthorizationDecision;
    expectedSnapshot?: string;
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
    expectedSnapshot?: string;
  }): Promise<string> {
    return withProjectMutationPhase(async (lease) => {
      // Compile/test scripts can write outputs even on failure. Invalidate old
      // validation conclusions conservatively before invoking the fixed script.
      lease?.recordMutation();
      return this.runSafeNpmScriptOwned(input);
    }, input.signal);
  }

  private async runSafeNpmScriptOwned(input: Parameters<ValidationToolService['runSafeNpmScript']>[0]): Promise<string> {
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
        errorType: 'unsupported_script',
        error: localizeValidation(input.language, 'unsupportedScript', input.script)
      }));
    }
    if (!vscode.workspace.isTrusted) {
      return JSON.stringify(createResult({
        errorType: 'untrusted_workspace',
        error: localizeValidation(input.language, 'untrusted')
      }));
    }
    if (input.signal?.aborted) {
      return JSON.stringify(createResult({
        errorType: 'validation_stopped',
        error: localizeValidation(input.language, 'stopped')
      }));
    }

    const workspaceFolder = findWorkspaceFolder(input.workspaceFolder);
    if (!workspaceFolder) {
      return JSON.stringify(createResult({
        errorType: 'workspace_missing',
        error: localizeValidation(input.language, 'workspaceMissing')
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
        errorType: 'authorization_denied',
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
        errorType: 'validation_timeout',
        error: localizeValidation(input.language, 'timedOut')
      }));
    }

    const taskName = `KeepSeek: npm run ${input.script}`;
    try {
      const snapshot = await inspectValidationSnapshot(workspaceFolder, input.script);
      if (!vscode.workspace.isTrusted || input.signal?.aborted || !vscode.workspace.workspaceFolders?.includes(workspaceFolder)
        || (input.expectedSnapshot && input.expectedSnapshot !== snapshot.fingerprint)
        || (input.authorization.approvalReview && !input.expectedSnapshot)) {
        throw new Error(localizeValidation(input.language, 'snapshotChanged'));
      }
      const remainingMs = input.runDeadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, input.runDeadlineAt - Date.now());
      if (remainingMs <= 0) throw new Error(localizeValidation(input.language, 'timedOut'));
      await assertProjectMutationLease();
      if (!vscode.workspace.isTrusted || input.signal?.aborted) throw new Error(localizeValidation(input.language, 'snapshotChanged'));
      const outcome = await executeValidation(snapshot, remainingMs, input.signal);
      const diagnostics = createWorkspaceDiagnosticSummary();
      const ok = !outcome.timedOut && !outcome.aborted && outcome.exitCode === 0;
      const context = getProjectExecutionContext();
      const projectResource = context?.token ? {
        projectId: context.owner.projectId, resourceRevision: context.resources.resourceRevision,
        phaseId: context.token.id, fingerprint: snapshot.fingerprint
      } : undefined;
      return JSON.stringify({ ...createResult({
        ok,
        workspaceFolder: workspaceFolder.name,
        taskName,
        authorized: true,
        exitCode: outcome.exitCode,
        durationMs: Date.now() - startedAt,
        timedOut: outcome.timedOut,
        diagnostics,
        output: outcome.output || undefined,
        errorType: ok
          ? undefined
          : outcome.aborted
            ? 'validation_stopped'
            : outcome.timedOut
              ? 'validation_timeout'
              : 'validation_failed',
        error: ok
          ? undefined
          : outcome.aborted
            ? localizeValidation(input.language, 'stopped')
            : outcome.timedOut
              ? localizeValidation(input.language, 'timedOut')
              : localizeValidation(input.language, 'failed', input.script, outcome.exitCode)
      }), ...(projectResource ? { projectResource } : {}) });
    } catch (error) {
      if (error instanceof ValidationUnavailableError && !input.expectedSnapshot) {
        return JSON.stringify(createResult({
          workspaceFolder: workspaceFolder.name,
          errorType: 'validation_unavailable',
          error: unavailableValidationMessage(input.language, input.script, error)
        }));
      }
      return JSON.stringify(createResult({
        workspaceFolder: workspaceFolder.name,
        authorized: true,
        durationMs: Date.now() - startedAt,
        errorType: 'validation_execution_failed',
        error: error instanceof ValidationUnavailableError
          ? localizeValidation(input.language, 'snapshotChanged')
          : error instanceof Error ? error.message : String(error)
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
  const scripts = await readNpmScripts(workspaceFolder);
  const definitions = SAFE_NPM_SCRIPT_ORDER.map((script) => ({ script, definition: scripts?.[script] }));
  return definitions
    .filter((entry): entry is { script: SafeNpmScript; definition: string } =>
      typeof entry.definition === 'string' && !hasValidationBlockingRisk(entry.definition)
    )
    .map(({ script }) => script);
}

async function readNpmScripts(workspaceFolder: vscode.WorkspaceFolder): Promise<Partial<Record<SafeNpmScript, string>> | undefined> {
  try {
    const packageJsonUri = vscode.Uri.joinPath(workspaceFolder.uri, 'package.json');
    const bytes = await vscode.workspace.fs.readFile(packageJsonUri);
    if (bytes.byteLength > 1_000_000) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).scripts;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: Partial<Record<SafeNpmScript, string>> = {};
    for (const script of SAFE_NPM_SCRIPT_ORDER) {
      const definition = (value as Record<string, unknown>)[script];
      if (typeof definition === 'string' && definition.trim()) result[script] = definition.trim();
    }
    return result;
  } catch {
    return undefined;
  }
}

export type ValidationPreflightResult =
  | { status: 'ready'; script: SafeNpmScript; workspaceRootId: string; snapshot: ValidationSnapshot }
  | { status: 'unavailable'; script: SafeNpmScript; error: string }
  | { status: 'blocked'; error: string };

/** Hard checks that must pass before a validation request reaches a model reviewer. */
export async function preflightSafeValidation(input: {
  script: SafeNpmScript;
  workspaceFolder?: string;
  language: KeepseekLanguage;
}): Promise<ValidationPreflightResult> {
  if (!SAFE_NPM_SCRIPTS.has(input.script)) {
    return { status: 'blocked', error: localizeValidation(input.language, 'unsupportedScript', input.script) };
  }
  if (!vscode.workspace.isTrusted) {
    return { status: 'blocked', error: localizeValidation(input.language, 'untrusted') };
  }
  const workspaceFolder = findWorkspaceFolder(input.workspaceFolder);
  if (!workspaceFolder) {
    return { status: 'blocked', error: localizeValidation(input.language, 'workspaceMissing') };
  }
  try {
    const snapshot = await inspectValidationSnapshot(workspaceFolder, input.script);
    const index = (vscode.workspace.workspaceFolders ?? []).findIndex(folder => folder.uri.toString() === workspaceFolder.uri.toString());
    return { status: 'ready', script: input.script, workspaceRootId: `root-${index + 1}:${workspaceFolder.name}`, snapshot };
  } catch (error) {
    if (error instanceof ValidationUnavailableError) {
      return { status: 'unavailable', script: input.script, error: unavailableValidationMessage(input.language, input.script, error) };
    }
    return { status: 'blocked', error: error instanceof Error ? error.message : String(error) };
  }
}

function unavailableValidationMessage(language: KeepseekLanguage, script: SafeNpmScript, error: ValidationUnavailableError): string {
  return localizeValidation(language, error.reason === 'manifest_missing' ? 'manifestMissing' : 'scriptMissing', script);
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

  for (const [uri, diagnostics] of vscode.languages?.getDiagnostics() ?? []) {
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

async function executeValidation(snapshot: ValidationSnapshot, timeoutMs: number, signal?: AbortSignal):
Promise<{ exitCode?: number; timedOut: boolean; aborted: boolean; output?: string }> {
  if (signal?.aborted) return { timedOut: false, aborted: true };
  const operation = await beginProjectDurableOperation({
    id: `validation-${randomUUID()}`, kind: 'validation', specHash: snapshot.fingerprint,
    resourceScope: snapshot.cwd, gated: true
  });
  let child: ChildProcess;
  let gated: ReturnType<typeof spawnDurablyGated> | undefined;
  try {
    gated = getProjectExecutionContext() ? spawnDurablyGated({
      executable: snapshot.executable, args: snapshot.argv, cwd: snapshot.cwd, env: snapshot.env,
      signal, journal: operation
    }) : undefined;
    child = gated?.child ?? spawn(snapshot.executable, snapshot.argv, {
      cwd: snapshot.cwd, env: snapshot.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
  } catch (error) { await operation.settle('not_dispatched'); throw error; }
  let closed = false;
  let spawnFailed = false;
  const outcome = await new Promise<{ exitCode?: number; timedOut: boolean; aborted: boolean; output?: string }>((resolve, reject) => {
    let output = '';
    const capture = (text: string) => { output = (output + text).slice(-8_000); };
    child.stdout?.setEncoding('utf8').on('data', capture);
    child.stderr?.setEncoding('utf8').on('data', capture);
    const cleanUp = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => {
      terminateProcessTree(child);
      cleanUp();
      resolve({ timedOut: false, aborted: true });
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      cleanUp();
      resolve({ timedOut: true, aborted: false });
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', error => { spawnFailed = child.pid === undefined; cleanUp(); reject(error); });
    child.once('close', code => {
      closed = true;
      cleanUp();
      resolve({ exitCode: code ?? undefined, timedOut: false, aborted: false, output: redactSensitiveReviewText(output, 8_000) });
    });
    if (signal?.aborted) stop();
  }).catch(async error => {
    await operation.settle(spawnFailed ? 'not_dispatched' : 'result_unknown');
    throw error;
  });
  await gated?.dispatch;
  await operation.settle(gated && !gated.authorized ? 'not_dispatched' : closed ? 'completed' : 'result_unknown');
  if (gated?.launchError && !outcome.timedOut && !outcome.aborted) throw new Error(gated.launchError);
  return outcome;
}

function localizeValidation(
  language: KeepseekLanguage,
  key: 'unsupportedScript' | 'untrusted' | 'stopped' | 'workspaceMissing' | 'manifestMissing' | 'scriptMissing' | 'snapshotChanged' | 'notAuthorized' | 'timedOut' | 'failed',
  script?: string,
  exitCode?: number
): string {
  const en: Record<typeof key, string> = {
    unsupportedScript: `Validation script "${script ?? ''}" is not in KeepSeek's fixed allowlist.`,
    untrusted: 'Controlled validation is disabled because the workspace is not trusted.',
    stopped: 'The validation task was stopped.',
    workspaceMissing: 'Open a workspace folder before running validation.',
    manifestMissing: 'Fixed npm validation is unavailable because this workspace folder has no package.json. No script ran. Continue with the remaining work if this check is optional.',
    scriptMissing: `package.json does not define "${script ?? ''}". No script ran. Continue with the remaining work if this check is optional.`,
    snapshotChanged: 'Validation launch snapshot changed or authorization was revoked.',
    notAuthorized: 'The user did not authorize this validation task.',
    timedOut: 'The validation task reached its time limit and was stopped.',
    failed: `The "${script ?? ''}" validation task exited with code ${exitCode ?? 'unknown'}.`
  };
  const zh: Record<typeof key, string> = {
    unsupportedScript: `验证脚本“${script ?? ''}”不在 KeepSeek 的固定允许列表中。`,
    untrusted: '当前工作区未受信任，不能运行受控验证。',
    stopped: '验证任务已停止。',
    workspaceMissing: '请先打开工作区文件夹，再运行验证。',
    manifestMissing: '当前工作区文件夹没有 package.json，无法使用固定 npm 验证。未运行脚本。如果该验证不是任务必需项，请继续处理剩余工作。',
    scriptMissing: `package.json 未定义脚本“${script ?? ''}”。未运行脚本。如果该验证不是任务必需项，请继续处理剩余工作。`,
    snapshotChanged: '验证启动快照已变化或授权已撤销。',
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
