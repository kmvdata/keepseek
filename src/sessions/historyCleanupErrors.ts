export type HistoryCleanupPhase = 'initialization' | 'state' | 'preview' | 'catalog' | 'ownership' | 'execute' | 'recovery';
export type HistoryCleanupIssueCode = 'loading_sessions' | 'initialization_failed' | 'permission_denied'
  | 'unsupported_storage' | 'unsafe_storage_path' | 'corrupt_index' | 'ownership_unverified'
  | 'deletion_authority_unavailable' | 'journal_corrupt' | 'journal_unavailable' | 'storage_unavailable' | 'storage_io'
  | 'history_changed' | 'invalid_preview' | 'expired_preview' | 'stale_preview' | 'invalid_options'
  | 'cleanup_busy' | 'unavailable' | 'nothing_to_clean';
export interface HistoryCleanupIssue {
  code: HistoryCleanupIssueCode;
  phase: HistoryCleanupPhase;
  retryable: boolean;
  message?: string;
  systemCode?: string;
}

/** Only safe codes are exposed. Error messages may contain filesystem paths,
 * so neither the UI nor diagnostics use arbitrary message text. */
export class HistoryCleanupFailure extends Error {
  public constructor(public readonly code: HistoryCleanupIssueCode, public readonly phase: HistoryCleanupPhase,
    public readonly retryable = false, options?: ErrorOptions) {
    super(code, options); this.name = 'HistoryCleanupFailure';
  }
}

const known = new Set<HistoryCleanupIssueCode>(['loading_sessions', 'initialization_failed', 'permission_denied',
  'unsupported_storage', 'unsafe_storage_path', 'corrupt_index', 'ownership_unverified', 'deletion_authority_unavailable',
  'journal_corrupt', 'journal_unavailable', 'storage_unavailable', 'storage_io', 'history_changed', 'invalid_preview',
  'expired_preview', 'stale_preview', 'invalid_options', 'cleanup_busy', 'unavailable', 'nothing_to_clean']);
const systemCodes = new Set(['EACCES', 'EPERM', 'EIO', 'ENOENT', 'ENOTDIR', 'FileNotFound', 'EntryNotFound',
  'NoPermissions', 'Unavailable', 'Unknown', 'EBUSY', 'ETIMEDOUT']);

export function classifyHistoryCleanupError(error: unknown, phase: HistoryCleanupPhase): HistoryCleanupIssue {
  const chain: unknown[] = [];
  let current = error;
  for (let i = 0; i < 5 && current && !chain.includes(current); i++) {
    chain.push(current); current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  const systemCode = chain.map(item => typeof item === 'object' && item && 'code' in item ? String(item.code) : '')
    .find(code => systemCodes.has(code));
  const texts = chain.map(item => item instanceof Error ? item.message : '').join('\n');
  let code: HistoryCleanupIssueCode | undefined;
  if (chain.some(item => item instanceof HistoryCleanupFailure)) {
    const failure = chain.find(item => item instanceof HistoryCleanupFailure) as HistoryCleanupFailure;
    return { code: failure.code, phase: failure.phase, retryable: failure.retryable, ...(systemCode ? { systemCode } : {}) };
  }
  if (systemCode === 'EACCES' || systemCode === 'EPERM' || systemCode === 'NoPermissions') code = 'permission_denied';
  else if (/storage URI|cross-process cleanup safety/iu.test(texts)) code = 'unsupported_storage';
  else if (/symbolic.link|escaped its root|unsafe storage directory/iu.test(texts)) code = 'unsafe_storage_path';
  else if (chain.some(item => item instanceof SyntaxError)) code = phase === 'state' || phase === 'recovery' ? 'journal_corrupt' : 'corrupt_index';
  else {
    for (const item of chain) {
      const record = typeof item === 'object' && item ? item as { code?: unknown; message?: unknown } : {};
      const candidate = typeof record.code === 'string' ? record.code : typeof record.message === 'string' ? record.message : '';
      if (known.has(candidate as HistoryCleanupIssueCode)) { code = candidate as HistoryCleanupIssueCode; break; }
      if (/^invalid_(scope|mode|days|now|request)$/u.test(candidate)) { code = 'invalid_options'; break; }
    }
  }
  code ??= systemCode === 'EIO' ? 'storage_io' : 'storage_unavailable';
  return { code, phase, retryable: ['loading_sessions', 'cleanup_busy', 'history_changed', 'invalid_preview', 'expired_preview',
    'stale_preview', 'storage_io', 'storage_unavailable', 'journal_unavailable'].includes(code), ...(systemCode ? { systemCode } : {}) };
}

const messages: Record<HistoryCleanupIssueCode, [string, string]> = {
  loading_sessions: ['会话索引尚未就绪，准备完成后会自动重新预览。', 'Session summaries are loading. The preview will retry when ready.'],
  initialization_failed: ['会话索引初始化失败，请重新加载窗口后重试。', 'Session summary initialization failed. Reload the window to retry.'],
  permission_denied: ['没有权限读取历史存储，请检查目录访问权限后重试。', 'History storage access was denied. Check its permissions and retry.'],
  unsupported_storage: ['当前存储类型暂不支持安全清理历史。', 'This storage type does not support safe history cleanup.'],
  unsafe_storage_path: ['历史存储路径包含符号链接或无法验证的目录，暂不可安全清理。', 'History storage contains a symbolic link or an unverified path and cannot be safely cleared.'],
  corrupt_index: ['部分项目历史索引损坏，无法验证的会话已保留。', 'Some project history indexes are damaged. Unverified sessions are kept.'],
  ownership_unverified: ['部分项目索引不可读取，无法完整验证会话归属，相关会话暂不可清理。', 'Some project indexes are unreadable. Session ownership cannot be fully verified, so affected sessions are kept.'],
  deletion_authority_unavailable: ['删除安全记录不可读取，暂不可安全清理。', 'Deletion safety records are unavailable. History cannot be safely cleared.'],
  journal_corrupt: ['旧清理结果记录损坏。可重新预览；已确认的删除记录仍按原安全规则处理。', 'A previous cleanup result is damaged. You can preview again; confirmed deletion records keep their safety rules.'],
  journal_unavailable: ['旧清理结果暂不可读取，可重新预览当前历史。', 'A previous cleanup result is unavailable. You can preview the current history again.'],
  storage_unavailable: ['读取历史存储失败，请重新预览；若持续失败，请查看清理诊断。', 'History storage could not be read. Preview again; check cleanup diagnostics if it persists.'],
  storage_io: ['读取历史时发生存储 I/O 错误，请检查存储后重新预览。', 'A storage I/O error occurred. Check storage and preview again.'],
  history_changed: ['历史已变化，请重新预览并确认。', 'History changed. Preview and confirm again.'],
  invalid_preview: ['预览已失效，请重新预览。', 'This preview is no longer valid. Preview again.'],
  expired_preview: ['预览已过期，请重新预览。', 'This preview expired. Preview again.'],
  stale_preview: ['预览选项已变化，请重新预览。', 'Preview options changed. Preview again.'],
  invalid_options: ['清理参数无效。', 'Invalid cleanup options.'],
  cleanup_busy: ['已有清理操作正在进行。', 'A cleanup operation is already pending.'],
  unavailable: ['清理服务当前不可用。', 'History cleanup is currently unavailable.'],
  nothing_to_clean: ['没有符合条件的历史会话。', 'No eligible session history. Nothing to clear.']
};
export function localizeHistoryCleanupIssue(issue: HistoryCleanupIssue, language: string): HistoryCleanupIssue {
  return { ...issue, message: messages[issue.code][language === 'en' ? 1 : 0] };
}
