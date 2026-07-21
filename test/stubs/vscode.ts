import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
} as const;

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

export class Range {
  public constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
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

  public toString(): string {
    if (this.scheme === 'file') {
      return pathToFileURL(this.fsPath).toString();
    }
    return `${this.scheme}:${this.path}`;
  }
}

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri; name?: string }>,
  workspaceFile: undefined as Uri | undefined,
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
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    const content = await fs.readFile(uri.fsPath, 'utf8');
    return new TextDocument(uri, content);
  }
};

export const ConfigurationTarget = {
  Global: 1
};

class TextDocument {
  public readonly languageId: string;
  private readonly lines: string[];

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
