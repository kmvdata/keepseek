import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredDraftRunTimeoutMs } from '../shared/config';
import type {
  ApprovalMode,
  DraftRunEnvironmentEntry,
  DraftRunProposal,
  DraftRunSpec,
  DraftRunPrerequisite
} from '../shared/types';
import { analyzeCommandCapability } from '../approvals/authorization/commandCapability';
import { analyzeDraftRunEffects } from '../approvals/authorization/commandEffects';
import { findCanonicalWorkspaceFolder } from '../approvals/authorization/pathScope';

export interface DraftRunProposalInput {
  executable: string;
  args: string[];
  reason: string;
  workspaceFolder?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: DraftRunEnvironmentEntry[];
  prerequisites?: DraftRunPrerequisite[];
  replacesDraftRun?: { draftRunId: string; specHash: string };
}

export async function createDraftRunProposal(input: DraftRunProposalInput, mode?: ApprovalMode): Promise<DraftRunProposal> {
  const executable = validateText(input.executable, 'executable', 16_384);
  if (input.args.length > 4_096) {
    throw new Error('DraftRun cannot contain more than 4096 arguments.');
  }
  const args = input.args.map((arg, index) => validateArgument(arg, index));
  if (args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 1_048_576) {
    throw new Error('DraftRun arguments are too large.');
  }
  const reason = validateText(input.reason, 'reason', 4_000);
  const env = normalizeEnvironment(input.env);
  const requestedCwd = resolveDraftRunCwd(input.workspaceFolder, input.cwd);
  const stat = await vscode.workspace.fs.stat(requestedCwd);
  if (stat.type !== vscode.FileType.Directory) {
    throw new Error('DraftRun working directory must be an existing directory.');
  }
  if (requestedCwd.scheme !== 'file') {
    throw new Error('DraftRun requires a local filesystem working directory.');
  }
  const cwdUri = vscode.Uri.file(await realpath(requestedCwd.fsPath));
  const workspaceFolder = await findCanonicalWorkspaceFolder(cwdUri.fsPath);
  const configuredTimeoutMs = getConfiguredDraftRunTimeoutMs();
  const requestedTimeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.max(1_000, Math.floor(input.timeoutMs as number))
    : configuredTimeoutMs;
  const spec: DraftRunSpec = {
    executable,
    args,
    reason,
    workspaceFolder: workspaceFolder?.folder.name,
    cwdUri: cwdUri.toString(),
    cwdLabel: workspaceFolder
      ? `${workspaceFolder.folder.name}/${path.relative(workspaceFolder.realPath, cwdUri.fsPath).split(path.sep).join('/') || '.'}`
      : 'external working directory',
    externalCwd: !workspaceFolder,
    timeoutMs: Math.min(requestedTimeoutMs, configuredTimeoutMs),
    env,
    ...normalizeDraftRunPlan(input)
  };
  return {
    id: randomUUID(),
    spec,
    specHash: hashDraftRunSpec(spec),
    effectAssessment: analyzeDraftRunEffects(spec),
    capabilityDiagnostic: analyzeCommandCapability(spec, undefined, mode).diagnostics.find(item => item.blocking)
  };
}

export function hashDraftRunSpec(spec: DraftRunSpec): string {
  return createHash('sha256').update(JSON.stringify({
    args: spec.args,
    cwdLabel: spec.cwdLabel,
    cwdUri: spec.cwdUri,
    env: spec.env,
    executable: spec.executable,
    externalCwd: spec.externalCwd,
    reason: spec.reason,
    timeoutMs: spec.timeoutMs,
    workspaceFolder: spec.workspaceFolder ?? '',
    restricted: spec.restricted,
    ...(spec.prerequisites ? { prerequisites: spec.prerequisites } : {}),
    ...(spec.replacesDraftRun ? { replacesDraftRun: spec.replacesDraftRun } : {})
  })).digest('hex');
}

