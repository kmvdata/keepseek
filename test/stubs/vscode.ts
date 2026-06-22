import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
} as const;

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
  fs: {
    async stat(uri: Uri) {
      const stat = await fs.stat(uri.fsPath);
      return {
        type: stat.isFile() ? FileType.File : stat.isDirectory() ? FileType.Directory : FileType.Unknown,
        size: stat.size
      };
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

  public lineAt(index: number): { range: { end: { character: number } } } {
    return {
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
