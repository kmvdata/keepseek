import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { hashApprovalText, hashApprovalValue } from '../approvals/approvalReviewHash';
import { resolveExecutable } from '../approvals/authorization/commandScope';
import { findCanonicalWorkspaceFolder, isPathInside } from '../approvals/authorization/pathScope';
import { assertOperationPath } from '../approvals/authorization/protectedTargets';
import type { DraftRun, DraftRunProposal, DraftRunSpec } from '../shared/types';
import { hashDraftRunSpec } from './draftRunProposal';
import { createControlledEnvironment } from './executionEnvironment';

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 5_000;
export const PYTHON_SYNTAX_ERROR_EXIT = 42;
const PARSER = [
  'import ast, sys',
  'name = sys.argv[1]',
  'try:',
  '    ast.parse(sys.stdin.buffer.read().decode("utf-8"), filename=name)',
  'except SyntaxError as error:',
  '    print(f"{name}:{error.lineno}:{error.offset}: SyntaxError", file=sys.stderr)',
  `    sys.exit(${PYTHON_SYNTAX_ERROR_EXIT})`,
  'print("syntax ok", name)'
].join('\n');

// Consume the entire argv payload. Literals deliberately exclude escape sequences,
// prefixes, concatenation and newlines. Whitespace is limited to spaces and tabs.
const AST_PROPOSAL = /^[ \t]*import[ \t]+ast[ \t]*,[ \t]*pathlib[ \t]*;[ \t]*p[ \t]*=[ \t]*pathlib[ \t]*\.[ \t]*Path[ \t]*\([ \t]*(?:"([^"\\\r\n]+)"|'([^'\\\r\n]+)')[ \t]*\)[ \t]*;[ \t]*ast[ \t]*\.[ \t]*parse[ \t]*\([ \t]*p[ \t]*\.[ \t]*read_text[ \t]*\([ \t]*encoding[ \t]*=[ \t]*(?:"utf-8"|'utf-8')[ \t]*\)[ \t]*\)[ \t]*;[ \t]*print[ \t]*\([ \t]*(?:"syntax ok"|'syntax ok')[ \t]*,[ \t]*p[ \t]*\)[ \t]*;?[ \t]*$(?![\s\S])/u;

export interface RestrictedPythonSyntaxSpec {
  kind: 'python_ast_v1';
  originalDraftRunId: string;
  originalSpecHash: string;
  target: string;
  targetUri: string;
  snapshotHash: string;
  snapshotBytes: number;
  boundaryFingerprint: string;
}

export interface RestrictedPythonSyntaxLaunch {
  executable: string;
  cwd: string;
  stdin: string;
}

export function recognizePythonSyntaxIntent(spec: DraftRunSpec): string | undefined {
  if (spec.restricted || spec.args.length !== 2 || spec.args[0] !== '-c'
    || !/^python\d*$/u.test(path.basename(spec.executable)) || spec.args[1].length > 2_048) return undefined;
  const match = AST_PROPOSAL.exec(spec.args[1]);
  return match?.[1] ?? match?.[2];
}

export async function prepareRestrictedPythonSyntax(run: DraftRun, target: string): Promise<DraftRunProposal> {
  if (run.spec.env.length || run.spec.externalCwd || recognizePythonSyntaxIntent(run.spec) !== target) {
    throw new Error('AST verification requires a project cwd and no environment overrides. / AST 验证要求项目内工作目录且不能覆盖环境变量。');
  }
  const verified = await inspectBoundary(run.spec, target);
  const spec: DraftRunSpec = {
    ...run.spec,
    executable: verified.executable,
    args: parserArgs(target),
    reason: 'Validate one Python source snapshot with ast.parse. / 用 ast.parse 验证单个 Python 文件快照。',
    timeoutMs: Math.min(run.spec.timeoutMs, MAX_TIMEOUT_MS),
    restricted: {
      kind: 'python_ast_v1', originalDraftRunId: run.id, originalSpecHash: run.specHash,
      target, targetUri: verified.targetUri, snapshotHash: hashApprovalText(verified.stdin),
      snapshotBytes: Buffer.byteLength(verified.stdin), boundaryFingerprint: verified.fingerprint
    }
  };
  return {
    id: randomUUID(), spec, specHash: hashDraftRunSpec(spec),
    effectAssessment: { version: 1, verdict: 'enforced_readonly', effects: ['workspace_read'],
      evidence: ['Host reads one bound UTF-8 snapshot; fixed parser receives only stdin.'] }
  };
}

export async function verifyRestrictedPythonSyntax(run: DraftRun, original: DraftRun): Promise<RestrictedPythonSyntaxLaunch> {
  const plan = run.spec.restricted;
  if (!plan || plan.kind !== 'python_ast_v1' || plan.originalDraftRunId !== original.id || plan.originalSpecHash !== original.specHash
    || hashDraftRunSpec(original.spec) !== original.specHash || original.replacementDraftRunId !== run.id
    || original.sessionId !== run.sessionId || original.agentRunId !== run.agentRunId || original.status !== 'needs_replan'
    || recognizePythonSyntaxIntent(original.spec) !== plan.target || run.spec.cwdUri !== original.spec.cwdUri
    || original.spec.env.length || run.spec.env.length || run.spec.timeoutMs !== Math.min(original.spec.timeoutMs, MAX_TIMEOUT_MS)
    || JSON.stringify(run.spec.args) !== JSON.stringify(parserArgs(plan.target))) throw changed();
  const verified = await inspectBoundary(original.spec, plan.target);
  if (verified.fingerprint !== plan.boundaryFingerprint || verified.executable !== run.spec.executable
    || verified.targetUri !== plan.targetUri || hashApprovalText(verified.stdin) !== plan.snapshotHash
    || Buffer.byteLength(verified.stdin) !== plan.snapshotBytes) throw changed();
  return { executable: verified.executable, cwd: verified.cwd, stdin: verified.stdin };
}