function resolveDraftRunCwd(
  requestedWorkspaceFolder: string | undefined,
  rawCwd: string | undefined
): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    throw new Error('Open a workspace folder before creating a DraftRun.');
  }
  const requested = requestedWorkspaceFolder?.trim();
  const baseFolder = requested
    ? folders.find((folder) => folder.name === requested
      || folder.uri.fsPath === requested
      || folder.uri.toString() === requested)
    : folders[0];
  if (!baseFolder) {
    throw new Error(`Workspace folder "${requested}" was not found.`);
  }

  const cwd = rawCwd?.trim();
  let uri: vscode.Uri;
  if (!cwd) {
    uri = baseFolder.uri;
  } else if (/^file:/iu.test(cwd) || /^[a-z][a-z\d+.-]*:\/\//iu.test(cwd)) {
    uri = vscode.Uri.parse(cwd);
  } else if (path.isAbsolute(cwd)) {
    uri = vscode.Uri.file(cwd);
  } else {
    uri = vscode.Uri.file(path.resolve(baseFolder.uri.fsPath, cwd));
  }
  return uri;
}

function normalizeEnvironment(value: DraftRunEnvironmentEntry[] | undefined): DraftRunEnvironmentEntry[] {
  if ((value?.length ?? 0) > 128) {
    throw new Error('DraftRun cannot override more than 128 environment variables.');
  }
  const seen = new Set<string>();
  const normalized = (value ?? []).map((entry) => {
    const name = validateText(entry.name, 'environment name', 256);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid DraftRun environment variable name: ${name}`);
    }
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (seen.has(key)) {
      throw new Error(`Duplicate DraftRun environment variable: ${name}`);
    }
    seen.add(key);
    return { name, value: validateString(entry.value, 'environment value', 65_536) };
  });
  if (normalized.reduce((total, entry) => total + Buffer.byteLength(entry.name) + Buffer.byteLength(entry.value), 0) > 262_144) {
    throw new Error('DraftRun environment overrides are too large.');
  }
  return normalized;
}

function validateArgument(value: string, index: number): string {
  return validateString(value, `args[${index}]`, 131_072);
}

function validateText(value: string, label: string, maxLength: number): string {
  const normalized = validateString(value, label, maxLength).trim();
  if (!normalized) {
    throw new Error(`DraftRun ${label} cannot be empty.`);
  }
  return normalized;
}

function validateString(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`DraftRun ${label} must be a string.`);
  }
  if (value.includes('\0')) {
    throw new Error(`DraftRun ${label} cannot contain NUL.`);
  }
  if (value.length > maxLength) {
    throw new Error(`DraftRun ${label} is too long.`);
  }
  return value;
}

/** Invalid plan metadata is rejected, never silently dropped from a hashed spec. */
export function normalizeDraftRunPlan(input: { prerequisites?: unknown; replacesDraftRun?: unknown }):
  Pick<DraftRunSpec, 'prerequisites' | 'replacesDraftRun'> {
  const result: Pick<DraftRunSpec, 'prerequisites' | 'replacesDraftRun'> = {};
  const identity = (value: unknown): value is { draftRunId: string; specHash: string } => {
    const v = value as { draftRunId?: unknown; specHash?: unknown } | undefined;
    return !!v && typeof v.draftRunId === 'string' && v.draftRunId.length > 0 && v.draftRunId.length <= 256
      && typeof v.specHash === 'string' && /^[a-f0-9]{64}$/u.test(v.specHash);
  };
  if (input.prerequisites !== undefined) {
    if (!Array.isArray(input.prerequisites) || input.prerequisites.length > 32) throw new Error('Invalid command prerequisites.');
    const seen = new Set<string>();
    result.prerequisites = input.prerequisites.map(value => {
      if (!identity(value) || !['completed', 'predicate_true'].includes((value as DraftRunPrerequisite).condition) || seen.has(value.draftRunId)) {
        throw new Error('Invalid or duplicate command prerequisite.');
      }
      seen.add(value.draftRunId);
      return { draftRunId: value.draftRunId, specHash: value.specHash, condition: (value as DraftRunPrerequisite).condition } as DraftRunPrerequisite;
    });
  }
  if (input.replacesDraftRun !== undefined) {
    if (!identity(input.replacesDraftRun)) throw new Error('Invalid command replacement identity.');
    result.replacesDraftRun = { draftRunId: input.replacesDraftRun.draftRunId, specHash: input.replacesDraftRun.specHash };
  }
  return result;
}
