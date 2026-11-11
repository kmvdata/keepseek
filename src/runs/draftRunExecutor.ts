import { spawn, type ChildProcess } from 'node:child_process';
import type { GitRemoteCommand } from '../approvals/authorization/commandSemantics';
import { parseGitRefOutput, gitTransportError } from './gitReleaseEvidence';
import { createControlledEnvironment } from './executionEnvironment';
import type { RestrictedPythonSyntaxLaunch } from './restrictedPythonSyntax';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import type { DraftRun, ExecutionPermit } from '../shared/types';
import { analyzeCommand } from '../approvals/authorization/commandSemantics';
import { interpretGitQueryResult, type GitQueryResult } from './gitQueryResult';

const RESTRICTED_OUTPUT_LIMIT_BYTES = 8_192;
const EXIT_STREAM_CLOSE_GRACE_MS = 1_500;
const TERMINATION_SETTLE_GRACE_MS = 1_750;
const OUTPUT_STREAM_CLOSE_ERROR = 'DraftRun process exited, but inherited output streams did not close.';

export interface DraftRunOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface DraftRunExecutionOutcome {
  /** Missing means unknown, including adapters that predate execution evidence. */
  started?: boolean;
  phase?: 'not_dispatched' | 'spawn_failed' | 'exited' | 'result_unknown';
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
  queryResult?: GitQueryResult;
}

export interface VerifiedDraftRunLaunch {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  gitRemote?: GitRemoteCommand;
  /** Remote transport approval binds the repository, endpoint and refs. */
  fingerprint?: string;
}

export interface DraftRunExecutorAdapter {
  execute(input: {
    draftRun: DraftRun;
    permit: ExecutionPermit;
    verifiedLaunch?: VerifiedDraftRunLaunch;
    restrictedLaunch?: RestrictedPythonSyntaxLaunch;
    signal?: AbortSignal;
    onOutput: (chunk: DraftRunOutputChunk) => void;
  }): Promise<DraftRunExecutionOutcome>;
  cancel(draftRunId: string): boolean;
  showTerminal(draftRunId: string): boolean;
  dispose(): void;
}

interface RunningProcess {
  child: ChildProcess;
  terminal: vscode.Terminal;
  pty: DraftRunPseudoterminal;
  cancelRequested: boolean;
  timedOut: boolean;
  terminateAndSettle?: () => void;
}

interface SessionTerminal {
  terminal: vscode.Terminal;
  pty: DraftRunPseudoterminal;
}

export class SpawnDraftRunExecutor implements DraftRunExecutorAdapter {
  private readonly running = new Map<string, RunningProcess>();
  private readonly sessionTerminals = new Map<string, SessionTerminal>();
  private readonly runTerminalSessions = new Map<string, string>();
  private readonly consumedPermitNonces = new Map<string, number>();