function parserArgs(target: string): string[] {
  return ['-I', '-S', '-B', '-c', PARSER, target];
}

async function inspectBoundary(spec: DraftRunSpec, target: string) {
  if (!vscode.workspace.isTrusted || !['darwin', 'linux'].includes(process.platform) || !constants.O_NOFOLLOW) {
    throw new Error('Restricted AST validation is unavailable on this host or workspace. / 当前宿主或工作区无法使用受限 AST 验证。');
  }
  const uri = vscode.Uri.parse(spec.cwdUri);
  const cwd = uri.fsPath;
  const workspace = await findCanonicalWorkspaceFolder(cwd);
  if (uri.scheme !== 'file' || !workspace || workspace.folder.name !== spec.workspaceFolder || await realpath(cwd) !== cwd) throw changed();
  const cwdInfo = await stat(cwd);
  if (!cwdInfo.isDirectory()) throw changed();
  const workspaceRoots = await Promise.all((vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file').map(folder => realpath(folder.uri.fsPath)));
  const launcher = await resolveExecutable(spec.executable, cwd, createControlledEnvironment([]));
  if (!launcher?.trusted || workspaceRoots.some(root => isPathInside(root, launcher.path) || isPathInside(root, launcher.launchPath))
    || !await isKnownPythonLauncher(launcher)) {
    throw new Error('The Python launcher is not a verified installed native interpreter. / Python 启动器未经核实或并非已安装的原生解释器。');
  }
  const launchInfo = await lstat(launcher.launchPath);
  if (await realpath(launcher.launchPath) !== launcher.path) throw changed();

  const parts = target.split('/');
  if (parts[0] === '.') parts.shift();
  // Reject foreign path syntax, traversal, control characters and hidden targets.
  if (!parts.every(part => part && !part.startsWith('.') && !/[:\\\p{Cc}\p{Cf}]/u.test(part))
    || !target.endsWith('.py') || Buffer.byteLength(target) > 1_024) {
    throw new Error('Expected one visible, relative Python source path inside the selected project. / 需要当前项目内一个可见的相对 Python 源文件路径。');
  }
  const absolute = path.join(cwd, ...parts);
  if (!isPathInside(workspace.realPath, absolute)) throw changed();
  assertOperationPath(absolute);
  let cursor = cwd;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw changed();
  }
  if (await realpath(absolute) !== absolute) throw changed();
  const targetUri = vscode.Uri.file(absolute).toString();
  if (vscode.workspace.textDocuments?.some(doc => doc.isDirty && doc.uri.scheme === 'file'
    && path.resolve(doc.uri.fsPath) === absolute)) throw changed();

  const expected = await lstat(absolute);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_INPUT_BYTES
      || fileIdentity(before) !== fileIdentity(expected) || await realpath(absolute) !== absolute) throw changed();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(absolute);
    if (length !== before.size || current.isSymbolicLink() || await realpath(absolute) !== absolute
      || fileIdentity(before) !== fileIdentity(after) || fileIdentity(before) !== fileIdentity(current)) throw changed();
    const stdin = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    const fingerprint = hashApprovalValue([workspace.realPath, workspace.folder.uri.toString(), cwd, cwdInfo.dev, cwdInfo.ino,
      targetUri, fileIdentity(before), launcher, fileIdentity(launchInfo), 'empty_environment:stdin:python_ast_v1']);
    return { executable: launcher.launchPath, cwd, stdin, targetUri, fingerprint };
  } finally {
    await handle.close();
  }
}

function fileIdentity(info: Awaited<ReturnType<typeof stat>>): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

async function isKnownPythonLauncher(launcher: NonNullable<Awaited<ReturnType<typeof resolveExecutable>>>): Promise<boolean> {
  const launchDir = path.dirname(launcher.launchPath);
  const realDir = await realpath(launchDir);
  if (realDir !== path.dirname(launcher.path)
    && !(process.platform === 'darwin' && ['/opt/homebrew/bin', '/usr/local/bin'].includes(launchDir)
      && /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/python/u.test(launcher.path))) return false;
  // Apple's system executable is a developer-tools selector. Require an
  // installed runtime with a known launch location on macOS.
  if (process.platform === 'darwin' && launcher.path === '/usr/bin/python3') return false;
  const handle = await open(launcher.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` !== launcher.identity) return false;
    const header = Buffer.alloc(4);
    const read = await handle.read(header, 0, header.length, 0);
    return read.bytesRead === 4 && (process.platform === 'linux' ? header.toString('hex') === '7f454c46'
      : ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex')));
  } finally { await handle.close(); }
}

function changed(): Error {
  return new Error('AST input, launch identity, or project boundary could not be verified. Nothing executed. / 无法核实 AST 输入、启动身份或项目边界，未执行。');
}
