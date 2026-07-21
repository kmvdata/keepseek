import * as vscode from 'vscode';
import type { KeepseekLanguage } from '../../shared/i18n';
import { shouldSkipTextUri } from '../../shared/textFileGuards';
import type { WorkspaceToolAdapter } from './workspaceTools';

const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 200;
const PREVIEW_MAX_CHARS = 500;

export interface SemanticToolAdapter {
  findSymbol(input: { query: string; path?: string; maxResults?: number }, language: KeepseekLanguage): Promise<string>;
  findReferences(input: {
    path: string;
    line: number;
    column: number;
    includeDeclaration?: boolean;
    maxResults?: number;
  }, language: KeepseekLanguage): Promise<string>;
  getDocumentSymbols(input: { path: string; maxResults?: number }, language: KeepseekLanguage): Promise<string>;
  getWorkspaceSymbols(input: { query: string; maxResults?: number }, language: KeepseekLanguage): Promise<string>;
}

interface SemanticSymbolResult {
  name: string;
  kind: string;
  path: string;
  uri: string;
  range: SerializedRange;
  selectionRange?: SerializedRange;
  containerName?: string;
  detail?: string;
  preview?: string;
}

interface SerializedRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export class SemanticToolService implements SemanticToolAdapter {
  public constructor(private readonly workspaceTools: WorkspaceToolAdapter) {}

  public async findSymbol(
    input: { query: string; path?: string; maxResults?: number },
    language: KeepseekLanguage
  ): Promise<string> {
    const query = input.query.trim();
    if (!query) {
      return this.error(language, 'Symbol query cannot be empty.', 'Symbol 查询不能为空。');
    }
    if (input.path) {
      return await this.findDocumentSymbol(query, input.path, input.maxResults, language);
    }
    return await this.getWorkspaceSymbols({ query, maxResults: input.maxResults }, language);
  }

