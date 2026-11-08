import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';

export interface LocalMutexLease { readonly isHeld: boolean; release(): Promise<void> }
export interface LocalMutexOptions { timeoutMs?: number; signal?: AbortSignal }
let testBackend: ((key: string, options: LocalMutexOptions) => Promise<LocalMutexLease | undefined>) | undefined;
/** Test harness dependency injection; production never installs a substitute. */
export function configureLocalKernelMutexTestBackend(backend?: typeof testBackend): void { testBackend = backend; }

/** Kernel-held, machine/user local exclusion. A collision is unavailable rather
 * than a second writer. It has no TTL, stale file or unlink election window.
 * The socket stays bound continuously until explicit release or process exit.
 */
export class LocalKernelMutex {
  private constructor(private readonly server: Server) {}
  public get isHeld(): boolean { return this.server.listening; }
  public async release(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
  public static async acquire(key: string, options: LocalMutexOptions = {}): Promise<LocalMutexLease | undefined> {
    return testBackend ? testBackend(key, options) : this.acquireNative(key, options);
  }
  /** Native-only integration tests must bypass the controlled harness. */
  public static async acquireNative(key: string, options: LocalMutexOptions = {}): Promise<LocalKernelMutex | undefined> {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : process.env.USERNAME ?? '';
    const digest = createHash('sha256').update(`keepseek-local-mutex-v1\0${uid}\0${key}`).digest();
    const port = 10000 + digest.readUInt32BE(0) % 50000;
    const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 0);
    for (;;) {
      if (options.signal?.aborted) throw aborted();
      const server = createServer((socket) => socket.destroy());
      const acquired = await new Promise<boolean>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => { server.unref(); resolve(true); });
      });
      if (acquired) return new LocalKernelMutex(server);
      if (Date.now() >= deadline) return undefined;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(40, Math.max(0, deadline - Date.now()))));
    }
  }
}
function aborted(): Error { const error = new Error('Local ownership check cancelled. / 本地所有权检查已取消。'); error.name = 'AbortError'; return error; }
