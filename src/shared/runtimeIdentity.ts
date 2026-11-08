import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { getAgentTools } from '../agent/protocol';
import { CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, CURRENT_PROVIDER_TOOL_SCHEMA_VERSION } from '../agent/providerRequestProjection';

let activeIdentity: ReturnType<typeof captureRuntimeIdentity> | undefined;

/** A single activation snapshot, never a per-request filesystem scan. Disk
 * hashes describe activation-time files, not a hash of V8's loaded memory. */
export function captureRuntimeIdentity(input: {
  extensionUri: vscode.Uri; extensionMode: number; version: string; remoteName?: string;
}) {
  const activationDiskSha256: Record<string, string | null> = {};
  for (const file of ['extension.js', 'agent/delegation.js', 'agent/providerRequestProjection.js', 'agent/subagents/runtime.js']) {
    try { activationDiskSha256[file] = sha(readFileSync(join(input.extensionUri.fsPath, 'out', file))); }
    catch { activationDiskSha256[file] = null; }
  }
  return Object.freeze({
    diagnosticVersion: 1, runtimeMarker: 'keepseek-field-identity-v1', activationId: randomUUID(),
    activatedAt: new Date().toISOString(), processId: process.pid,
    extensionUri: input.extensionUri.toString(), extensionMode: input.extensionMode,
    packageVersion: input.version, remoteName: input.remoteName ?? null,
    supportedRequestProtocolVersion: CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
    supportedToolSchemaVersion: CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
    // Computed from imported, executing protocol functions, independently of
    // disk/module directory names. A hot session may still use an older schema.
    supportedToolSchemaSha256: sha(JSON.stringify(getAgentTools({ requestProtocolVersion: CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION }))),
    activationDiskSha256: Object.freeze(activationDiskSha256)
  });
}

export function initializeRuntimeIdentity(input: Parameters<typeof captureRuntimeIdentity>[0]): void {
  activeIdentity ??= captureRuntimeIdentity(input);
}
export function getRuntimeIdentity() { return activeIdentity; }
/** Called after the activation's shutdown barrier, never while its work runs. */
export function clearRuntimeIdentity(): void { activeIdentity = undefined; }
function sha(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
