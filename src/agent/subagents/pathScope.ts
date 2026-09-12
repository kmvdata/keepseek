import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface WorkspaceScopeRoot {
  id: string;
  name: string;
  uri: vscode.Uri;
  caseSensitive: boolean;
}

export interface ProposalPathClaim {
  rootId: string;
  segments: string[];
}

export type ProposalPathScope =
  | { kind: 'workspace' }
  | { kind: 'paths'; claims: ProposalPathClaim[] };

export type ProposalPathResolution =
  | { ok: true; scope: ProposalPathScope }
  | { ok: false; errorType: 'subagent_path_unresolvable' | 'subagent_path_ambiguous' | 'subagent_path_escape'; error: string; path?: string };

export function createWorkspaceScopeRoots(
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []
): WorkspaceScopeRoot[] {
  return folders.map((folder) => ({
    id: stableWorkspaceRootId(folder.uri),
    name: folder.name,
    uri: folder.uri,
    // Treat the common case-insensitive desktop filesystems conservatively.
    // A case-sensitive macOS volume may produce an extra conflict, but never
    // permits two spellings of the same file to bypass a lease.
    caseSensitive: folder.uri.scheme !== 'file'
      || (process.platform !== 'win32' && process.platform !== 'darwin')
  }));
}

export function stableWorkspaceRootId(uri: vscode.Uri): string {
  return `root-${createHash('sha256').update(uri.toString(), 'utf8').digest('hex').slice(0, 24)}`;
}

export function resolveProposalPathScope(
  rawPaths: readonly string[] | undefined,
  roots: readonly WorkspaceScopeRoot[]
): ProposalPathResolution {
  if (!roots.length) {
    return { ok: false, errorType: 'subagent_path_unresolvable', error: 'Proposal paths require an open workspace.' };
  }
  if (!rawPaths?.length) {
    return { ok: true, scope: { kind: 'workspace' } };
  }
  const claims: ProposalPathClaim[] = [];
  const seen = new Set<string>();
  for (const rawPath of rawPaths) {
    const resolved = resolveProposalPath(rawPath, roots);
    if (!resolved.ok) return resolved;
    const key = encodeProposalPathClaim(resolved.claim, roots);
    if (!seen.has(key)) {
      seen.add(key);
      claims.push(resolved.claim);
    }
  }
  return { ok: true, scope: { kind: 'paths', claims } };
}

export function resolveProposalUriScope(
  uriValue: string,
  roots: readonly WorkspaceScopeRoot[]
): ProposalPathResolution {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(uriValue, true);
  } catch {
    return { ok: false, errorType: 'subagent_path_unresolvable', error: 'The proposal URI is invalid.', path: uriValue };
  }
  const match = findContainingRoot(uri, roots);
  if (!match) {
    return { ok: false, errorType: 'subagent_path_escape', error: 'The proposal URI is outside the open workspace.', path: uriValue };
  }
  return { ok: true, scope: { kind: 'paths', claims: [{ rootId: match.root.id, segments: match.segments }] } };
}

export function scopesOverlap(
  left: ProposalPathScope,
  right: ProposalPathScope,
  roots: readonly WorkspaceScopeRoot[]
): boolean {
  if (left.kind === 'workspace' || right.kind === 'workspace') return true;
  return left.claims.some((a) => right.claims.some((b) => claimsOverlap(a, b, roots)));
}

export function scopeContains(
  scope: ProposalPathScope,
  target: ProposalPathScope,
  roots: readonly WorkspaceScopeRoot[]
): boolean {
  if (scope.kind === 'workspace') return true;
  if (target.kind === 'workspace') return false;
  return target.claims.every((targetClaim) => scope.claims.some((claim) => claimContains(claim, targetClaim, roots)));
}

export function encodeProposalPathScope(scope: ProposalPathScope, roots: readonly WorkspaceScopeRoot[]): string[] {
  return scope.kind === 'workspace'
    ? ['workspace:*']
    : scope.claims.map((claim) => encodeProposalPathClaim(claim, roots)).sort();
}

export function decodeProposalPathScope(values: readonly string[]): ProposalPathScope {
  if (values.includes('workspace:*')) return { kind: 'workspace' };
  return {
    kind: 'paths',
    claims: values.flatMap((value) => {
      const separator = value.indexOf(':');
      if (separator < 1) return [];
      const rootId = value.slice(0, separator);
      const body = value.slice(separator + 1);
      return [{ rootId, segments: body ? body.split('/').filter(Boolean) : [] }];
    })
  };
}

