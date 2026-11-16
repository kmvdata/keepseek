import type { ApprovalMode } from '../shared/types';

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'approve-all' ? value : 'ask';
}

/** Append only to a new user message. Never regenerate a historical prefix. */
export function getApprovalModeUserTail(mode: ApprovalMode): string {
  const validation = 'Use keepseek_run_validation only when validation is required for the task and the target package.json defines the matching compile, lint, or test script. A local Git-only task does not require extra validation unless the user or project explicitly requires it.';
  const git = [
    'For local Git, prefer keepseek_git_status and keepseek_git_diff when workspaceFolder identifies the requested repository.',
    'Use a controlled DraftRun when exact cwd or pathspec is required.',
    'Stage and commit through separate DraftRuns using direct Git argv.',
    'Wait for the actual staging result, inspect the index, and write the commit message in the requested language from that evidence.',
    'Pass -a and -m separately when needed and give every -m exactly one complete message argument.'
  ].join(' ');
  return mode === 'approve-all'
    ? '<keepseek-approval-mode>approve-all: The user selected Approve all. Propose exact immutable DraftEdits and DraftRuns. ' + validation + ' ' + git + ' The host approves and executes every required side effect immediately after the draft is created; there is no reviewer and no confirmation prompt. Because nothing checks your proposal afterwards, verify the exact target, executable, literal arguments and working directory yourself before proposing, describe each command honestly, and continue the task from the actual recorded results. Never repeat an effect whose result is already recorded, and never claim a command ran before its verified result arrives.</keepseek-approval-mode>'
    : '<keepseek-approval-mode>ask: The user selected project-wide Ask for approval. File writes and arbitrary commands require individual user approval. ' + validation + ' Prepare pending drafts and wait for their results.</keepseek-approval-mode>';
}

export function draftRunPreparedMessage(mode: ApprovalMode | undefined, language: 'zh-CN' | 'en'): string {
  const approval = normalizeApprovalMode(mode);
  if (language === 'en') return 'DraftRun prepared only; no process was started. ' + (approval === 'ask'
    ? 'Wait for the user to approve this execution in KeepSeek.'
    : 'The host approves and starts this execution immediately, then reports the actual result.');
  return '仅准备了 DraftRun 草稿，尚未执行。' + (approval === 'ask' ? '等待用户在 KeepSeek 中批准本次执行。'
    : '宿主将立即批准并启动本次执行，随后如实回报实际结果。');
}