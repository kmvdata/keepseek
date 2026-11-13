import { parseDocument, visit } from 'yaml';

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  runAs?: 'subagent';
  profile?: string;
  tools?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  canDelegate?: boolean;
  resultMaxChars?: number;
}
export interface SkillMetadata {
  interface?: Record<string, string>;
  allowImplicit: boolean;
  dependencies: Array<{ type: string; value: string; description?: string }>;
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: expected a mapping / 应为映射`);
  return value as Record<string, unknown>;
}
export function parseSafeYaml(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 65536) throw new Error('YAML exceeds 64 KiB / YAML 超过 64 KiB');
  const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid YAML, duplicate key or unsupported tag / YAML 错误、重复字段或不支持的标签');
  let nodes = 0;
  visit(doc, (_key, node, ancestors) => {
    if (++nodes > 4096 || ancestors.length > 32) throw new Error('YAML structure exceeds limits / YAML 结构超限');
    if (node && typeof node === 'object' && 'anchor' in node && node.anchor) throw new Error('YAML anchors are unsupported / 不支持 YAML 锚点');
  });
  try { return object(doc.toJS({ maxAliasCount: 0 }), 'YAML'); }
  catch { throw new Error('YAML aliases or non-mapping root are unsupported / 不支持 YAML 别名或非映射根节点'); }
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field}: required text, max ${max} / 必填文本超限或类型错误`);
  return value.trim();
}
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error('SKILL.md requires YAML name and description / SKILL.md 需 YAML name 和 description');
  const raw = parseSafeYaml(match[1]);
  const result: ParsedSkillFrontmatter = { name: requiredText(raw.name, 'name', 64), description: requiredText(raw.description, 'description', 1024) };
  // KeepSeek-only execution profiles remain optional and never grant tool permission.
  const extension = raw.metadata && object(raw.metadata, 'metadata').keepseek;
  if (extension !== undefined) {
    const value = object(extension, 'metadata.keepseek');
    if (value.runAs !== undefined && value.runAs !== 'subagent') throw new Error('metadata.keepseek.runAs: expected subagent');
    if (value.runAs === 'subagent') result.runAs = 'subagent';
    if (value.profile !== undefined) result.profile = requiredText(value.profile, 'profile', 80);
    if (value.tools !== undefined) {
      if (!Array.isArray(value.tools) || value.tools.length > 64 || value.tools.some(tool => typeof tool !== 'string')) throw new Error('metadata.keepseek.tools: expected string array');
      result.tools = [...new Set(value.tools as string[])];
    }
    for (const [key, min, max] of [['maxSteps', 1, 32], ['timeoutMs', 1000, 900000], ['resultMaxChars', 1000, 500000]] as const) {
      if (value[key] === undefined) continue;
      if (!Number.isInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) throw new Error(`metadata.keepseek.${key}: invalid limit`);
      result[key] = value[key] as number;
    }
    if (value.canDelegate !== undefined) {
      if (typeof value.canDelegate !== 'boolean') throw new Error('metadata.keepseek.canDelegate: expected boolean');
      result.canDelegate = value.canDelegate;
    }
  }
  return result;
}
export function parseSkillMetadata(text?: string): SkillMetadata {
  if (text === undefined) return { allowImplicit: true, dependencies: [] };
  const raw = parseSafeYaml(text);
  const result: SkillMetadata = { allowImplicit: true, dependencies: [] };
  if (raw.interface !== undefined) {
    const fields = object(raw.interface, 'interface');
    result.interface = {};
    for (const key of ['display_name', 'short_description', 'icon_small', 'icon_large', 'brand_color', 'default_prompt']) {
      if (fields[key] !== undefined) result.interface[key] = requiredText(fields[key], `interface.${key}`, 4096);
    }
  }
  if (raw.policy !== undefined) {
    const policy = object(raw.policy, 'policy');
    if (policy.allow_implicit_invocation !== undefined) {
      if (typeof policy.allow_implicit_invocation !== 'boolean') throw new Error('policy.allow_implicit_invocation: expected boolean / 应为布尔值');
      result.allowImplicit = policy.allow_implicit_invocation;
    }
  }
  if (raw.dependencies !== undefined) {
    const dependencies = object(raw.dependencies, 'dependencies');
    if (dependencies.tools !== undefined) {
      if (!Array.isArray(dependencies.tools) || dependencies.tools.length > 64) throw new Error('dependencies.tools: expected a bounded array / 应为有界数组');
      result.dependencies = dependencies.tools.map(item => {
        const tool = object(item, 'dependencies.tools');
        return { type: requiredText(tool.type, 'dependency.type', 64), value: requiredText(tool.value, 'dependency.value', 256),
          ...(tool.description !== undefined ? { description: requiredText(tool.description, 'dependency.description', 1024) } : {}) };
      });
    }
  }
  return result;
}
