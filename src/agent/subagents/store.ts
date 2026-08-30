import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { isRecord } from '../../shared/errors';
import type {
  StoredSubagentMetadata,
  StoredSubagentTranscript
} from './types';

const SUBAGENT_STORAGE_VERSION = 'v1';
export const DEFAULT_SUBAGENT_RESULT_PAGE_CHARS = 12_000;
export const MAX_SUBAGENT_RESULT_PAGE_CHARS = 24_000;

export class SubagentStore {
  private readonly rootUri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  public constructor(globalStorageUri: vscode.Uri, workspaceKey: string) {
    const workspaceHash = createHash('sha256').update(workspaceKey, 'utf8').digest('hex').slice(0, 24);
    this.rootUri = vscode.Uri.joinPath(
      globalStorageUri,
      'chat-sessions',
      'v1',
      'subagents',
      workspaceHash
    );
  }

  public async save(metadata: StoredSubagentMetadata, transcript: StoredSubagentTranscript): Promise<void> {
    const directory = this.getParentDirectory(metadata.parentSessionId);
    await vscode.workspace.fs.createDirectory(directory);
    await Promise.all([
      vscode.workspace.fs.writeFile(
        this.getMetadataUri(metadata.parentSessionId, metadata.id),
        this.encoder.encode(`${JSON.stringify(metadata, null, 2)}\n`)
      ),
      vscode.workspace.fs.writeFile(
        this.getTranscriptUri(metadata.parentSessionId, metadata.id),
        this.encoder.encode(`${JSON.stringify(transcript, null, 2)}\n`)
      )
    ]);
  }

  public async read(parentSessionId: string, subagentId: string): Promise<{
    metadata: StoredSubagentMetadata;
    transcript: StoredSubagentTranscript;
  } | undefined> {
    if (!isSafeId(parentSessionId) || !isSafeId(subagentId)) {
      return undefined;
    }
    try {
      const [metadataBytes, transcriptBytes] = await Promise.all([
        vscode.workspace.fs.readFile(this.getMetadataUri(parentSessionId, subagentId)),
        vscode.workspace.fs.readFile(this.getTranscriptUri(parentSessionId, subagentId))
      ]);
      const metadata = normalizeMetadata(JSON.parse(this.decoder.decode(metadataBytes)));
      const transcript = normalizeTranscript(JSON.parse(this.decoder.decode(transcriptBytes)));
      if (!metadata || !transcript || transcript.metadataId !== metadata.id) {
        return undefined;
      }
      return { metadata, transcript };
    } catch {
      return undefined;
    }
  }

  public async readResultPage(input: {
    parentSessionId: string;
    subagentId: string;
    offset?: number;
    maxChars?: number;
  }): Promise<Record<string, unknown>> {
    const stored = await this.read(input.parentSessionId, input.subagentId);
    if (!stored) {
      return { ok: false, errorType: 'subagent_not_found', error: 'The requested subagent result was not found in this parent session.' };
    }
    const result = stored.transcript.result;
    const offset = clampInteger(input.offset, 0, result.length, 0);
    const maxChars = clampInteger(
      input.maxChars,
      1,
      MAX_SUBAGENT_RESULT_PAGE_CHARS,
      DEFAULT_SUBAGENT_RESULT_PAGE_CHARS
    );
    const content = result.slice(offset, offset + maxChars);
    const nextOffset = offset + content.length;
    return {
      ok: true,
      subagentId: stored.metadata.id,
      status: stored.metadata.status,
      profile: stored.metadata.profile,
      lane: stored.metadata.lane,
      offset,
      content,
      totalChars: result.length,
      hasMore: nextOffset < result.length,
      ...(nextOffset < result.length ? { nextOffset } : {}),
      resultHash: stored.metadata.resultHash,
      usage: stored.metadata.usage
    };
  }

  private getParentDirectory(parentSessionId: string): vscode.Uri {
    if (!isSafeId(parentSessionId)) {
      throw new Error('Invalid parent session id for subagent storage.');
    }
    return vscode.Uri.joinPath(this.rootUri, parentSessionId);
  }

  private getMetadataUri(parentSessionId: string, subagentId: string): vscode.Uri {
    if (!isSafeId(subagentId)) {
      throw new Error('Invalid subagent id.');
    }
    return vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.meta.json`);
  }

  private getTranscriptUri(parentSessionId: string, subagentId: string): vscode.Uri {
    if (!isSafeId(subagentId)) {
      throw new Error('Invalid subagent id.');
    }
    return vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.transcript.json`);
  }
}

function normalizeMetadata(value: unknown): StoredSubagentMetadata | undefined {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.id !== 'string'
    || typeof value.parentSessionId !== 'string'
    || typeof value.status !== 'string') {
    return undefined;
  }
  return value as unknown as StoredSubagentMetadata;
}

function normalizeTranscript(value: unknown): StoredSubagentTranscript | undefined {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.metadataId !== 'string'
    || typeof value.contextInstructions !== 'string'
    || !Array.isArray(value.messages)
    || typeof value.result !== 'string') {
    return undefined;
  }
  return value as unknown as StoredSubagentTranscript;
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value) && value !== '.' && value !== '..';
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}
