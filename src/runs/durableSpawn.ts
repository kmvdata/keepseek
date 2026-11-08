import { spawn, type ChildProcess } from 'node:child_process';
import { assertProjectMutationLease } from '../tasks/projectResources';

interface DispatchJournal {
  dispatched(process: { pid?: number; processGroup?: number }): Promise<void>;
}

export interface GatedProcess {
  child: ChildProcess;
  /** Never rejects: dispatch errors are returned as launchError after close. */
  dispatch: Promise<void>;
  readonly started: boolean;
  readonly launchError: string | undefined;
  readonly authorized: boolean;
  readonly commandFailed: boolean;
}

// The launcher receives no command or credentials in its argv. A crash before
// GO closes IPC and exits without invoking the target. GO is sent only after
// the launcher PID/group is durable and the execution fence is checked again.
const LAUNCHER = String.raw`
const {spawn}=require('node:child_process');
let accepted=false;
process.on('disconnect',()=>{if(!accepted)process.exit(0)});
process.once('message',spec=>{
  if(!spec||spec.type!=='go')process.exit(125);
  accepted=true;
  let child;
  try { child=spawn(spec.executable,spec.args,{cwd:spec.cwd,env:spec.env,shell:false,windowsHide:true,stdio:[spec.stdin===undefined?'ignore':'pipe','pipe','pipe']}); }
  catch(error){if(process.connected)process.send({type:'command-error',message:String(error.message)});process.exitCode=127;if(process.connected)process.disconnect();return}
  child.once('spawn',()=>{if(process.connected)process.send({type:'command-started'})});
  child.once('error',error=>{if(process.connected)process.send({type:'command-error',message:String(error.message)})});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  if(spec.stdin!==undefined){child.stdin.on('error',()=>{});child.stdin.end(spec.stdin,'utf8')}
  child.once('exit',(code,signal)=>{if(process.connected)process.send({type:'command-exit',code,signal})});
  child.once('close',(code,signal)=>{process.exitCode=typeof code==='number'?code:signal?128:127;if(process.connected)process.disconnect()});
});
if(process.connected)process.send({type:'ready'});
`;

export function spawnDurablyGated(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  journal: DispatchJournal;
}): GatedProcess {
  const child = spawn(process.execPath, ['-e', LAUNCHER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let started = false;
  let authorized = false;
  let commandFailed = false;
  let launchError: string | undefined;
  let complete!: () => void;
  const dispatch = new Promise<void>(resolve => { complete = resolve; });
  let ready = false;
  const timer = setTimeout(() => {
    launchError = 'Process dispatch handshake timed out. / 进程派发握手超时。';
    child.kill(); complete();
  }, 10_000);
  timer.unref?.();
  const finish = () => { clearTimeout(timer); complete(); };
  child.once('close', finish);
  child.once('error', error => { launchError = error.message; finish(); });
  child.on('message', message => {
    const record = message as { type?: string; message?: string };
    if (record.type === 'command-started') { started = true; return; }
    if (record.type === 'command-error') { commandFailed = true; launchError = record.message ?? 'Process launch failed.'; return; }
    if (record.type !== 'ready' || ready) return;
    ready = true;
    void (async () => {
      await input.journal.dispatched({ pid: child.pid, processGroup: process.platform === 'win32' ? undefined : child.pid });
      await assertProjectMutationLease();
      if (input.signal?.aborted || !child.connected) throw new Error('Process dispatch cancelled. / 进程派发已取消。');
      authorized = true;
      await new Promise<void>((resolve, reject) => child.send({
        type: 'go', executable: input.executable, args: input.args, cwd: input.cwd, env: input.env,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin })
      }, error => error ? reject(error) : resolve()));
      finish();
    })().catch(error => {
      launchError = error instanceof Error ? error.message : String(error);
      child.kill(); finish();
    });
  });
  return { child, dispatch, get started() { return started; }, get launchError() { return launchError; }, get authorized() { return authorized; }, get commandFailed() { return commandFailed; } };
}
