import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
} as const;

export class FileSystemError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'FileSystemError';
  }
}

export const SymbolKind: Record<string | number, string | number> = {
  Function: 11,
  Class: 4,
  11: 'Function',
  4: 'Class'
};

export class Position {
  public constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  public readonly event = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  public fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  public constructor(start: Position, end: Position);
  public constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  public constructor(
    startOrLine: Position | number,
    endOrStartCharacter: Position | number,
    endLine?: number,
    endCharacter?: number
  ) {
    if (typeof startOrLine === 'number' && typeof endOrStartCharacter === 'number') {
      this.start = new Position(startOrLine, endOrStartCharacter);
      this.end = new Position(endLine ?? startOrLine, endCharacter ?? endOrStartCharacter);
      return;
    }
    this.start = startOrLine as Position;
    this.end = endOrStartCharacter as Position;
  }
}

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  async executeCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
    return await commandHandlers.get(command)?.(...args) as T | undefined;
  }
};

export const extensions = {
  getExtension<T>(_id: string): T | undefined {
    void _id;
    return undefined;
  }
};

export function setCommandHandler(command: string, handler: (...args: unknown[]) => unknown): void {
  commandHandlers.set(command, handler);
}

export function clearCommandHandlers(): void {
  commandHandlers.clear();
}

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
    public readonly path: string
  ) {}

  public static file(filePath: string): Uri {
    const absolutePath = path.resolve(filePath);
    return new Uri('file', absolutePath, absolutePath);
  }

  public static parse(value: string): Uri {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      return Uri.file(fileURLToPath(url));
    }
    return new Uri(url.protocol.replace(/:$/u, ''), '', url.pathname);
  }

  public static joinPath(base: Uri, ...segments: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...segments));
  }

  public with(change: { scheme?: string; path?: string }): Uri {
    if ((change.scheme ?? this.scheme) === 'file') {
      return Uri.file(change.path ?? this.path);
    }
    return new Uri(change.scheme ?? this.scheme, this.fsPath, change.path ?? this.path);
  }

  public toString(): string {
    if (this.scheme === 'file') {
      return pathToFileURL(this.fsPath).toString();
    }
    return `${this.scheme}:${this.path}`;
  }
}

export class RelativePattern {
  public readonly baseUri: Uri;

  public constructor(
    base: Uri | { uri: Uri } | string,
    public readonly pattern: string
  ) {
    this.baseUri = typeof base === 'string'
      ? Uri.file(base)
      : base instanceof Uri
        ? base
        : base.uri;
  }
}

export class TabInputText {
  public constructor(public readonly uri: Uri) {}
}

export class TabInputCustom {
  public constructor(public readonly uri: Uri) {}
}

export class TabInputNotebook {
  public constructor(public readonly uri: Uri) {}
}

export class TabInputTextDiff {
  public constructor(public readonly original: Uri, public readonly modified: Uri) {}
}

export class TabInputNotebookDiff {
  public constructor(public readonly original: Uri, public readonly modified: Uri) {}
}

export interface TestTab {
  input: TabInputText | TabInputCustom | TabInputNotebook | TabInputTextDiff | TabInputNotebookDiff;
  isActive?: boolean;
  isDirty?: boolean;
}

export interface TestTabGroup {
  tabs: TestTab[];
}

export interface TestTerminalRecord {
  name: string;
  showCount: number;
  disposeCount: number;
}

export const createdTerminals: TestTerminalRecord[] = [];

export function clearCreatedTerminals(): void {
  createdTerminals.splice(0, createdTerminals.length);
}

