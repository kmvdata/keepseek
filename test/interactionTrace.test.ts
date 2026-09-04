import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { createNoopInteractionTrace, InteractionTraceLogService } from '../src/agent/logging/interactionTrace';
import { formatLocalTimestamp } from '../src/shared/format';

test('local timestamps preserve instants across local midnight, timezone changes, DST and fractional offsets', () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const [timezone, instant, expected] of [
      ['Asia/Shanghai', '2026-09-03T20:04:03.123Z', '2026-09-04T04:04:03.123+08:00'],
      ['America/New_York', '2026-01-04T02:04:03.123Z', '2026-01-03T21:04:03.123-05:00'],
      ['America/New_York', '2026-07-04T02:04:03.123Z', '2026-07-03T22:04:03.123-04:00'],
      ['Asia/Kathmandu', '2026-09-04T08:04:03.123Z', '2026-09-04T13:49:03.123+05:45'],
      ['UTC', '2026-09-04T08:04:03.123Z', '2026-09-04T08:04:03.123+00:00']
    ]) {
      process.env.TZ = timezone;
      const date = new Date(instant);
      assert.equal(formatLocalTimestamp(date), expected);
      assert.equal(Date.parse(expected), date.getTime());
    }
  } finally { restoreTimezone(originalTimezone); }
});

test('local and workspace-fs traces use local dates for events, filenames, appends and truncation without rewriting payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-trace-timezone-'));
  const originalTimezone = process.env.TZ;
  const originalConfig = vscode.workspace.getConfiguration;
  const originalJoinPath = vscode.Uri.joinPath;
  const originalFs = vscode.workspace.fs;
  const remoteFiles = new Map<string, Uint8Array>();
  try {
    process.env.TZ = 'Asia/Shanghai';
    vscode.workspace.getConfiguration = () => ({ ...originalConfig(),
      get<T>(key: string, fallback: T): T {
        return (key === 'trace.enabled' ? true : key === 'trace.maxFileBytes' ? 1_000_000 : fallback) as T;
      }
    });
    vscode.Uri.joinPath = (base, ...segments) => base.scheme === 'file' ? originalJoinPath(base, ...segments)
      : base.with({ path: posix.join(base.path, ...segments) });
    vscode.workspace.fs = {
      ...originalFs,
      async readDirectory(uri) { return uri.scheme === 'file' ? await originalFs.readDirectory(uri) : []; },
      async createDirectory(uri) { if (uri.scheme === 'file') await originalFs.createDirectory(uri); },
      async writeFile(uri, content) {
        if (uri.scheme === 'file') await originalFs.writeFile(uri, content);
        else remoteFiles.set(uri.toString(), content);
      },
      async readFile(uri) { return uri.scheme === 'file' ? await originalFs.readFile(uri) : remoteFiles.get(uri.toString())!; },
      async stat(uri) { return uri.scheme === 'file' ? await originalFs.stat(uri)
        : { type: vscode.FileType.File, size: remoteFiles.get(uri.toString())!.byteLength }; }
    };
    for (const storage of [vscode.Uri.file(directory), vscode.Uri.parse('memfs:/trace-storage')]) {
      const sinkTimestamps: string[] = [];
      const service = new InteractionTraceLogService(storage as unknown as import('vscode').Uri);
      const started = Date.now();
      const trace = service.createRunTrace((_event, timestamp) => sinkTimestamps.push(timestamp));
      const originalPayload = { messages: [{ role: 'user', content: '2026-09-04T08:04:03.123Z' }], createdAt: '2026-09-04T08:04:03.123Z' };
      trace.record({ type: 'upstream_request', body: originalPayload });
      await trace.flush();
      await service.appendRunEvent({ runId: trace.runId, uri: trace.logUri! }, { type: 'external_update' });
      let records = await readTrace(trace.logUri!);
      assert.equal(records.length, 2);
      assert.equal(records[0].ts, sinkTimestamps[0]);
      assert.deepEqual(records[0].body, originalPayload);
      for (const record of records) {
        assert.match(record.ts, /T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/u);
        assert.ok(Date.parse(record.ts) >= started && Date.parse(record.ts) <= Date.now());
      }
      const uri = vscode.Uri.parse(trace.logUri!);
      const localDay = formatLocalTimestamp().slice(0, 10);
      assert.ok(uri.path.includes(`/interaction-logs/${localDay}/run-${localDay}T`));
      assert.match(uri.path, /\+08-00-/u);

      // Use another run: an external append is intentionally outside an active
      // remote writer's in-memory buffer, as it is in the production workflow.
      const truncated = service.createRunTrace();
      truncated.record({ type: 'too_large', content: 'x'.repeat(1_000_001) });
      await truncated.flush();
      records = await readTrace(truncated.logUri!);
      assert.equal(records[0].type, 'trace_truncated');
      assert.match(records[0].ts, /\+08:00$/u);
    }
    const timestamps: string[] = [];
    createNoopInteractionTrace((_event, timestamp) => timestamps.push(timestamp)).record({ type: 'disabled_trace_event' });
    assert.match(timestamps[0], /\+08:00$/u);
  } finally {
    vscode.workspace.fs = originalFs;
    vscode.Uri.joinPath = originalJoinPath;
    vscode.workspace.getConfiguration = originalConfig;
    restoreTimezone(originalTimezone);
    await rm(directory, { recursive: true, force: true });
  }

  async function readTrace(uriString: string): Promise<Array<{ ts: string; type: string; body?: unknown }>> {
    const uri = vscode.Uri.parse(uriString);
    const bytes = uri.scheme === 'file' ? await readFile(uri.fsPath) : remoteFiles.get(uri.toString())!;
    return new TextDecoder().decode(bytes).trim().split('\n').map((line) => JSON.parse(line));
  }
});

function restoreTimezone(timezone: string | undefined): void {
  if (timezone === undefined) delete process.env.TZ;
  else process.env.TZ = timezone;
}
