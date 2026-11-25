import { createHash } from 'node:crypto';
import { hasPrivateKeyBlock, redactSensitiveMaterial } from '../approvals/sensitiveText';
import type { KeepseekLanguage } from '../shared/i18n';
import type { ChatMessage, HandoffPromptBlock } from '../shared/types';

export type HandoffFailureReason = 'invalid' | 'disclosure' | 'oversize' | 'missing_context';
interface HandoffFailure { ok: false; reason: HandoffFailureReason }
interface FrozenHandoffPrompt { ok: true; version: 1; body: string; bodyHash: string }
export type GeneratedHandoffPrompt = FrozenHandoffPrompt | HandoffFailure;

/**
 * Validate a stored host-only prompt block. The hash must match the bytes it
 * claims to protect, so a tampered or truncated field is dropped instead of
 * being shown or copied as if it were the frozen output.
 */
export function normalizeHandoffPromptBlock(value: unknown): HandoffPromptBlock | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const block = value as Partial<HandoffPromptBlock>;
  if (block.version !== 1 || typeof block.body !== 'string' || !block.body.trim()) return undefined;
  if (typeof block.bodyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(block.bodyHash)) return undefined;
  return createHash('sha256').update(block.body).digest('hex') === block.bodyHash
    ? { version: 1, body: block.body, bodyHash: block.bodyHash }
    : undefined;
}

const errorMessages = {
  'zh-CN': {
    invalid: '提示词或正文版本已变化。请查看最新版本后重试。',
    disclosure: '正文包含私钥材料。请移除后重新预览。',
    oversize: '完整正文超过首条消息容量。请在当前会话执行，或缩短可选说明并保留全部验收条件后重新预览。',
    missing_context: '正文仍依赖原会话的证据或引用。请把必要的目标、项目相对路径和验证方法写入后重新预览。'
  },
  en: {
    invalid: 'The prompt has changed. Review its latest version and try again.',
    disclosure: 'The prompt contains a private key. Remove it and preview again.',
    oversize: 'The complete prompt exceeds the first-message limit. Run in this session, or shorten optional details while preserving all acceptance criteria and preview again.',
    missing_context: 'This prompt still depends on evidence or references from its original session. Revise it with the necessary goal, project-relative paths and verification steps.'
  }
} as const;

export function handoffPromptError(language: KeepseekLanguage, reason: HandoffFailureReason): string {
  return errorMessages[language][reason];
}

// File URIs and native paths beneath the selected project can be made portable.
// Only replace exact directory boundaries, including paths containing spaces.
function projectRelativeText(value: string, folders: readonly string[]): string {
  let text = value.trim();
  // Both forms appear in stored text: the raw folder string (a file: URI, possibly still
  // percent-encoded) and the decoded fsPath. Longest first so a nested root wins.
  const prefixes = [...new Set([...normalizeRoots(folders), ...folders.map(folder => folder.replace(/\/$/u, ''))])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const root of prefixes) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    // A following `..` segment is left as written: traversal is a structural property, not a
    // disclosure, and it exposes nothing outside the project on its own.
    const boundary = '(?=[/\\\\](?!\\.\\.(?:[/\\\\]|$))|[\\s`"\')，。；、：）】」』”’>\\]]|$)';
    text = text.replace(new RegExp('(^|[^A-Za-z0-9._\\-/\\\\])(?:' + escaped + ')' + boundary, 'gu'), '$1.');
  }
  return text;
}

/**
 * file:// URIs and bare fsPaths both become plain fsPaths without a trailing separator.
 * A bare fsPath is also a valid input: `new URL()` rejects it, which previously dropped the
 * root from portability rewriting without any visible failure.
 */
