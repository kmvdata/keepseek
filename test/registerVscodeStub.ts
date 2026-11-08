import Module from 'node:module';
import * as vscode from './stubs/vscode';
import { configureLocalKernelMutexTestBackend, type LocalMutexLease } from '../src/tasks/localKernelMutex';

// Controlled exclusion is explicit: broad Host/Store tests exercise durability
// and routing under this adapter. Native cross-process mutex tests bypass it;
// an EPERM there is reported as an environment skip, never as OS-lock success.
const controlledMutexes = new Map<string, LocalMutexLease>();
configureLocalKernelMutexTestBackend(async (key, options) => {
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 0);
  while (controlledMutexes.has(key)) {
    if (options.signal?.aborted) { const error = new Error('Cancelled'); error.name = 'AbortError'; throw error; }
    if (Date.now() >= deadline) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(5, Math.max(0, deadline - Date.now()))));
  }
  let held = true;
  const lease: LocalMutexLease = {
    get isHeld() { return held; },
    release: async () => { if (held) { held = false; controlledMutexes.delete(key); } }
  };
  controlledMutexes.set(key, lease);
  return lease;
});

type ModuleWithLoad = typeof Module & {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

const moduleWithLoad = Module as ModuleWithLoad;
const originalLoad = moduleWithLoad._load;

moduleWithLoad._load = function loadWithVscodeStub(
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};
