import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredWorkspaceReadMaxBytes, getConfiguredWorkspaceToolFileLimit } from '../../shared/config';
import { formatBytes } from '../../shared/format';
import { isReadableTextContent, shouldSkipTextUri } from '../../shared/textFileGuards';
import type { KeepseekLanguage } from '../../shared/i18n';
import {
  getWorkspaceResourcePath,
  listWorkspaceDirectoryEntries,
  SKIPPED_WORKSPACE_DIRECTORY_NAMES,
  WORKSPACE_DIRECTORY_GLOB_EXCLUDE
} from '../../workspace/workspaceDirectory';
import { READ_WORKSPACE_FILE_RANGE_TOOL_NAME } from '../protocol';

const WORKSPACE_TOOL_EXCLUDED_DIRECTORIES = ['.git', '.vscode-test', 'build', 'coverage', 'dist', 'node_modules', 'out'];
const WORKSPACE_TOOL_GLOB_EXCLUDE = WORKSPACE_DIRECTORY_GLOB_EXCLUDE;
const DEFAULT_SEARCH_RESULT_LIMIT = 50;
const MAX_SEARCH_RESULT_LIMIT = 200;
const SEARCH_CONTEXT_BEFORE_LINES = 2;
const SEARCH_CONTEXT_AFTER_LINES = 2;
const SEARCH_LINE_MAX_CHARS = 500;
const SEARCH_CONTEXT_MAX_BYTES = 32_000;
const SEARCH_RESULT_TOTAL_CHAR_LIMIT = 60_000;
const SEARCH_FALLBACK_MAX_READ_BYTES = 1_000_000;
const DEFAULT_RANGE_READ_MAX_BYTES = 64_000;
const MAX_RANGE_READ_MAX_BYTES = 200_000;
const MAX_RANGE_READ_LINES = 5_000;
const STREAM_READ_CHUNK_BYTES = 64 * 1024;
const READABILITY_SAMPLE_CHARS = 8192;
const BINARY_PREFIX_BYTES = 4096;

export interface WorkspaceSearchInput {
  query: string;
  path?: string;
  include?: string;
  isRegex?: boolean;
  matchCase?: boolean;
  maxResults?: number;
}

export interface WorkspaceFileRangeInput {
  path: string;
  startLine: number;
  endLine: number;
  maxBytes?: number;
}

interface WorkspaceTextSearchQuery {
  pattern: string;
  isRegExp?: boolean;
  isCaseSensitive?: boolean;
}

interface WorkspaceTextSearchOptions {
  include?: vscode.GlobPattern;
  exclude?: vscode.GlobPattern;
  maxResults?: number;
}

interface WorkspaceTextSearchResult {
  uri: vscode.Uri;
  ranges?: vscode.Range | readonly vscode.Range[];
  preview?: {
    text?: string;
    matches?: vscode.Range | readonly vscode.Range[];
  };
}

interface WorkspaceTextSearchApi {
  findTextInFiles?: (
    query: WorkspaceTextSearchQuery,
    options: WorkspaceTextSearchOptions,
    callback: (result: WorkspaceTextSearchResult) => void
  ) => PromiseLike<void>;
}

interface WorkspaceSearchScope {
  include?: vscode.GlobPattern;
  filterUri?: vscode.Uri;
}

interface WorkspaceSearchHit {
  uri: vscode.Uri;
  range: vscode.Range;
  previewText?: string;
}

interface WorkspaceSearchLine {
  line: number;
  text: string;
  truncated: boolean;
}

interface WorkspaceSearchResult {
  path: string;
  uri: string;
  line: number;
  startColumn: number;
  endColumn: number;
  matchLine: string;
  matchLineTruncated: boolean;
  before: WorkspaceSearchLine[];
  after: WorkspaceSearchLine[];
}

interface WorkspaceRangeReadData {
  path: string;
  uri: string;
  languageId: string;
  content: string;
  startLine: number;
  endLine: number;
  requestedStartLine: number;
  requestedEndLine: number;
  totalLines: number;
  truncated: boolean;
  sizeBytes?: number;
}

type InternalRangeReadData = Omit<
  WorkspaceRangeReadData,
  'path' | 'uri' | 'languageId' | 'requestedStartLine' | 'requestedEndLine' | 'sizeBytes'
