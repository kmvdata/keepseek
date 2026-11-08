import * as vscode from 'vscode';

export interface RecoveryMetadataInspectionOptions {
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
  maxFileBytes?: number;
}
export interface RecoveryMetadataSummary {
  availability: 'found' | 'missing' | 'partial' | 'unavailable';
  records: number;
  states: Record<string, number>;
  unsettled: number;
  unknown: number;
  filesRead: number;
  bytesRead: number;
  malformedFiles: number;
  inaccessibleFiles: number;
  truncated: boolean;
  /** These records span extension storage, not an attributed physical project. */
  scope: 'extension_storage';
  settlementProof: false;
}

/** Explicit diagnostics only. Reads owned subsystem metadata without invoking
 * initialization, migration, recovery, reconciliation or any writer. Legacy
 * aggregates can contain inline text; none is returned, logged or hydrated as
 * session/model context. Bounds prevent a Check action becoming a full scan.
 */
export class RecoveryMetadataReader {
  public readonly summary: RecoveryMetadataSummary = {
    availability: 'missing', records: 0, states: {}, unsettled: 0, unknown: 0,
    filesRead: 0, bytesRead: 0, malformedFiles: 0, inaccessibleFiles: 0,
    truncated: false, scope: 'extension_storage', settlementProof: false
  };
  private readonly files = new Set<string>();
  public constructor(private readonly options: RecoveryMetadataInspectionOptions = {}) {}
  public async read(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
    this.checkCancelled();
    if (this.files.has(uri.toString())) return undefined;
    if (this.files.size >= (this.options.maxFiles ?? 128)) { this.summary.truncated = true; return undefined; }
    this.files.add(uri.toString());
    try {
      const info = await vscode.workspace.fs.stat(uri);
      if (info.type !== vscode.FileType.File) { this.summary.inaccessibleFiles++; return undefined; }
      if (info.size > (this.options.maxFileBytes ?? 1_048_576)
        || this.summary.bytesRead + info.size > (this.options.maxBytes ?? 4_194_304)) { this.summary.truncated = true; return undefined; }
      this.checkCancelled();
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.summary.filesRead++; this.summary.bytesRead += bytes.byteLength;
      if (bytes.byteLength > (this.options.maxFileBytes ?? 1_048_576)
        || this.summary.bytesRead > (this.options.maxBytes ?? 4_194_304)) { this.summary.truncated = true; return undefined; }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) { this.summary.malformedFiles++; return undefined; }
      return value as Record<string, unknown>;
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      if (!isMissing(error)) {
        if (error instanceof SyntaxError) this.summary.malformedFiles++;
        else this.summary.inaccessibleFiles++;
      }
      return undefined;
    }
  }
  public async lanes(directory: vscode.Uri): Promise<vscode.Uri[]> {
    this.checkCancelled();
    try {
      const entries = (await vscode.workspace.fs.readDirectory(directory))
        .filter(([name, kind]) => kind === vscode.FileType.File && /^[a-f0-9]{32}\.json$/u.test(name))
        .sort(([a], [b]) => a.localeCompare(b));
      const limit = Math.max(0, (this.options.maxFiles ?? 128) - this.files.size);
      if (entries.length > limit) this.summary.truncated = true;
      return entries.slice(0, limit).map(([name]) => vscode.Uri.joinPath(directory, name));
    } catch (error) {
      if (!isMissing(error)) this.summary.inaccessibleFiles++;
      return [];
    }
  }
  public finish(): RecoveryMetadataSummary {
    this.summary.availability = this.summary.truncated || this.summary.inaccessibleFiles || this.summary.malformedFiles
      ? 'partial' : this.summary.filesRead ? 'found' : 'missing';
    return structuredClone(this.summary);
  }
  private checkCancelled(): void {
    if (this.options.signal?.aborted) { const error = new Error('Recovery metadata inspection cancelled. / 恢复元数据检查已取消。'); error.name = 'AbortError'; throw error; }
  }
}

export function metadataRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((record): record is Record<string, unknown> => !!record && typeof record === 'object' && !Array.isArray(record)) : [];
}
function isMissing(error: unknown): boolean { return ['ENOENT', 'FileNotFound'].includes(String((error as { code?: string })?.code)); }
