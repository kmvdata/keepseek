import * as path from 'node:path';
import type {
  DraftRunEffect,
  DraftRunEffectAssessment,
  DraftRunSpec
} from '../shared/types';

const NETWORK_PATTERN = /(?:\b(?:curl|wget|ssh|scp|sftp|ftp|nc|ncat|telnet)\b|\b(?:git|gh)\s+(?:clone|fetch|pull|push)\b|https?:\/\/)/iu;
const PACKAGE_INSTALL_PATTERN = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add|remove|uninstall|update|upgrade|publish)\b|\b(?:pipx?|uv|gem|cargo|go)\s+(?:install|add|remove|uninstall|update|upgrade|publish|get)\b|\b(?:apt|apt-get|brew|choco|dnf|pacman|winget|yum)\s+(?:install|add|remove|uninstall|update|upgrade)\b)/iu;
const DESTRUCTIVE_PATTERN = /(?:\b(?:rm|rmdir|del|erase|unlink|truncate|mkfs|format)\b|\bfind\b[^\n]*(?:-delete|-exec)|\bsed\b[^\n]*\s-i(?:\s|$)|(?:^|[^<])>{1,2}(?!>))/iu;
const WORKSPACE_WRITE_PATTERN = /\b(?:cp|mv|mkdir|touch|install|tee|patch)\b/iu;
const GIT_MUTATION_PATTERN = /\bgit\s+(?:add|apply|am|branch|checkout|clean|clone|commit|fetch|gc|init|merge|mv|pull|push|rebase|remote|reset|restore|revert|rm|stash|switch|tag|worktree)\b/iu;
const PUBLISH_PATTERN = /\b(?:publish|deploy|release)\b/iu;
const PRIVILEGE_PATTERN = /\b(?:sudo|doas|runas|pkexec)\b/iu;
const CREDENTIAL_PATTERN = /(?:\b(?:printenv|env|set)\b|\.ssh|\.aws|\.npmrc|\.pypirc|keychain|credential|password|secret|token)/iu;
const INTERPRETER_PATTERN = /(?:^|[/\\])(?:ba|z|fi|k|c)?sh(?:\.exe)?$|(?:^|[/\\])(?:cmd|powershell|pwsh|python\d*|node|ruby|perl)(?:\.exe)?$/iu;
const LONG_RUNNING_PATTERN = /\b(?:watch|serve|server|dev|start)\b/iu;

// Validation keeps its deliberately narrow deny-list semantics. DraftRun uses
// the richer assessment below for warnings, while user approval remains the
// authority for every arbitrary command.
const VALIDATION_BLOCKING_PATTERN = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|publish|deploy)\b|\bgit\s+push\b|\brm\s+(?:-[^\s]+\s+)*|\b(?:curl|wget)\b|\b(?:deploy|publish)\b)/iu;

export function hasValidationBlockingRisk(command: string): boolean {
  return VALIDATION_BLOCKING_PATTERN.test(command);
}

export function analyzeDraftRunEffects(spec: DraftRunSpec): DraftRunEffectAssessment {
  const commandText = [spec.executable, ...spec.args].join(' ');
  const effects = new Set<DraftRunEffect>(['workspace_read']);
  const evidence: string[] = [];
  const add = (effect: DraftRunEffect, message: string) => {
    effects.add(effect);
    evidence.push(message);
  };

  if (spec.externalCwd) {
    add('external_write', 'The working directory is outside the open workspace.');
  }
  if (NETWORK_PATTERN.test(commandText)) {
    add('network', 'The command may access the network.');
  }
  if (PACKAGE_INSTALL_PATTERN.test(commandText)) {
    add('package_install', 'The command may install, remove, update, or publish packages.');
    effects.add('workspace_write');
  }
  if (DESTRUCTIVE_PATTERN.test(commandText)) {
    add('workspace_write', 'The command contains deletion, truncation, in-place editing, or output redirection syntax.');
  } else if (WORKSPACE_WRITE_PATTERN.test(commandText)) {
    add('workspace_write', 'The command may create, copy, move, or overwrite files.');
  }
  if (GIT_MUTATION_PATTERN.test(commandText)) {
    add('git_mutation', 'The command may mutate Git state or communicate with a remote.');
  }
  if (PUBLISH_PATTERN.test(commandText)) {
    add('publish_or_deploy', 'The command may publish, deploy, or release artifacts.');
  }
  if (PRIVILEGE_PATTERN.test(commandText)) {
    add('privilege_escalation', 'The command requests elevated privileges.');
  }
  if (CREDENTIAL_PATTERN.test(commandText)) {
    add('credential_access', 'The command may read or expose environment variables or credentials.');
  }
  if (INTERPRETER_PATTERN.test(path.basename(spec.executable))) {
    add('shell_interpreter', 'The executable is a shell or general-purpose interpreter.');
    effects.add('arbitrary_code');
  }
  if (LONG_RUNNING_PATTERN.test(commandText)) {
    add('long_running', 'The command may start a long-running process.');
  }

  const sensitive = [...effects].some((effect) => effect !== 'workspace_read' && effect !== 'long_running');
  const verdict: DraftRunEffectAssessment['verdict'] = sensitive
    ? 'mutating_or_sensitive'
    : effects.has('long_running')
      ? 'unknown'
      : isLikelyReadOnlyExecutable(spec.executable, spec.args)
        ? 'likely_readonly'
        : 'unknown';
  if (!evidence.length) {
    evidence.push(verdict === 'likely_readonly'
      ? 'Static analysis found no obvious mutation or network syntax; this is advisory, not a safety proof.'
      : 'The executable is not in the small advisory read-only set; its effects are unknown.');
  }
  if (verdict === 'unknown') {
    effects.add('unknown');
  }

  return {
    version: 1,
    verdict,
    effects: [...effects],
    evidence
  };
}

function isLikelyReadOnlyExecutable(executable: string, args: readonly string[]): boolean {
  const name = path.basename(executable).toLowerCase().replace(/\.exe$/u, '');
  if (['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'grep', 'rg'].includes(name)) {
    return !args.some((arg) => /^(?:--pre|--hostname-bin|-P|-exec|-delete)$/u.test(arg));
  }
  if (name === 'git') {
    const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase();
    return Boolean(subcommand && ['status', 'diff', 'log', 'show', 'branch', 'rev-parse'].includes(subcommand));
  }
  return false;
}
