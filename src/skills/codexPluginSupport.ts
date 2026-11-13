/** Temporary product suspension. This is deliberately not a user setting. */
export function isCodexPluginSkillsEnabled(): boolean {
  return false;
}

export const CODEX_PLUGIN_SKILLS_UNAVAILABLE = 'Codex plugin Skills are temporarily disabled. Use standalone Skills. / Codex 插件 Skills 已暂时停用，请使用独立 Skills。';

export function assertCodexPluginSkillsEnabled(): void {
  if (!isCodexPluginSkillsEnabled()) throw new Error(CODEX_PLUGIN_SKILLS_UNAVAILABLE);
}

export function isCodexPluginSkill(skill: { source?: string; pluginInstallation?: unknown; pluginSnapshot?: unknown }): boolean {
  return skill.source === 'codexPlugin' || skill.pluginInstallation !== undefined || skill.pluginSnapshot !== undefined;
}