  public async findReferences(input: {
    path: string;
    line: number;
    column: number;
    includeDeclaration?: boolean;
    maxResults?: number;
  }, language: KeepseekLanguage): Promise<string> {
    const uri = this.resolveReadableWorkspaceUri(input.path);
    const document = await vscode.workspace.openTextDocument(uri);
    const line = normalizeOneBasedPosition(input.line, 'line');
    const column = normalizeOneBasedPosition(input.column, 'column');
    if (line > document.lineCount) {
      return this.error(language, 'The requested line is outside the document.', '请求的行号超出文档范围。');
    }
    const position = new vscode.Position(line - 1, column - 1);
    const limit = normalizeLimit(input.maxResults);
    const symbolName = getWordAtPosition(document, position);
    let providerReason: string | undefined;

    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        uri,
        position
      );
      if (Array.isArray(locations)) {
        const workspaceLocations = locations.filter((location) => Boolean(vscode.workspace.getWorkspaceFolder(location.uri)));
        const declarationKeys = input.includeDeclaration === true
          ? new Set<string>()
          : await this.getDefinitionLocationKeys(uri, position);
        const filteredLocations = workspaceLocations.filter((location) => !declarationKeys.has(getLocationKey(location.uri, location.range)));
        const results = await Promise.all(filteredLocations.slice(0, limit).map(async (location) => ({
          name: symbolName,
          kind: 'Reference',
          path: vscode.workspace.asRelativePath(location.uri, false),
          uri: location.uri.toString(),
          range: serializeRange(location.range),
          preview: await this.getPreview(location.uri, location.range)
        })));
        return JSON.stringify({
          ok: true,
          providerAvailable: true,
          fallback: false,
          symbolName,
          includeDeclaration: input.includeDeclaration === true,
          results,
          count: results.length,
          truncated: filteredLocations.length > results.length,
          excludedOutsideWorkspace: locations.length - workspaceLocations.length
        });
      }
      providerReason = 'VS Code returned no reference provider result for this document.';
    } catch (error) {
      providerReason = `VS Code reference provider failed: ${formatError(error)}`;
    }

    if (!symbolName) {
      return JSON.stringify({
        ok: false,
        providerAvailable: false,
        fallback: false,
        fallbackReason: providerReason,
        error: language === 'en'
          ? 'No symbol word was found at the requested position, so text-search fallback is unavailable.'
          : '请求位置没有可识别的 symbol，无法退化为文本搜索。'
      });
    }
    return await this.fallbackSearch(symbolName, input.path, limit, providerReason, language, 'Reference');
  }

  public async getDocumentSymbols(
    input: { path: string; maxResults?: number },
    language: KeepseekLanguage
  ): Promise<string> {
    const uri = this.resolveReadableWorkspaceUri(input.path);
    const limit = normalizeLimit(input.maxResults);
    let providerReason: string | undefined;
    try {
      const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );
      if (Array.isArray(symbols)) {
        const flattened: SemanticSymbolResult[] = [];
        await this.flattenDocumentSymbols(symbols, uri, flattened, limit);
        return JSON.stringify({
          ok: true,
          providerAvailable: true,
          fallback: false,
          path: vscode.workspace.asRelativePath(uri, false),
          results: flattened,
          count: flattened.length,
          truncated: flattened.length >= limit
        });
      }
      providerReason = 'VS Code returned no document symbol provider result for this file.';
    } catch (error) {
      providerReason = `VS Code document symbol provider failed: ${formatError(error)}`;
    }

    return await this.fallbackSearch(
      '(?:class|interface|type|enum|function|const|let|var|def|struct)\\s+[A-Za-z_$][\\w$]*',
      input.path,
      limit,
      providerReason,
      language,
      'Unknown',
      true
    );
  }

  public async getWorkspaceSymbols(
    input: { query: string; maxResults?: number },
    language: KeepseekLanguage
  ): Promise<string> {
    const query = input.query.trim();
    if (!query) {
      return this.error(language, 'Workspace symbol query cannot be empty.', 'Workspace symbol 查询不能为空。');
    }
    const limit = normalizeLimit(input.maxResults);
    let providerReason: string | undefined;
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      if (Array.isArray(symbols)) {
        const insideWorkspace = symbols.filter((symbol) => Boolean(vscode.workspace.getWorkspaceFolder(symbol.location.uri)));
        const results = await Promise.all(insideWorkspace.slice(0, limit).map((symbol) => this.serializeSymbolInformation(symbol)));
        return JSON.stringify({
          ok: true,
          providerAvailable: true,
          fallback: false,
          query,
          results,
          count: results.length,
          truncated: insideWorkspace.length > results.length
        });
      }
      providerReason = 'VS Code returned no workspace symbol provider result.';
    } catch (error) {
      providerReason = `VS Code workspace symbol provider failed: ${formatError(error)}`;
    }
    return await this.fallbackSearch(query, undefined, limit, providerReason, language, 'Unknown');
  }

  private async findDocumentSymbol(
    query: string,
    rawPath: string,
    maxResults: number | undefined,
    language: KeepseekLanguage
  ): Promise<string> {
    const raw = await this.getDocumentSymbols({ path: rawPath, maxResults: MAX_RESULT_LIMIT }, language);
    const parsed = safeParseRecord(raw);
    if (parsed?.ok === true && parsed.providerAvailable === true && Array.isArray(parsed.results)) {
      const normalizedQuery = query.toLocaleLowerCase();
      const matches = parsed.results
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .filter((item) => String(item.name ?? '').toLocaleLowerCase().includes(normalizedQuery))
        .slice(0, normalizeLimit(maxResults));
      return JSON.stringify({
        ok: true,
        providerAvailable: true,
        fallback: false,
        query,
        results: matches,
        count: matches.length,
        truncated: false
      });
    }
    return await this.fallbackSearch(query, rawPath, normalizeLimit(maxResults), String(parsed?.fallbackReason ?? 'Document symbol provider unavailable.'), language, 'Unknown');
  }

  private async flattenDocumentSymbols(
    symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
    documentUri: vscode.Uri,
    output: SemanticSymbolResult[],
    limit: number,
    inheritedContainer?: string
  ): Promise<void> {
    for (const symbol of symbols) {
      if (output.length >= limit) {
        return;
      }
      if (isSymbolInformation(symbol)) {
        if (vscode.workspace.getWorkspaceFolder(symbol.location.uri)) {
          output.push(await this.serializeSymbolInformation(symbol));
        }
        continue;
      }
      output.push({
        name: symbol.name,
        kind: getSymbolKindName(symbol.kind),
        path: vscode.workspace.asRelativePath(documentUri, false),
        uri: documentUri.toString(),
        range: serializeRange(symbol.range),
        selectionRange: serializeRange(symbol.selectionRange),
        containerName: inheritedContainer,
        detail: symbol.detail || undefined,
        preview: await this.getPreview(documentUri, symbol.selectionRange)
      });
      if (symbol.children?.length) {
        await this.flattenDocumentSymbols(symbol.children, documentUri, output, limit, symbol.name);
      }
    }
  }

  private async serializeSymbolInformation(symbol: vscode.SymbolInformation): Promise<SemanticSymbolResult> {
    return {
      name: symbol.name,
      kind: getSymbolKindName(symbol.kind),
      path: vscode.workspace.asRelativePath(symbol.location.uri, false),
      uri: symbol.location.uri.toString(),
      range: serializeRange(symbol.location.range),
      containerName: symbol.containerName || undefined,
      preview: await this.getPreview(symbol.location.uri, symbol.location.range)
    };
  }

  private async fallbackSearch(
    query: string,
    path: string | undefined,
    limit: number,
    fallbackReason: string | undefined,
    language: KeepseekLanguage,
    kind: string,
    isRegex = false
  ): Promise<string> {
    const raw = await this.workspaceTools.searchWorkspace({ query, path, isRegex, matchCase: false, maxResults: limit }, language);
    const parsed = safeParseRecord(raw);
    const searchResults = Array.isArray(parsed?.results) ? parsed.results : [];
    const results = searchResults.filter(isRecord).map((item) => ({
      name: isRegex ? extractFallbackSymbolName(String(item.matchLine ?? '')) : query,
      kind,
      path: String(item.path ?? ''),
      uri: String(item.uri ?? ''),
      range: {
        startLine: Number(item.line ?? 1),
        startColumn: Number(item.startColumn ?? 1),
        endLine: Number(item.line ?? 1),
        endColumn: Number(item.endColumn ?? item.startColumn ?? 1)
      },
      containerName: undefined,
      preview: compactText(String(item.matchLine ?? ''), PREVIEW_MAX_CHARS)
    }));
    return JSON.stringify({
      ok: parsed?.ok === true,
      providerAvailable: false,
      fallback: true,
      fallbackReason: fallbackReason ?? 'No VS Code language provider is available.',
      query,
      results,
      count: results.length,
      truncated: parsed?.truncated === true,
      error: parsed?.ok === false ? parsed.error : undefined
    });
  }

  private resolveReadableWorkspaceUri(rawPath: string): vscode.Uri {
    const uri = this.workspaceTools.resolveTargetUri(rawPath);
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      throw new Error('Semantic tools only access files inside the open workspace.');
    }
    if (shouldSkipTextUri(uri)) {
      throw new Error('This file type is not eligible for semantic text inspection.');
    }
    return uri;
  }

  private async getPreview(uri: vscode.Uri, range: vscode.Range): Promise<string | undefined> {
    if (!vscode.workspace.getWorkspaceFolder(uri) || shouldSkipTextUri(uri)) {
      return undefined;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const line = document.lineAt(Math.min(range.start.line, Math.max(0, document.lineCount - 1)));
      return compactText(line.text, PREVIEW_MAX_CHARS);
    } catch {
      return undefined;
    }
  }

  private async getDefinitionLocationKeys(uri: vscode.Uri, position: vscode.Position): Promise<Set<string>> {
    try {
      const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
        'vscode.executeDefinitionProvider',
        uri,
        position
      );
      const keys = new Set<string>();
      for (const definition of definitions ?? []) {
        if ('targetUri' in definition) {
          keys.add(getLocationKey(definition.targetUri, definition.targetSelectionRange ?? definition.targetRange));
        } else {
          keys.add(getLocationKey(definition.uri, definition.range));
        }
      }
      return keys;
    } catch {
      return new Set<string>();
    }
  }

  private error(language: KeepseekLanguage, english: string, chinese: string): string {
    return JSON.stringify({ ok: false, providerAvailable: false, fallback: false, error: language === 'en' ? english : chinese });
  }
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RESULT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_RESULT_LIMIT);
}

function normalizeOneBasedPosition(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.floor(value) < 1) {
    throw new Error(`${label} must be a 1-based positive integer.`);
  }
  return Math.floor(value);
}

function serializeRange(range: vscode.Range): SerializedRange {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function getWordAtPosition(document: vscode.TextDocument, position: vscode.Position): string {
  const lineText = document.lineAt(position.line).text ?? '';
  const before = lineText.slice(0, position.character + 1).match(/[A-Za-z_$][\w$]*$/u)?.[0] ?? '';
  const after = lineText.slice(position.character + 1).match(/^[\w$]*/u)?.[0] ?? '';
  return `${before}${after}`;
}

function isSymbolInformation(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.SymbolInformation {
  return 'location' in symbol;
}

function getSymbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind);
}

function getLocationKey(uri: vscode.Uri, range: vscode.Range): string {
  return `${uri.toString()}#${range.start.line}:${range.start.character}`;
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/gu, ' ').trim();
  return compacted.length <= maxChars ? compacted : `${compacted.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractFallbackSymbolName(line: string): string {
  return /(?:class|interface|type|enum|function|const|let|var|def|struct)\s+([A-Za-z_$][\w$]*)/u.exec(line)?.[1] ?? compactText(line, 80);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
