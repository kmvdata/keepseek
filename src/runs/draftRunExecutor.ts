import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import type { DraftRun, ExecutionPermit } from '../shared/types';

export interface DraftRunOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface DraftRunExecutionOutcome {
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

export interface DraftRunExecutorAdapter {
  execute(input: {
    draftRun: DraftRun;
    permit: ExecutionPermit;
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
}

export class SpawnDraftRunExecutor implements DraftRunExecutorAdapter {
  private readonly running = new Map<string, RunningProcess>();
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly consumedPermitNonces = new Map<string, number>();

  public async execute(input: {
    draftRun: DraftRun;
    permit: ExecutionPermit;
    signal?: AbortSignal;
    onOutput: (chunk: DraftRunOutputChunk) => void;
  }): Promise<DraftRunExecutionOutcome> {
    validatePermit(input.draftRun, input.permit);
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
      return { timedOut: false, cancelled: true };
    }

    const pty = new DraftRunPseudoterminal(() => this.cancel(input.draftRun.id));
    const terminal = vscode.window.createTerminal({
      name: `KeepSeek DraftRun: ${shortExecutable(input.draftRun.spec.executable)}`,
      pty
    });
    this.terminals.set(input.draftRun.id, terminal);
    terminal.show(true);
    pty.write(formatTerminalHeader(input.draftRun));

    const child = spawn(input.draftRun.spec.executable, input.draftRun.spec.args, {
      cwd: vscode.Uri.parse(input.draftRun.spec.cwdUri).fsPath,
      env: createControlledEnvironment(input.draftRun.spec.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const running: RunningProcess = {
      child,
      terminal,
      pty,
      cancelRequested: false,
      timedOut: false
    };
    this.running.set(input.draftRun.id, running);
    const abortExecution = () => {
      if (!running.cancelRequested) {
        running.cancelRequested = true;
        terminateProcessTree(child);
      }
    };
    input.signal?.addEventListener('abort', abortExecution, { once: true });

    return await new Promise<DraftRunExecutionOutcome>((resolve) => {
      let settled = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const emit = (stream: DraftRunOutputChunk['stream'], text: string) => {
        if (!text) {
          return;
        }
        pty.write(text);
        input.onOutput({ stream, text });
      };
      child.stdout?.on('data', (chunk: Buffer) => emit('stdout', stdoutDecoder.write(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => emit('stderr', stderrDecoder.write(chunk)));

      const timer = setTimeout(() => {
        running.timedOut = true;
        terminateProcessTree(child);
      }, input.draftRun.spec.timeoutMs);
      const finish = (outcome: DraftRunExecutionOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abortExecution);
        emit('stdout', stdoutDecoder.end());
        emit('stderr', stderrDecoder.end());
        this.running.delete(input.draftRun.id);
        pty.write(`\r\n[KeepSeek DraftRun ${formatOutcomeLabel(outcome)}]\r\n`);
        pty.finish();
        resolve(outcome);
      };
      child.once('error', (error) => finish({
        timedOut: running.timedOut,
        cancelled: running.cancelRequested,
        error: error.message
      }));
      child.once('close', (code, signal) => finish({
        exitCode: typeof code === 'number' ? code : undefined,
        signal: signal ?? undefined,
        timedOut: running.timedOut,
        cancelled: running.cancelRequested
      }));
    });
  }

  public cancel(draftRunId: string): boolean {
    const running = this.running.get(draftRunId);
    if (!running || running.cancelRequested) {
      return false;
    }
    running.cancelRequested = true;
    terminateProcessTree(running.child);
    return true;
  }

  public showTerminal(draftRunId: string): boolean {
    const terminal = this.terminals.get(draftRunId);
    if (!terminal) {
      return false;
    }
    terminal.show(true);
    return true;
  }

  public dispose(): void {
    for (const running of this.running.values()) {
      running.cancelRequested = true;
      terminateProcessTree(running.child);
    }
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
  }
}

class DraftRunPseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidWrite = this.writeEmitter.event;
  public readonly onDidClose = this.closeEmitter.event;
  private completed = false;

  public constructor(private readonly onCancel: () => void) {}

  public open(): void {}

  public close(): void {
    if (!this.completed) {
      this.onCancel();
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  public handleInput(data: string): void {
    if (data.includes('\u0003')) {
      this.onCancel();
      this.write('^C\r\n');
    }
  }

  public write(value: string): void {
    const normalized = value.replace(/\r?\n/gu, '\r\n');
    this.writeEmitter.fire(normalized);
  }

  public finish(): void {
    this.completed = true;
  }
}

function validatePermit(draftRun: DraftRun, permit: ExecutionPermit): void {
  if (permit.source !== 'user_click') {
    throw new Error('This KeepSeek version only accepts user-click DraftRun permits.');
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

function createControlledEnvironment(entries: readonly { name: string; value: string }[]): NodeJS.ProcessEnv {
  const allowedNames = [
    'PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR',
    'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SHELL', 'TERM', 'COLORTERM'
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  for (const entry of entries) {
    env[entry.name] = entry.value;
  }
  return env;
}

function terminateProcessTree(child: ChildProcess): void {
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
