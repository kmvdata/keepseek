import * as vscode from 'vscode';
import { formatCodexPluginCapability } from '../skills/codexPluginCapabilities';
import { readCodexPluginResource, validateCodexPluginSnapshot, type CodexPluginReadContext } from '../skills/codexPluginResources';
import { validateCodexPluginSkill } from '../skills/skillDiscovery';
import { assertCodexPluginSkillsEnabled, isCodexPluginSkill } from '../skills/codexPluginSupport';
import type { ActivatedSkill, AgentRequest } from '../shared/types';
import { stableStringify } from './evidence/shaping';
import { READ_PLUGIN_SKILL_TOOL_NAME } from './protocol';
import { AgentInterruptedError, getCheckpointPluginSnapshot, type PluginSkillProgress, type RunCheckpoint } from './runCheckpoint';

/** Recheck live permission without replacing the pinned package or loaded bytes. */
export async function assertPluginSkillsCurrent(skills: readonly ActivatedSkill[], availableTools: readonly string[],
  checkpoint?: RunCheckpoint): Promise<void> {
  for (const skill of skills) {
    if (!isCodexPluginSkill(skill)) continue;
    try {
      assertCodexPluginSkillsEnabled();
      const snapshot = checkpoint ? getCheckpointPluginSnapshot(checkpoint, skill) : skill.pluginSnapshot;
      if (!snapshot) throw new Error('Missing plugin package pin / 缺少插件版本快照');
      await validateCodexPluginSnapshot(snapshot, createReadContext(skill, availableTools));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new AgentInterruptedError('waiting_for_user', `${skill.name}: ${reason}`);
    }
  }
}

export async function executePluginSkillRead(
  request: AgentRequest | undefined,
  args: Record<string, unknown>,
  availableTools: readonly string[]
): Promise<{ content: string; progress: PluginSkillProgress }> {
  assertCodexPluginSkillsEnabled();
  const checkpoint = request?.checkpoint;
  const skill = checkpoint?.request.currentRunContext?.skills.find(item => item.id === args.skillId);
  const snapshot = checkpoint && skill && getCheckpointPluginSnapshot(checkpoint, skill);
  if (!request || request.subagentContext || request.persona || !skill || !snapshot) {
    throw new Error('Explicitly select a Codex plugin Skill for this task. / 请在当前任务中显式选择 Codex 插件 Skill。');
  }
  const { reference, mode, from } = args;
  if (typeof reference !== 'string' || (mode !== 'read' && mode !== 'route') || (from !== undefined && typeof from !== 'string')) {
    throw new Error('Invalid plugin Skill reference or mode. / 插件 Skill 引用或读取模式无效。');
  }
  const { snapshot: next, hash, ...result } = await readCodexPluginResource(
    snapshot, { reference, mode, from }, createReadContext(skill, availableTools)
  );
  const blocked = mode === 'route' && result.content === undefined;
  return {
    content: stableStringify({
      ...result,
      ok: !blocked,
      status: blocked ? 'workflow_blocked' : mode === 'route' ? 'workflow_routed' : 'read_only',
      errorType: blocked ? 'plugin_workflow_unavailable' : undefined,
      error: blocked && result.capability ? formatCodexPluginCapability(result.capability) : undefined,
      plugin: snapshot.installation.name,
      version: snapshot.installation.version,
      marketplace: snapshot.installation.marketplace,
      contentHash: hash,
      workflowExecutionAllowed: mode === 'route' && !blocked,
      requiredCapabilitiesVerified: result.capability !== undefined
        && (result.capability.status === 'executable' || result.capability.status === 'partial' || result.capability.status === 'readable')
    }),
    progress: { skillId: skill.id, progress: next.progress }
  };
}

function createReadContext(skill: ActivatedSkill, availableTools: readonly string[]): CodexPluginReadContext {
  return {
    isTrusted: vscode.workspace.isTrusted,
    availableTools,
    routingAvailable: availableTools.includes(READ_PLUGIN_SKILL_TOOL_NAME),
    validateInstallation: (installation, skillPath, name) => validateCodexPluginSkill(installation, skillPath, skill.pluginPolicyCwd, name)
  };
}