>;
type TextEncoderLike = {
  encode(input?: string): Uint8Array;
};

export interface WorkspaceToolAdapter {
  listWorkspaceFiles(language: KeepseekLanguage): Promise<string>;
  listWorkspaceDirectory(rawPath: string, recursive: boolean, maxFiles: number | undefined, language: KeepseekLanguage): Promise<string>;
  searchWorkspace(input: WorkspaceSearchInput, language: KeepseekLanguage): Promise<string>;
  readWorkspaceFile(rawPath: string, language: KeepseekLanguage): Promise<string>;
  readWorkspaceFileRange(input: WorkspaceFileRangeInput, language: KeepseekLanguage): Promise<string>;
  resolveTargetUri(targetPath: string): vscode.Uri;
  getLabel(uri: vscode.Uri): string;
}

export class WorkspaceToolService implements WorkspaceToolAdapter {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly encoder = new TextEncoder();

  public async listWorkspaceFiles(language: KeepseekLanguage): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return JSON.stringify({
        ok: false,
        error: language === 'en'
          ? 'Open a workspace before listing project files.'
          : '请先打开一个工作区，再列出工程文件。'
      });
    }

    const includeWorkspaceFolder = folders.length > 1;
    const maxFiles = getConfiguredWorkspaceToolFileLimit();
    const files: Array<{
      path: string;
      label: string;
      workspaceFolder: string;
      sizeBytes: number;
      size: string;
      extension: string;
    }> = [];
    let truncated = false;

    for (const folder of folders) {
      const remaining = maxFiles - files.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        WORKSPACE_TOOL_GLOB_EXCLUDE,
        remaining
      );
      if (uris.length >= remaining) {
        truncated = true;
      }

      for (const uri of uris) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.File) {
            continue;
          }

          const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
          files.push({
            path: relativePath,
            label: path.basename(uri.fsPath || uri.path) || relativePath,
            workspaceFolder: folder.name,
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
            extension: path.extname(uri.fsPath || uri.path).toLowerCase()
          });
        } catch {
          // Skip files that disappeared or cannot be statted while listing.
        }
      }
    }

    files.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));

    return JSON.stringify({
      ok: true,
      files,
      count: files.length,
      limit: maxFiles,
      truncated,
      excluded: WORKSPACE_TOOL_EXCLUDED_DIRECTORIES,
      workspaceFolders: folders.map((folder) => ({
        name: folder.name,
        uri: folder.uri.toString()
      }))
    });
  }

  public async listWorkspaceDirectory(rawPath: string, recursive: boolean, maxFiles: number | undefined, language: KeepseekLanguage): Promise<string> {
    const uri = this.resolveWorkspacePathUri(rawPath);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.Directory) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en' ? 'The requested path is not a directory.' : '请求的路径不是目录。'
      });
    }

    const configuredLimit = getConfiguredWorkspaceToolFileLimit();
    const requestedLimit = normalizeDirectoryListLimit(maxFiles, 100);
    const limit = Math.min(configuredLimit, requestedLimit);
    const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const listing = await listWorkspaceDirectoryEntries(uri, {
      recursive,
      maxEntries: limit,
      maxDepth: 8,
      includeWorkspaceFolder
    });

    return JSON.stringify({
      ok: true,
      path: getWorkspaceResourcePath(uri, includeWorkspaceFolder),
      uri: uri.toString(),
      recursive,
      entries: listing.entries,
      count: listing.entries.length,
      limit,
      truncated: listing.truncated,
      excluded: WORKSPACE_TOOL_EXCLUDED_DIRECTORIES
    });
  }

  public async searchWorkspace(input: WorkspaceSearchInput, language: KeepseekLanguage): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return JSON.stringify({
        ok: false,
        error: language === 'en'
          ? 'Open a workspace before searching project files.'
          : '请先打开一个工作区，再搜索工程文件。'
      });
    }

    const query = input.query.trim();
    if (!query) {
      return JSON.stringify({
        ok: false,
        error: language === 'en' ? 'Search query cannot be empty.' : '搜索关键词不能为空。'
      });
    }
    if (input.isRegex) {
      try {
        new RegExp(query);
      } catch (error) {
        return JSON.stringify({
          ok: false,
          query,
          error: language === 'en'
            ? `Search regex is invalid: ${error instanceof Error ? error.message : String(error)}`
            : `搜索正则表达式无效：${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    const limit = normalizeSearchResultLimit(input.maxResults);
    const scope = await this.resolveSearchScope(input.path, input.include);
    const hits = await this.collectSearchHits(input, scope, limit);
    const results: WorkspaceSearchResult[] = [];
    let truncated = hits.truncated;
    let totalChars = 0;

    for (const hit of hits.hits) {
      if (results.length >= limit || totalChars >= SEARCH_RESULT_TOTAL_CHAR_LIMIT) {
        truncated = true;
        break;
      }
      const result = await this.createSearchResult(hit, language);
      if (!result) {
        continue;
      }

      const shapedResultChars = JSON.stringify(result).length;
      if (totalChars + shapedResultChars > SEARCH_RESULT_TOTAL_CHAR_LIMIT) {
        truncated = true;
        break;
      }
      totalChars += shapedResultChars;
      results.push(result);
    }

    return JSON.stringify({
      ok: true,
      query,
      results,
      count: results.length,
      limit,
      truncated: truncated || results.length >= limit,
      excluded: WORKSPACE_TOOL_EXCLUDED_DIRECTORIES
    });
  }

  public async readWorkspaceFile(rawPath: string, language: KeepseekLanguage): Promise<string> {
    const uri = this.resolveWorkspacePathUri(rawPath);

    if (shouldSkipTextUri(uri)) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en'
          ? 'This file type is not read as text by KeepSeek.'
          : 'KeepSeek 不会把这种文件类型作为文本读取。'
      });
    }

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en' ? 'The requested path is not a regular file.' : '请求的路径不是普通文件。'
      });
    }

    const maxBytes = getConfiguredWorkspaceReadMaxBytes();
    if (stat.size > maxBytes) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        sizeBytes: stat.size,
        limitBytes: maxBytes,
        suggestedTool: READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
        suggestedRange: {
          path: this.getLabel(uri),
          startLine: 1,
          endLine: 200,
          maxBytes: Math.min(maxBytes, DEFAULT_RANGE_READ_MAX_BYTES)
        },
        error: language === 'en'
          ? `File is larger than the full-read limit (${formatBytes(maxBytes)}). Use ${READ_WORKSPACE_FILE_RANGE_TOOL_NAME} to read a smaller line range.`
          : `文件超过全文读取上限（${formatBytes(maxBytes)}）。请使用 ${READ_WORKSPACE_FILE_RANGE_TOOL_NAME} 读取较小的行范围。`
      });
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = this.decodeWorkspaceText(bytes, uri, language);
    const encodedSize = this.encoder.encode(content).byteLength;
    if (encodedSize > maxBytes) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        sizeBytes: encodedSize,
        limitBytes: maxBytes,
        suggestedTool: READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
        suggestedRange: {
          path: this.getLabel(uri),
          startLine: 1,
          endLine: 200,
          maxBytes: Math.min(maxBytes, DEFAULT_RANGE_READ_MAX_BYTES)
        },
        error: language === 'en'
          ? `Decoded text is larger than the full-read limit (${formatBytes(maxBytes)}). Use ${READ_WORKSPACE_FILE_RANGE_TOOL_NAME} to read a smaller line range.`
          : `解码后的文本超过全文读取上限（${formatBytes(maxBytes)}）。请使用 ${READ_WORKSPACE_FILE_RANGE_TOOL_NAME} 读取较小的行范围。`
      });
    }

    const languageId = await this.detectLanguageId(uri);
    return JSON.stringify({
      ok: true,
      path: this.getLabel(uri),
      uri: uri.toString(),
      languageId,
      sizeBytes: encodedSize,
      size: formatBytes(encodedSize),
      content
    });
  }

  public async readWorkspaceFileRange(input: WorkspaceFileRangeInput, language: KeepseekLanguage): Promise<string> {
    try {
      const uri = this.resolveWorkspacePathUri(input.path);
      const range = this.normalizeRangeInput(input.startLine, input.endLine, input.maxBytes);
      const data = await this.readWorkspaceFileRangeData(
        uri,
        range.startLine,
        range.endLine,
        range.maxBytes,
        language,
        Math.floor(input.endLine),
        range.lineRangeTruncated
      );
      return JSON.stringify({
        ok: true,
        ...data
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        path: input.path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  public resolveTargetUri(targetPath: string): vscode.Uri {
    if (/^file:/iu.test(targetPath)) {
      return vscode.Uri.parse(targetPath);
    }

    if (path.isAbsolute(targetPath)) {
      return vscode.Uri.file(targetPath);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return vscode.Uri.file(path.resolve(targetPath));
    }

    return vscode.Uri.joinPath(workspaceRoot, ...targetPath.split(/[\\/]+/).filter(Boolean));
  }

  public getLabel(uri: vscode.Uri): string {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.fsPath;
  }

  private async collectSearchHits(
    input: WorkspaceSearchInput,
    scope: WorkspaceSearchScope,
    limit: number
  ): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    const textSearchApi = vscode.workspace as unknown as WorkspaceTextSearchApi;
    if (typeof textSearchApi.findTextInFiles === 'function') {
      return await this.collectSearchHitsWithVsCode(textSearchApi.findTextInFiles.bind(vscode.workspace), input, scope, limit);
    }

    return await this.collectSearchHitsWithFallback(input, scope, limit);
  }

  private async collectSearchHitsWithVsCode(
    findTextInFiles: NonNullable<WorkspaceTextSearchApi['findTextInFiles']>,
    input: WorkspaceSearchInput,
    scope: WorkspaceSearchScope,
    limit: number
  ): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    const hits: WorkspaceSearchHit[] = [];
    let truncated = false;
    await findTextInFiles(
      {
        pattern: input.query,
        isRegExp: input.isRegex === true,
        isCaseSensitive: input.matchCase === true
      },
      {
        include: scope.include,
        exclude: WORKSPACE_TOOL_GLOB_EXCLUDE,
        maxResults: limit
      },
      (result) => {
        if (!this.canUseSearchUri(result.uri, scope.filterUri)) {
          return;
        }
        const ranges = normalizeRanges(result.ranges);
        for (const range of ranges) {
          if (hits.length >= limit) {
            truncated = true;
            return;
          }
          hits.push({
            uri: result.uri,
            range,
            previewText: result.preview?.text
          });
        }
      }
    );

    return {
      hits,
      truncated: truncated || hits.length >= limit
    };
  }

  private async collectSearchHitsWithFallback(
    input: WorkspaceSearchInput,
    scope: WorkspaceSearchScope,
    limit: number
  ): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    const include = scope.include ?? '**/*';
    const uris = await vscode.workspace.findFiles(include, WORKSPACE_TOOL_GLOB_EXCLUDE, getConfiguredWorkspaceToolFileLimit());
    const hits: WorkspaceSearchHit[] = [];
    let truncated = false;
    const matcher = createSearchMatcher(input.query, input.isRegex === true, input.matchCase === true);

    for (const uri of uris.sort((left, right) => this.getLabel(left).localeCompare(this.getLabel(right), undefined, { sensitivity: 'base' }))) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      if (!this.canUseSearchUri(uri, scope.filterUri) || shouldSkipTextUri(uri)) {
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File || stat.size > SEARCH_FALLBACK_MAX_READ_BYTES) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = this.decodeWorkspaceText(bytes, uri, 'en').replace(/\r\n?/gu, '\n');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
          matcher.lastIndex = 0;
          let match = matcher.exec(lines[index] ?? '');
          while (match && hits.length < limit) {
            const startCharacter = match.index;
            const endCharacter = startCharacter + Math.max(match[0].length, 1);
            hits.push({
              uri,
              range: new vscode.Range(index, startCharacter, index, endCharacter),
              previewText: lines[index]
            });
            if (!matcher.global) {
              break;
            }
            if (match[0].length === 0) {
              matcher.lastIndex += 1;
            }
            match = matcher.exec(lines[index] ?? '');
          }
        }
      } catch {
        // Skip files that cannot be read safely by the fallback search path.
      }
    }

    return {
      hits,
      truncated: truncated || hits.length >= limit
    };
  }

  private async createSearchResult(hit: WorkspaceSearchHit, language: KeepseekLanguage): Promise<WorkspaceSearchResult | undefined> {
    if (shouldSkipTextUri(hit.uri)) {
      return undefined;
    }

    const line = hit.range.start.line + 1;
    const contextStartLine = Math.max(1, line - SEARCH_CONTEXT_BEFORE_LINES);
    const contextEndLine = line + SEARCH_CONTEXT_AFTER_LINES;
    let context: WorkspaceRangeReadData | undefined;
    try {
      context = await this.readWorkspaceFileRangeData(hit.uri, contextStartLine, contextEndLine, SEARCH_CONTEXT_MAX_BYTES, language);
    } catch {
      context = undefined;
    }

    const contextLines = context?.content.split('\n') ?? [];
    const contextLineStart = context?.startLine ?? line;
    const rawMatchLine = context
      ? contextLines[line - contextLineStart] ?? hit.previewText ?? ''
      : hit.previewText ?? '';
    const matchLine = shapeSearchLine(rawMatchLine);
    const before = context
      ? contextLines
        .slice(0, Math.max(0, line - contextLineStart))
        .map((text, index) => toSearchLine(contextLineStart + index, text))
      : [];
    const afterStartIndex = context ? line - contextLineStart + 1 : 0;
    const after = context
      ? contextLines
        .slice(afterStartIndex, afterStartIndex + SEARCH_CONTEXT_AFTER_LINES)
        .map((text, index) => toSearchLine(line + 1 + index, text))
      : [];

    return {
      path: this.getLabel(hit.uri),
      uri: hit.uri.toString(),
      line,
      startColumn: hit.range.start.character + 1,
      endColumn: Math.max(hit.range.start.character + 1, hit.range.end.character + 1),
      matchLine: matchLine.text,
      matchLineTruncated: matchLine.truncated,
      before,
      after
    };
  }

  private async resolveSearchScope(rawPath: string | undefined, rawInclude: string | undefined): Promise<WorkspaceSearchScope> {
    if (rawPath?.trim()) {
      const uri = this.resolveWorkspacePathUri(rawPath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File && stat.type !== vscode.FileType.Directory) {
        throw new Error('Search path must be a workspace file or directory.');
      }
      return {
        include: this.createIncludePatternForUri(uri, stat.type),
        filterUri: uri
      };
    }

    const include = normalizeSearchInclude(rawInclude);
    return include ? { include } : {};
  }

  private createIncludePatternForUri(uri: vscode.Uri, fileType: vscode.FileType): vscode.GlobPattern {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      throw new Error('Search path must be inside the currently open workspace.');
    }
    const relativePath = this.getRelativePathWithinWorkspaceFolder(uri, folder);
    if (fileType === vscode.FileType.Directory) {
      return new vscode.RelativePattern(folder, relativePath ? `${relativePath}/**/*` : '**/*');
    }
    return new vscode.RelativePattern(folder, relativePath);
  }

  private canUseSearchUri(uri: vscode.Uri, filterUri: vscode.Uri | undefined): boolean {
    if (!this.isUriInsideWorkspace(uri) || this.isUriInsideSkippedWorkspaceDirectory(uri)) {
      return false;
    }
    if (!filterUri || filterUri.toString() === uri.toString()) {
      return true;
    }
    return this.isUriInsideUri(uri, filterUri);
  }

  private resolveWorkspacePathUri(rawPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      throw new Error('Open a workspace before reading project files.');
    }

    const uri = this.resolveWorkspaceFileUriCandidate(rawPath, folders);
    if (!this.isUriInsideWorkspace(uri)) {
      throw new Error('The requested file must be inside the currently open workspace.');
    }
    return uri;
  }

  private resolveWorkspaceFileUriCandidate(rawPath: string, folders: readonly vscode.WorkspaceFolder[]): vscode.Uri {
    if (/^file:/iu.test(rawPath) || /^[a-z][a-z\d+.-]*:\/\//iu.test(rawPath)) {
      return vscode.Uri.parse(rawPath);
    }

    if (path.isAbsolute(rawPath)) {
      return vscode.Uri.file(rawPath);
    }

    const normalizedPath = rawPath.replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (!normalizedPath || normalizedPath.includes('\0')) {
      throw new Error('Workspace file path cannot be empty.');
    }

    if (folders.length > 1) {
      for (const folder of folders) {
        const folderPrefix = `${folder.name}/`;
        if (normalizedPath === folder.name || normalizedPath.startsWith(folderPrefix)) {
          const pathWithinFolder = normalizedPath === folder.name
            ? ''
            : normalizedPath.slice(folderPrefix.length);
          return vscode.Uri.joinPath(folder.uri, ...pathWithinFolder.split('/').filter(Boolean));
        }
      }
    }

    return vscode.Uri.joinPath(folders[0].uri, ...normalizedPath.split('/').filter(Boolean));
  }

  private isUriInsideWorkspace(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return false;
    }

    if (uri.scheme === 'file' && folder.uri.scheme === 'file') {
      const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
      return relativePath === '' || (Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    return true;
  }

  private isUriInsideUri(uri: vscode.Uri, parentUri: vscode.Uri): boolean {
    if (uri.scheme === 'file' && parentUri.scheme === 'file') {
      const relativePath = path.relative(parentUri.fsPath, uri.fsPath);
      return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    }

    const parentPath = parentUri.path.endsWith('/') ? parentUri.path : `${parentUri.path}/`;
    return uri.path.startsWith(parentPath);
  }

  private isUriInsideSkippedWorkspaceDirectory(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return false;
    }
    return this.getRelativePathWithinWorkspaceFolder(uri, folder)
      .split('/')
      .some((segment) => SKIPPED_WORKSPACE_DIRECTORY_NAMES.has(segment));
  }

  private getRelativePathWithinWorkspaceFolder(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string {
    if (uri.scheme === 'file' && folder.uri.scheme === 'file') {
      return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    }

    const folderPath = folder.uri.path.endsWith('/') ? folder.uri.path : `${folder.uri.path}/`;
    return uri.path.startsWith(folderPath)
      ? uri.path.slice(folderPath.length)
      : vscode.workspace.asRelativePath(uri, false).split('\\').join('/');
  }

  private normalizeRangeInput(startLine: number, endLine: number, maxBytes: number | undefined): {
    startLine: number;
    endLine: number;
    maxBytes: number;
    lineRangeTruncated: boolean;
  } {
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      throw new Error('startLine and endLine must be finite numbers.');
    }
    const normalizedStartLine = Math.floor(startLine);
    const requestedEndLine = Math.floor(endLine);
    if (normalizedStartLine < 1) {
      throw new Error('startLine must be greater than or equal to 1.');
    }
    if (requestedEndLine < normalizedStartLine) {
      throw new Error('endLine must be greater than or equal to startLine.');
    }

    const effectiveEndLine = Math.min(requestedEndLine, normalizedStartLine + MAX_RANGE_READ_LINES - 1);
    return {
      startLine: normalizedStartLine,
      endLine: effectiveEndLine,
      maxBytes: normalizeRangeReadMaxBytes(maxBytes),
      lineRangeTruncated: effectiveEndLine < requestedEndLine
    };
  }

  private async readWorkspaceFileRangeData(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    maxBytes: number,
    language: KeepseekLanguage,
    requestedEndLine = endLine,
    lineRangeTruncated = false
  ): Promise<WorkspaceRangeReadData> {
    if (shouldSkipTextUri(uri)) {
      throw new Error(language === 'en'
        ? 'This file type is not read as text by KeepSeek.'
        : 'KeepSeek 不会把这种文件类型作为文本读取。');
    }

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error(language === 'en' ? 'The requested path is not a regular file.' : '请求的路径不是普通文件。');
    }

    const scan = uri.scheme === 'file'
      ? await this.readFileRangeFromFileSystem(uri, startLine, endLine, maxBytes, language)
      : await this.readFileRangeFromWorkspaceFs(uri, startLine, endLine, maxBytes, language, stat.size);

    return {
      ...scan,
      path: this.getLabel(uri),
      uri: uri.toString(),
      languageId: await this.detectLanguageId(uri),
      requestedStartLine: startLine,
      requestedEndLine,
      truncated: scan.truncated || lineRangeTruncated,
      sizeBytes: stat.size
    };
  }

  private async readFileRangeFromWorkspaceFs(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    maxBytes: number,
    language: KeepseekLanguage,
    sizeBytes: number
  ): Promise<InternalRangeReadData> {
    const fallbackLimit = Math.min(getConfiguredWorkspaceReadMaxBytes(), Math.max(maxBytes, DEFAULT_RANGE_READ_MAX_BYTES));
    if (sizeBytes > fallbackLimit) {
      throw new Error(language === 'en'
        ? `Range reading for ${uri.scheme} resources is limited to files up to ${formatBytes(fallbackLimit)}.`
        : `${uri.scheme} 资源的范围读取仅支持不超过 ${formatBytes(fallbackLimit)} 的文件。`);
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = this.decodeWorkspaceText(bytes, uri, language);
    return this.readFileRangeFromText(content, startLine, endLine, maxBytes);
  }

  private async readFileRangeFromFileSystem(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
    maxBytes: number,
    language: KeepseekLanguage
  ): Promise<InternalRangeReadData> {
    const accumulator = new RangeContentAccumulator(this.encoder, startLine, endLine, maxBytes);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let carry = '';
    let pendingCarriageReturn = false;
    let sawContent = false;
    let prefixBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let readabilitySample = '';

    const processText = (value: string): void => {
      if (!value) {
        return;
      }
      sawContent = true;
      let text = value;
      if (pendingCarriageReturn) {
        if (text.startsWith('\n')) {
          text = text.slice(1);
        }
        text = `\n${text}`;
        pendingCarriageReturn = false;
      }
      if (text.endsWith('\r')) {
        pendingCarriageReturn = true;
        text = text.slice(0, -1);
      }
      const normalizedText = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
      const parts = `${carry}${normalizedText}`.split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        accumulator.processLine(line);
      }
    };

    for await (const chunk of createReadStream(uri.fsPath, { highWaterMark: STREAM_READ_CHUNK_BYTES })) {
      const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : new Uint8Array(chunk);
      prefixBytes = appendBytes(prefixBytes, bytes, BINARY_PREFIX_BYTES);
      if (prefixBytes.includes(0)) {
        throw new Error(language === 'en'
          ? `${this.getLabel(uri)} appears to be binary and was not read.`
          : `${this.getLabel(uri)} 看起来是二进制文件，已跳过读取。`);
      }

      const decoded = decoder.decode(bytes, { stream: true });
      if (readabilitySample.length < READABILITY_SAMPLE_CHARS) {
        readabilitySample = `${readabilitySample}${decoded}`.slice(0, READABILITY_SAMPLE_CHARS);
      }
      processText(decoded);
    }

    const finalText = decoder.decode();
    if (readabilitySample.length < READABILITY_SAMPLE_CHARS) {
      readabilitySample = `${readabilitySample}${finalText}`.slice(0, READABILITY_SAMPLE_CHARS);
    }
    processText(finalText);
    if (pendingCarriageReturn) {
      accumulator.processLine(carry);
      carry = '';
      accumulator.finishAfterTrailingLineBreak(true);
    } else if (carry) {
      accumulator.processLine(carry);
    } else {
      accumulator.finishAfterTrailingLineBreak(sawContent);
    }

    if (!isReadableTextContent(readabilitySample)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} does not look like readable text.`
        : `${this.getLabel(uri)} 看起来不是可读文本。`);
    }

    return accumulator.toResult();
  }

  private readFileRangeFromText(content: string, startLine: number, endLine: number, maxBytes: number): InternalRangeReadData {
    const normalizedContent = content.replace(/\r\n?/gu, '\n');
    const lines = normalizedContent.split('\n');
    const accumulator = new RangeContentAccumulator(this.encoder, startLine, endLine, maxBytes);
    for (const line of lines) {
      accumulator.processLine(line);
    }
    accumulator.finishWithKnownTotalLines(lines.length);
    return accumulator.toResult();
  }

  private decodeWorkspaceText(bytes: Uint8Array, uri: vscode.Uri, language: KeepseekLanguage): string {
    const prefix = bytes.subarray(0, Math.min(bytes.length, BINARY_PREFIX_BYTES));
    if (prefix.includes(0)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} appears to be binary and was not read.`
        : `${this.getLabel(uri)} 看起来是二进制文件，已跳过读取。`);
    }

    const content = this.decoder.decode(bytes);
    if (!isReadableTextContent(content)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} does not look like readable text.`
        : `${this.getLabel(uri)} 看起来不是可读文本。`);
    }
    return content;
  }

  private async detectLanguageId(uri: vscode.Uri): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.languageId;
    } catch {
      return 'plaintext';
    }
  }
}

function normalizeDirectoryListLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), 2000);
}

function normalizeSearchResultLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_RESULT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_SEARCH_RESULT_LIMIT);
}

function normalizeRangeReadMaxBytes(value: number | undefined): number {
  const configuredLimit = getConfiguredWorkspaceReadMaxBytes();
  const upperLimit = Math.min(configuredLimit, MAX_RANGE_READ_MAX_BYTES);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(DEFAULT_RANGE_READ_MAX_BYTES, upperLimit);
  }
  return Math.min(Math.max(Math.floor(value), 1), upperLimit);
}

function normalizeSearchInclude(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/gu, '/').replace(/^\/+/u, '');
  if (!normalized) {
    return undefined;
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(normalized) || path.isAbsolute(normalized) || normalized.includes('\0')) {
    throw new Error('Search include must be a workspace-relative glob.');
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('Search include cannot traverse outside the workspace.');
  }
  return normalized;
}

function normalizeRanges(value: vscode.Range | readonly vscode.Range[] | undefined): vscode.Range[] {
  if (!value) {
    return [];
  }
  return value instanceof vscode.Range ? [value] : [...value];
}

function shapeSearchLine(value: string): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r\n?/gu, ' ');
  if (normalized.length <= SEARCH_LINE_MAX_CHARS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, SEARCH_LINE_MAX_CHARS)}...`,
    truncated: true
  };
}

function toSearchLine(line: number, text: string): WorkspaceSearchLine {
  const shaped = shapeSearchLine(text);
  return {
    line,
    text: shaped.text,
    truncated: shaped.truncated
  };
}

function createSearchMatcher(query: string, isRegex: boolean, matchCase: boolean): RegExp {
  const source = isRegex ? query : escapeRegExp(query);
  return new RegExp(source, matchCase ? 'gu' : 'giu');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
  limit: number
): Uint8Array<ArrayBufferLike> {
  if (left.length >= limit) {
    return left;
  }
  const remaining = limit - left.length;
  const next = right.subarray(0, Math.min(remaining, right.length));
  const combined = new Uint8Array(left.length + next.length);
  combined.set(left, 0);
  combined.set(next, left.length);
  return combined;
}

class RangeContentAccumulator {
  private content = '';
  private bytesUsed = 0;
  private nextLine = 1;
  private totalLines = 1;
  private lastIncludedLine = 0;
  private truncated = false;

  public constructor(
    private readonly encoder: TextEncoderLike,
    private readonly startLine: number,
    private readonly endLine: number,
    private readonly maxBytes: number
  ) {}

  public processLine(line: string): void {
    const lineNumber = this.nextLine;
    this.nextLine += 1;
    this.totalLines = lineNumber;

    if (lineNumber < this.startLine || lineNumber > this.endLine || this.truncated) {
      return;
    }

    const nextText = `${this.content ? '\n' : ''}${line}`;
    const nextBytes = this.encoder.encode(nextText).byteLength;
    if (this.bytesUsed + nextBytes <= this.maxBytes) {
      this.content += nextText;
      this.bytesUsed += nextBytes;
      this.lastIncludedLine = lineNumber;
      return;
    }

    const remainingBytes = this.maxBytes - this.bytesUsed;
    if (remainingBytes > 0) {
      const partial = truncateToUtf8Bytes(nextText, remainingBytes, this.encoder);
      this.content += partial;
      this.bytesUsed += this.encoder.encode(partial).byteLength;
      this.lastIncludedLine = lineNumber;
    }
    this.truncated = true;
  }

  public finishAfterTrailingLineBreak(sawContent: boolean): void {
    if (sawContent && this.nextLine > 1) {
      this.totalLines = this.nextLine;
      return;
    }
    this.totalLines = Math.max(1, this.nextLine - 1);
  }

  public finishWithKnownTotalLines(totalLines: number): void {
    this.totalLines = Math.max(1, totalLines);
  }

  public toResult(): InternalRangeReadData {
    return {
      content: this.content,
      startLine: this.startLine,
      endLine: this.lastIncludedLine || Math.min(this.endLine, Math.max(this.startLine, this.totalLines)),
      totalLines: this.totalLines,
      truncated: this.truncated
    };
  }
}

function truncateToUtf8Bytes(value: string, maxBytes: number, encoder: TextEncoderLike): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (encoder.encode(value).byteLength <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}