  public async execute(input: {
    draftRun: DraftRun;
    permit: ExecutionPermit;
    verifiedLaunch?: VerifiedDraftRunLaunch;
    restrictedLaunch?: RestrictedPythonSyntaxLaunch;
    signal?: AbortSignal;
    onOutput: (chunk: DraftRunOutputChunk) => void;
  }): Promise<DraftRunExecutionOutcome> {
    validatePermit(input.draftRun, input.permit);
    const restricted = input.restrictedLaunch;
    const gitRemote = input.verifiedLaunch?.gitRemote;
    const gitLocalQuery = analyzeCommand(input.draftRun.spec).gitLocalQuery;
    if (Boolean(input.draftRun.spec.restricted) !== Boolean(restricted)
      || (restricted && input.permit.source !== 'delegated_approver')) {
      throw new Error('Restricted DraftRun requires its verified launch and delegated permit.');
    }
    for (const [nonce, expiresAt] of this.consumedPermitNonces) {
      if (expiresAt <= Date.now()) {
        this.consumedPermitNonces.delete(nonce);
      }
    }
    if (this.consumedPermitNonces.has(input.permit.nonce)) {
      throw new Error('DraftRun execution permit was already consumed.');
    }
    this.consumedPermitNonces.set(input.permit.nonce, input.permit.expiresAt);
    if (this.running.size > 0 || this.running.has(input.draftRun.id)) {
      throw new Error('Another DraftRun is already running.');
    }
    if (input.signal?.aborted) {
      return { started: false, phase: 'not_dispatched', timedOut: false, cancelled: true };
    }

    const { pty, terminal } = this.getOrCreateSessionTerminal(input.draftRun.sessionId);
    pty.setActiveRun(() => this.cancel(input.draftRun.id));
    this.runTerminalSessions.set(input.draftRun.id, input.draftRun.sessionId);
    pty.write(formatTerminalHeader(input.draftRun));

    const child = spawn(restricted?.executable ?? input.verifiedLaunch?.executable ?? input.draftRun.spec.executable, input.draftRun.spec.args, {
      cwd: restricted?.cwd ?? input.verifiedLaunch?.cwd ?? vscode.Uri.parse(input.draftRun.spec.cwdUri).fsPath,
      env: restricted ? {} : input.verifiedLaunch?.env ?? createControlledEnvironment(input.draftRun.spec.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [restricted ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    const running: RunningProcess = {
      child,
      terminal,
      pty,
      cancelRequested: false,
      timedOut: false
    };
    this.running.set(input.draftRun.id, running);
    return await new Promise<DraftRunExecutionOutcome>((resolve) => {
      let settled = false;
      let started = false;
      let spawnFailed = false;
      child.once('spawn', () => { started = true; });
      let exitCloseTimer: ReturnType<typeof setTimeout> | undefined;
      let terminationSettleTimer: ReturnType<typeof setTimeout> | undefined;
      let exitCode: number | undefined;
      let exitSignal: string | undefined;
      let outputBytes = 0;
      let outputLimitError: string | undefined;
      let remoteStdout = '';
      let remoteStderr = '';
      let queryStdout = '';
      let queryStderr = '';
      let queryOutputTruncated = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const emit = (stream: DraftRunOutputChunk['stream'], text: string) => {
        if (!text) {
          return;
        }
        pty.write(text);
        input.onOutput({ stream, text });
      };
      const onData = (stream: DraftRunOutputChunk['stream'], decoder: StringDecoder, chunk: Buffer) => {
        if (restricted) {
          if (outputLimitError) return;
          outputBytes += chunk.byteLength;
          if (outputBytes > RESTRICTED_OUTPUT_LIMIT_BYTES) {
            outputLimitError = 'Restricted AST output exceeded its limit. / 受限 AST 验证输出超过上限。';
            terminateAndBoundSettlement();
            return;
          }
        }
        if (gitRemote) {
          // A Git server may print arbitrary banners, hook output or URLs.
          // Only normalized reference evidence and fixed diagnostics leave this boundary.
          if (stream === 'stdout' && gitRemote.kind === 'query') {
            if (outputLimitError) return;
            outputBytes += chunk.byteLength;
            if (outputBytes > 512 * 1024) {
              outputLimitError = 'Git remote query output exceeded its limit. / Git 远端查询输出超过上限。';
              terminateAndBoundSettlement();
              return;
            }
            remoteStdout += decoder.write(chunk);
          } else if (stream === 'stderr' && remoteStderr.length < 8192) {
            remoteStderr = (remoteStderr + decoder.write(chunk)).slice(0, 8192);
          }
          return;
        }
        const text = decoder.write(chunk);
        if (gitLocalQuery) {
          // Query facts must be interpreted from complete bounded stdout, never
          // from the store's display head/tail or from a model's claim.
          if (stream === 'stdout' && gitLocalQuery.kind !== 'log') {
            if (Buffer.byteLength(queryStdout, 'utf8') + chunk.byteLength <= 512 * 1024) queryStdout += text;
            else queryOutputTruncated = true;
          } else if (stream === 'stderr') queryStderr = (queryStderr + text).slice(0, 8192);
        }
        emit(stream, text);
      };
      child.stdout?.on('data', (chunk: Buffer) => onData('stdout', stdoutDecoder, chunk));
      child.stderr?.on('data', (chunk: Buffer) => onData('stderr', stderrDecoder, chunk));

      const finish = (outcome: DraftRunExecutionOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(executionTimer);
        if (exitCloseTimer) clearTimeout(exitCloseTimer);
        if (terminationSettleTimer) clearTimeout(terminationSettleTimer);
        input.signal?.removeEventListener('abort', abortExecution);
        if (gitRemote) {
          if (outcome.exitCode === 0 && !outcome.error && gitRemote.kind === 'query') {
            try {
              const requested = gitRemote.refs.length ? gitRemote.refs : ['refs/' + gitRemote.namespace + '/*'];
              const refs = parseGitRefOutput(remoteStdout + stdoutDecoder.end(), requested);
              emit('stdout', refs.map(ref => `${ref.object}\t${ref.ref}\n`
                + (ref.peeled ? `${ref.peeled}\t${ref.ref}^{}\n` : '')).join(''));
            } catch (error) {
              outcome.error = error instanceof Error ? error.message : 'Invalid Git response. / Git 响应无效。';
            }
          } else if (!outcome.cancelled && !outcome.timedOut && outcome.exitCode !== 0) {
            outcome.error = gitTransportError(remoteStderr, gitRemote.kind, !started);
          }
        } else {
          const stdoutEnd = stdoutDecoder.end();
          const stderrEnd = stderrDecoder.end();
          queryStdout += stdoutEnd;
          queryStderr += stderrEnd;
          emit('stdout', stdoutEnd);
          emit('stderr', stderrEnd);
          if (gitLocalQuery) {
            outcome.queryResult = interpretGitQueryResult(input.draftRun.spec, outcome, queryStdout, queryStderr);
            if (queryOutputTruncated && outcome.queryResult) outcome.queryResult = {
              version: 1, kind: gitLocalQuery.kind, errorCode: 'invalid_query_output'
            };
            if (outcome.queryResult?.errorCode) outcome.error =
              `Git query ${outcome.queryResult.errorCode}. / Git 查询失败：${outcome.queryResult.errorCode}。`;
          }
        }
        this.running.delete(input.draftRun.id);
        pty.write(`\r\n[KeepSeek DraftRun ${formatOutcomeLabel(outcome)}]\r\n`);
        pty.finishRun();
        resolve({ ...outcome, started: started ? true : spawnFailed ? false : undefined,
          phase: spawnFailed ? 'spawn_failed' : outcome.exitCode !== undefined || outcome.signal
            ? 'exited' : 'result_unknown' });
      };
      const currentOutcome = (error?: string): DraftRunExecutionOutcome => ({
        exitCode,
        signal: exitSignal,
        timedOut: running.timedOut,
        cancelled: running.cancelRequested,
        error: error ?? outputLimitError
      });
      const destroyOutputStreams = () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const terminateAndBoundSettlement = () => {
        terminateProcessTree(child);
        if (terminationSettleTimer) {
          return;
        }
        terminationSettleTimer = setTimeout(() => {
          destroyOutputStreams();
          finish(currentOutcome());
        }, TERMINATION_SETTLE_GRACE_MS);
        terminationSettleTimer.unref?.();
      };
      const abortExecution = () => {
        if (!running.cancelRequested) {
          running.cancelRequested = true;
          terminateAndBoundSettlement();
        }
      };
      running.terminateAndSettle = terminateAndBoundSettlement;

      const executionTimer = setTimeout(() => {
        running.timedOut = true;
        terminateAndBoundSettlement();
      }, input.draftRun.spec.timeoutMs);
      input.signal?.addEventListener('abort', abortExecution, { once: true });
      if (input.signal?.aborted) {
        abortExecution();
      }
      child.once('error', (error) => {
        // Node emits spawn only after a child has actually launched. A startup
        // error without a pid proves it never did; a later error does not.
        spawnFailed = !started && child.pid === undefined;
        finish({ timedOut: running.timedOut, cancelled: running.cancelRequested, error: error.message });
      });
      child.once('exit', (code, signal) => {
        if (settled) {
          return;
        }
        exitCode = typeof code === 'number' ? code : undefined;
        exitSignal = signal ?? undefined;
        exitCloseTimer = setTimeout(() => {
          // A descendant may keep inherited stdout/stderr descriptors open after
          // the approved executable exits. Do not let that pin the DraftRun and
          // the whole chat view indefinitely.
          terminateProcessTree(child);
          destroyOutputStreams();
          finish(currentOutcome(
            running.timedOut || running.cancelRequested ? undefined : OUTPUT_STREAM_CLOSE_ERROR
          ));
        }, EXIT_STREAM_CLOSE_GRACE_MS);
        exitCloseTimer.unref?.();
      });
      if (restricted) {
        child.stdin?.on('error', () => {
          // Exit or cancellation can close the pipe before all input is sent.
          // The child lifecycle determines the actual result.
        });
        child.stdin?.end(restricted.stdin, 'utf8');
      }
      child.once('close', (code, signal) => finish({
        exitCode: typeof code === 'number' ? code : undefined,
        signal: signal ?? undefined,
        timedOut: running.timedOut,
        cancelled: running.cancelRequested,
        error: outputLimitError
      }));
    });
  }

  public cancel(draftRunId: string): boolean {
    const running = this.running.get(draftRunId);
    if (!running || running.cancelRequested) {
      return false;
    }
    running.cancelRequested = true;
    if (running.terminateAndSettle) {
      running.terminateAndSettle();
    } else {
      terminateProcessTree(running.child);
    }
    return true;
  }

  public showTerminal(draftRunId: string): boolean {
    const sessionId = this.runTerminalSessions.get(draftRunId);
    const shared = sessionId ? this.sessionTerminals.get(sessionId) : undefined;
    if (!shared || shared.pty.isClosed) {
      return false;
    }
    shared.terminal.show(true);
    return true;
  }

  public dispose(): void {
    for (const running of this.running.values()) {
      running.cancelRequested = true;
      terminateProcessTree(running.child);
    }
    for (const shared of this.sessionTerminals.values()) {
      shared.terminal.dispose();
    }
    this.sessionTerminals.clear();
    this.runTerminalSessions.clear();
  }

  private getOrCreateSessionTerminal(sessionId: string): SessionTerminal {
    const existing = this.sessionTerminals.get(sessionId);
    if (existing && !existing.pty.isClosed) {
      return existing;
    }
    const pty = new DraftRunPseudoterminal(() => {
      const current = this.sessionTerminals.get(sessionId);
      if (current?.pty === pty) {
        this.sessionTerminals.delete(sessionId);
      }
      for (const [draftRunId, terminalSessionId] of this.runTerminalSessions) {
        if (terminalSessionId === sessionId) {
          this.runTerminalSessions.delete(draftRunId);
        }
      }
    });
    const terminal = vscode.window.createTerminal({
      name: 'KeepSeek DraftRuns',
      pty
    });
    const created = { terminal, pty };
    this.sessionTerminals.set(sessionId, created);
    return created;
  }
}

class DraftRunPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;
  private activeRunCancel: (() => void) | undefined;
  private closed = false;

  public constructor(private readonly onClosed: () => void) {}

  public get isClosed(): boolean {
    return this.closed;
  }

  public open(): void {}

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.activeRunCancel?.();
    this.activeRunCancel = undefined;
    this.onClosed();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  public handleInput(data: string): void {
    if (data.includes('\u0003')) {
      this.activeRunCancel?.();
      this.write('^C\r\n');
    }
  }

  public write(value: string): void {
    const normalized = value.replace(/\r?\n/gu, '\r\n');
    this.writeEmitter.fire(normalized);
  }

  public setActiveRun(onCancel: () => void): void {
    this.activeRunCancel = onCancel;
  }

  public finishRun(): void {
    this.activeRunCancel = undefined;
  }
}

function validatePermit(draftRun: DraftRun, permit: ExecutionPermit): void {
  if (draftRun.historyInvalidationId || draftRun.historyOriginUnverified) throw new Error('DraftRun was detached by editing its source history.');
  if (permit.source !== 'user_click' && permit.source !== 'delegated_approver') {
    throw new Error('DraftRun requires a user-click or delegated approval permit.');
  }
  if (permit.source === 'delegated_approver' && draftRun.authorizationSource !== permit.source) {
    throw new Error('Delegated permit requires a delegated approval record.');
  }
  if (permit.draftRunId !== draftRun.id || permit.specHash !== draftRun.specHash) {
    throw new Error('DraftRun execution permit does not match the immutable command.');
  }
  if (permit.expiresAt <= Date.now()) {
    throw new Error('DraftRun execution permit expired before the process started.');
  }
  const allowed = new Set(permit.allowedEffects);
  if (draftRun.effectAssessment.effects.some((effect) => !allowed.has(effect))) {
    throw new Error('DraftRun effects exceed the execution permit.');
  }
}

export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.unref();
    } else {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Process group already exited.
        }
      }, 1_500).unref();
    }
  } catch {
    child.kill('SIGTERM');
  }
}

function formatTerminalHeader(draftRun: DraftRun): string {
  return [
    '',
    `======== DraftRun ${draftRun.id} · ${shortExecutable(draftRun.spec.executable)} ========`,
    'KeepSeek DraftRun (explicitly approved once)',
    `Executable: ${draftRun.spec.executable}`,
    `Arguments: ${JSON.stringify(draftRun.spec.args)}`,
    `Working directory: ${vscode.Uri.parse(draftRun.spec.cwdUri).fsPath}`,
    `Purpose: ${draftRun.spec.reason}`,
    ''
  ].join('\r\n');
}

function shortExecutable(executable: string): string {
  return executable.replace(/^.*[/\\]/u, '') || executable;
}

function formatOutcomeLabel(outcome: DraftRunExecutionOutcome): string {
  if (outcome.cancelled) return 'cancelled';
  if (outcome.timedOut) return 'timed out';
  if (outcome.error) return `failed: ${outcome.error}`;
  return `exited with code ${outcome.exitCode ?? 'unknown'}`;
}
