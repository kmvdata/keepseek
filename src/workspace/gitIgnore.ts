import createIgnore, { type Ignore } from 'ignore';

interface GitIgnoreLayer {
  relativeDirectory: string;
  matcher: Ignore;
}

export class WorkspaceGitIgnoreRules {
  private constructor(private readonly layers: readonly GitIgnoreLayer[]) {}

  public static empty(): WorkspaceGitIgnoreRules {
    return new WorkspaceGitIgnoreRules([]);
  }

  public add(relativeDirectory: string, source: string): WorkspaceGitIgnoreRules {
    const matcher = createIgnore().add(source);
    return new WorkspaceGitIgnoreRules([
      ...this.layers,
      {
        relativeDirectory: normalizeRelativePath(relativeDirectory),
        matcher
      }
    ]);
  }

  public isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalizedPath = normalizeRelativePath(relativePath);
    if (!normalizedPath) {
      return false;
    }

    let ignored = false;
    for (const layer of this.layers) {
      const localPath = getPathWithinLayer(normalizedPath, layer.relativeDirectory);
      if (!localPath) {
        continue;
      }

      const result = layer.matcher.test(isDirectory ? `${localPath}/` : localPath);
      if (result.ignored) {
        ignored = true;
      } else if (result.unignored) {
        ignored = false;
      }
    }
    return ignored;
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function getPathWithinLayer(relativePath: string, relativeDirectory: string): string | undefined {
  if (!relativeDirectory) {
    return relativePath;
  }

  const prefix = `${relativeDirectory}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : undefined;
}