export function normalizeRoots(folders: readonly string[]): string[] {
  const roots: string[] = [];
  for (const folder of folders) {
    let path: string;
    try {
      const uri = new URL(folder);
      if (uri.search || uri.hash) continue;
      path = decodeURIComponent(uri.pathname);
    } catch {
      path = folder;
    }
    path = path.replace(/\/$/u, '');
    if (!path) continue;
    roots.push(path);
    if (/^\/[a-z]:\//iu.test(path)) roots.push(path.slice(1), path.slice(1).replace(/\//gu, '\\'));
  }
  return [...new Set(roots)];
}

// Only a host read of the complete byte stream produces fileSha256. Evidence
// contentHash and scope fingerprints do not enter the file checksum column.
function inspectFileReads(rounds: ChatMessage['toolRounds'], folders: readonly string[], mentioned: string): {
  anchors: Map<string, string>;
} {
  const anchors = new Map<string, string>();
  for (const round of rounds ?? []) {
    const reads = new Map(round.toolCalls
      .filter(call => ['keepseek_read_workspace_file', 'keepseek_read_workspace_file_range'].includes(call.function.name))
      .map(call => [call.id, call.function.name]));
    for (const result of round.toolResults) {
      let data: unknown;
      try {
        data = JSON.parse(result.content);
      } catch {
        // Omitted, archived or non-JSON tool output supplies no checksum.
        continue;
      }
      const record = data as { ok?: unknown; uri?: unknown; fileSha256?: unknown } | null;
      if (reads.has(result.toolCallId) && record?.ok === true && typeof record.uri === 'string') {
        const relative = projectRelativeText(record.uri, folders);
        // External reads inform the authored body but never the checksum appendix: only a
        // complete read that is still project-relative can be measured here.
        if (!relative.startsWith('./') || relative.split('/').includes('..')) continue;
        const name = reads.get(result.toolCallId);
        if (name === 'keepseek_read_workspace_file' && typeof record.fileSha256 === 'string'
          && /^[a-f0-9]{64}$/u.test(record.fileSha256)
          && /^[\p{L}\p{N}_./ -]+$/u.test(relative) && mentioned.includes(relative.slice(2))) {
          anchors.set(relative, record.fileSha256);
        }
      }
    }
  }
  return { anchors };
}

interface PromptGuardContext {
  anchors: Map<string, string>;
}
function renderPrompt(requirement: string, steps: string, language: KeepseekLanguage, context: PromptGuardContext): GeneratedHandoffPrompt {
  if (!requirement || !steps) return { ok: false, reason: 'missing_context' };
  // Four stages, fixed order: the private-key refusal must inspect the original bytes, and
  // every length-based decision below must run on the redacted text that is actually delivered.
  const text = requirement + '\n' + steps;
  if (hasPrivateKeyBlock(text)) return { ok: false, reason: 'disclosure' };
  const safeRequirement = redactSensitiveMaterial(requirement);
  const safeSteps = redactSensitiveMaterial(steps);
  const safeText = safeRequirement + '\n' + safeSteps;
  if (/\bev_[a-f\d]{40}\.[a-f\d]{24}\b|\[keepseek-archive:|\[(?:\$|@)[^\]]+\]\([^)]*SKILL\.md\)|(?:see|refer to) (?:the )?(?:above|previous (?:message|session|conversation))|(?:详见|参见|同|见)(?:上文|上述对话|上一条消息)/iu.test(safeText)) {
    return { ok: false, reason: 'missing_context' };
  }
  const knownHashes = new Set(context.anchors.values());
  if ([...safeSteps.matchAll(/\b[a-f\d]{64}\b/giu)].some(([digest]) => !knownHashes.has(digest) && !safeRequirement.includes(digest))) {
    return { ok: false, reason: 'missing_context' };
  }
  // The delivered body is the authored prompt alone: a template title, the restated
  // requirement or an "here is the prompt" preamble would be pasted into the new session as
  // if it were part of the task, so nothing precedes the first authored line.
  let body = safeSteps;  // The 24k soft target only budgets optional locators; keep mandatory criteria intact.
  const heading = language === 'en' ? 'File-content SHA-256 at inspection' : '调查时的文件内容 SHA-256';
  const rows: string[] = [];
  let length = body.length + heading.length + 8;
  for (const [path, digest] of [...context.anchors].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const row = '- `' + path + '` — `' + digest + '`';
    if (length + row.length > 24_000) break;
    rows.push(row);
    length += row.length + 1;
  }
  // Measured hashes are a trailing appendix for the executor, never a preamble, and they only
  // appear when the host read the file's own bytes during this turn.
  if (rows.length) body += '\n\n## ' + heading + '\n\n' + rows.join('\n');  if (body.length > 32_000) return { ok: false, reason: 'oversize' };
  return { ok: true, version: 1, body, bodyHash: createHash('sha256').update(body).digest('hex') };
}

export function renderGeneratedHandoffPrompt(requirement: string, authoredPrompt: string, language: KeepseekLanguage,
  workspaceFolders: readonly string[] = [], toolRounds?: ChatMessage['toolRounds']): GeneratedHandoffPrompt {
  const plain = requirement.replaceAll('[$gen-prompt](builtin:gen-prompt)', '').trim();
  const draft = /^\/draft\s+([^\n]+)\n([\s\S]+)$/u.exec(plain);
  // A `/draft <path>` composer shortcut names the target and its bytes; that material has to
  // reach the executor, so it opens the delivered prompt instead of a template heading.
  const directive = draft
    ? projectRelativeText((language === 'en' ? 'Create ' : '创建 ') + draft[1]
      + (language === 'en' ? ' with exactly this content:' : '，内容如下：') + '\n\n' + draft[2], workspaceFolders)
    : '';
  const authored = projectRelativeText(authoredPrompt, workspaceFolders);
  const steps = directive && !authored.includes(directive) ? directive + '\n\n' + authored : authored;
  // The original requirement still drives the guards; it never enters the delivered body.
  const reads = inspectFileReads(toolRounds, workspaceFolders, plain + '\n' + steps);
  return renderPrompt(plain, steps, language, { anchors: reads.anchors });
}

export function usedExternalHandoffContext(request: { contextFiles?: readonly { source: string }[]; authorizedExternalReferenceUris?: readonly string[] }): boolean {
  return Boolean(request.contextFiles?.some(file => file.source === 'external') || request.authorizedExternalReferenceUris?.length);
}