export const window = {
  createTerminal(options: { name: string; pty?: { open(): void; close(): void } }) {
    const record: TestTerminalRecord = {
      name: options.name,
      showCount: 0,
      disposeCount: 0
    };
    createdTerminals.push(record);
    options.pty?.open();
    return {
      name: options.name,
      show() { record.showCount += 1; },
      dispose() {
        record.disposeCount += 1;
        options.pty?.close();
      }
    };
  },
  tabGroups: {
    all: [] as TestTabGroup[],
    async close(tabs: readonly TestTab[]): Promise<boolean> {
      const closing = new Set(tabs);
      for (const group of window.tabGroups.all) {
        group.tabs = group.tabs.filter((tab) => !closing.has(tab));
      }
      return true;
    }
  },
  async showTextDocument(document: TextDocument): Promise<TextDocument> {
    return document;
  },
  async showWarningMessage<T extends string>(
    _message: string,
    ..._items: unknown[]
  ): Promise<T | undefined> {
    return undefined;
  }
};

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name?: string }>,
  workspaceFile: undefined as Uri | undefined,
  textDocuments: [] as TextDocument[],
  name: 'KeepSeek Test Workspace',
  isTrusted: true,
  fs: {
    async stat(uri: Uri) {
      const stat = await fs.stat(uri.fsPath);
      return {
        type: stat.isFile() ? FileType.File : stat.isDirectory() ? FileType.Directory : FileType.Unknown,
        size: stat.size
      };
    },
    async readDirectory(uri: Uri): Promise<Array<[string, number]>> {
      const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((entry) => [
        entry.name,
        entry.isFile() ? FileType.File : entry.isDirectory() ? FileType.Directory : FileType.Unknown
      ]);
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      return await fs.readFile(uri.fsPath);
    },
    async createDirectory(uri: Uri): Promise<void> {
      await fs.mkdir(uri.fsPath, { recursive: true });
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content);
    },
    async rename(source: Uri, target: Uri, _options?: { overwrite?: boolean }): Promise<void> {
      await fs.rename(source.fsPath, target.fsPath);
    },
    async delete(uri: Uri, options?: { recursive?: boolean }): Promise<void> {
      await fs.rm(uri.fsPath, {
        recursive: options?.recursive === true,
        force: false
      });
    }
  },
  getConfiguration() {
    return {
      get<T>(_key: string, fallback: T): T {
        return fallback;
      },
      async update(): Promise<void> {
        return undefined;
      }
    };
  },
  getWorkspaceFolder(uri: Uri) {
    const normalizedPath = path.resolve(uri.fsPath);
    return workspace.workspaceFolders.find((folder) => {
      const normalizedRoot = path.resolve(folder.uri.fsPath);
      return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${path.sep}`);
    });
  },
  asRelativePath(uriOrPath: Uri | string, includeWorkspaceFolder = false): string {
    const uri = typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath;
    const folder = workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return uri.fsPath || uri.path;
    }

    const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    return includeWorkspaceFolder && folder.name ? `${folder.name}/${relativePath}` : relativePath;
  },
  async findFiles(
    include: string | RelativePattern,
    exclude?: string | RelativePattern | null,
    maxResults?: number
  ): Promise<Uri[]> {
    const includePattern = typeof include === 'string' ? include : include.pattern;
    const roots = typeof include === 'string'
      ? workspace.workspaceFolders.map((folder) => folder.uri)
      : [include.baseUri];
    const limit = typeof maxResults === 'number' && Number.isFinite(maxResults)
      ? Math.max(0, Math.floor(maxResults))
      : Number.POSITIVE_INFINITY;
    const results: Uri[] = [];

    for (const root of roots) {
      const visit = async (directory: Uri): Promise<void> => {
        if (results.length >= limit) {
          return;
        }
        const entries = await fs.readdir(directory.fsPath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (results.length >= limit) {
            return;
          }
          const entryPath = path.join(directory.fsPath, entry.name);
          if (entry.isDirectory()) {
            await visit(Uri.file(entryPath));
            continue;
          }
          if (!entry.isFile()) {
            continue;
          }
          const relativePath = path.relative(root.fsPath, entryPath).split(path.sep).join('/');
          if (!matchesGlob(relativePath, includePattern) || matchesExclude(relativePath, exclude)) {
            continue;
          }
          results.push(Uri.file(entryPath));
        }
      };
      await visit(root);
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  },
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    const content = await fs.readFile(uri.fsPath, 'utf8');
    const document = new TextDocument(uri, content);
    workspace.textDocuments.push(document);
    return document;
  }
};

export const ConfigurationTarget = {
  Global: 1
};

export class TextDocument {
  public readonly languageId: string;
  private readonly lines: string[];
  public isDirty = false;

  public constructor(
    public readonly uri: Uri,
    private readonly content: string
  ) {
    this.languageId = getLanguageId(uri.fsPath);
    this.lines = content.replace(/\r\n?/gu, '\n').split('\n');
  }

  public get lineCount(): number {
    return this.lines.length;
  }

  public getText(range?: Range): string {
    if (!range) {
      return this.content;
    }

    const normalizedContent = this.content.replace(/\r\n?/gu, '\n');
    const offsets = getLineOffsets(normalizedContent);
    const start = (offsets[range.start.line] ?? normalizedContent.length) + range.start.character;
    const end = (offsets[range.end.line] ?? normalizedContent.length) + range.end.character;
    return normalizedContent.slice(start, end);
  }

  public lineAt(index: number): { text: string; range: { end: { character: number } } } {
    return {
      text: this.lines[index] ?? '',
      range: {
        end: {
          character: this.lines[index]?.length ?? 0
        }
      }
    };
  }
}

function getLanguageId(filePath: string): string {
  const extension = path.extname(filePath).replace(/^\./u, '');
  return extension || 'plaintext';
}

function getLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charAt(index) === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function matchesExclude(relativePath: string, exclude: string | RelativePattern | null | undefined): boolean {
  if (!exclude) {
    return false;
  }
  return matchesGlob(relativePath, typeof exclude === 'string' ? exclude : exclude.pattern);
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern.replace(/\\/gu, '/').replace(/^\/+/, '')).test(relativePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    if (character === '{') {
      const closingIndex = pattern.indexOf('}', index + 1);
      if (closingIndex > index) {
        const alternatives = pattern
          .slice(index + 1, closingIndex)
          .split(',')
          .map(escapeRegExp)
          .join('|');
        source += `(?:${alternatives})`;
        index = closingIndex;
        continue;
      }
    }
    source += escapeRegExp(character);
  }
  return new RegExp(`${source}$`, 'u');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