export function createStableWorkspaceContext(roots: readonly WorkspaceScopeRoot[]): {
  text: string;
  hash: string;
} {
  const manifest = {
    version: 1,
    roots: roots.map((root) => ({
      id: root.id,
      name: root.name,
      toolPathPrefix: roots.length > 1 ? `${root.id}/` : ''
    })),
    convention: roots.length > 1
      ? '<root-id>/<workspace-relative-path> (workspace name is accepted only when unique)'
      : '<workspace-relative-path>'
  };
  const text = JSON.stringify(manifest);
  return { text, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

function resolveProposalPath(
  rawValue: string,
  roots: readonly WorkspaceScopeRoot[]
): { ok: true; claim: ProposalPathClaim } | Exclude<ProposalPathResolution, { ok: true }> {
  const value = rawValue.trim();
  if (!value || value.includes('\0')) {
    return { ok: false, errorType: 'subagent_path_unresolvable', error: 'Proposal path is empty or invalid.', path: rawValue };
  }
  if (looksLikeUri(value) || path.isAbsolute(value)) {
    let uri: vscode.Uri;
    try {
      uri = looksLikeUri(value) ? vscode.Uri.parse(value, true) : vscode.Uri.file(path.resolve(value));
    } catch {
      return { ok: false, errorType: 'subagent_path_unresolvable', error: 'Proposal path could not be parsed.', path: rawValue };
    }
    const match = findContainingRoot(uri, roots);
    if (!match) {
      return { ok: false, errorType: 'subagent_path_escape', error: 'Proposal path escapes the open workspace.', path: rawValue };
    }
    return { ok: true, claim: { rootId: match.root.id, segments: match.segments } };
  }

  const normalized = value.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/');
  const rawSegments = normalized.split('/');
  let candidates = [...roots];
  let relativeSegments = rawSegments;
  const explicitRoot = roots.filter((root) => root.id === rawSegments[0] || root.name === rawSegments[0]);
  if (explicitRoot.length) {
    if (explicitRoot.length !== 1) {
      return { ok: false, errorType: 'subagent_path_ambiguous', error: 'Proposal path matches more than one workspace root.', path: rawValue };
    }
    candidates = explicitRoot;
    relativeSegments = rawSegments.slice(1);
  } else if (roots.length !== 1) {
    return { ok: false, errorType: 'subagent_path_ambiguous', error: 'Multi-root proposal paths must identify one stable workspace root.', path: rawValue };
  }
  const segments: string[] = [];
  for (const segment of relativeSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) {
        return { ok: false, errorType: 'subagent_path_escape', error: 'Proposal path escapes its workspace root.', path: rawValue };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { ok: true, claim: { rootId: candidates[0].id, segments } };
}

function findContainingRoot(
  uri: vscode.Uri,
  roots: readonly WorkspaceScopeRoot[]
): { root: WorkspaceScopeRoot; segments: string[] } | undefined {
  const matches = roots.flatMap((root) => {
    if (uri.scheme !== root.uri.scheme || uri.authority !== root.uri.authority) return [];
    const rootSegments = canonicalUriSegments(root.uri);
    const targetSegments = canonicalUriSegments(uri);
    if (!segmentsStartWith(targetSegments, rootSegments, root.caseSensitive)) return [];
    return [{ root, segments: targetSegments.slice(rootSegments.length) }];
  }).sort((a, b) => b.root.uri.path.length - a.root.uri.path.length);
  if (!matches.length) return undefined;
  const longest = matches[0].root.uri.path.length;
  const equallySpecific = matches.filter((item) => item.root.uri.path.length === longest);
  return equallySpecific.length === 1 ? equallySpecific[0] : undefined;
}

function canonicalUriSegments(uri: vscode.Uri): string[] {
  if (uri.scheme === 'file') {
    return path.resolve(uri.fsPath).split(path.sep).filter(Boolean);
  }
  const decoded = splitUriPath(uri.path);
  const normalized: string[] = [];
  for (const segment of decoded) {
    if (segment === '.') continue;
    if (segment === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

function encodeProposalPathClaim(claim: ProposalPathClaim, roots: readonly WorkspaceScopeRoot[]): string {
  const root = roots.find((item) => item.id === claim.rootId);
  const segments = root?.caseSensitive === false ? claim.segments.map((segment) => segment.toLocaleLowerCase()) : claim.segments;
  return `${claim.rootId}:${segments.join('/')}`;
}

function claimsOverlap(left: ProposalPathClaim, right: ProposalPathClaim, roots: readonly WorkspaceScopeRoot[]): boolean {
  return claimContains(left, right, roots) || claimContains(right, left, roots);
}

function claimContains(parent: ProposalPathClaim, child: ProposalPathClaim, roots: readonly WorkspaceScopeRoot[]): boolean {
  if (parent.rootId !== child.rootId) return false;
  const root = roots.find((item) => item.id === parent.rootId);
  return segmentsStartWith(child.segments, parent.segments, root?.caseSensitive !== false);
}

function splitUriPath(value: string): string[] {
  return value.split('/').filter(Boolean).map((segment) => decodeURIComponentSafe(segment));
}

function segmentsStartWith(values: readonly string[], prefix: readonly string[], caseSensitive: boolean): boolean {
  if (prefix.length > values.length) return false;
  return prefix.every((segment, index) => caseSensitive
    ? values[index] === segment
    : values[index]?.toLocaleLowerCase() === segment.toLocaleLowerCase());
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function looksLikeUri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
}
