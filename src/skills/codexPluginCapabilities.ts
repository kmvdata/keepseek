import * as path from 'node:path';
import type { CodexPluginInstallation } from './codexPluginDiscovery';
import type { SkillManifest } from './skillTypes';

export interface CodexPluginCapabilityRequirement {
  id: string;
  label: { en: string; zh: string };
  status: 'available' | 'missing' | 'unverified';
  required: boolean;
}

export interface CodexPluginCapability {
  status: 'readable' | 'executable' | 'partial' | 'missing' | 'unverified';
  requirements: CodexPluginCapabilityRequirement[];
}

const labels = {
  routing: { en: 'Same-package Skill reader', zh: '同包 Skill 读取工具' },
  browser: { en: 'Interactive browser and screenshot capture', zh: '交互式浏览器与截图采集' },
  vision: { en: 'Visual input for screenshot comparison', zh: '用于比较截图的视觉输入' },
  imageGen: { en: 'Workflow Image Gen with visual references', zh: '工作流内可附视觉参考的图像生成' },
  visualChoice: { en: 'User selection from rendered image options', zh: '展示图像选项并接收用户选择' },
  deploy: { en: 'Sites or an equivalent deployment connector', zh: 'Sites 或等价部署连接器' },
  persistence: { en: 'Product Design user-context storage', zh: 'Product Design 用户上下文存储' },
  preflight: { en: 'Product Design script preflight', zh: 'Product Design 脚本前置检查' },
  research: { en: 'Current web research and source retrieval', zh: '实时网页研究与来源检索' },
} satisfies Record<string, CodexPluginCapabilityRequirement['label']>;

type CapabilityId = keyof typeof labels;
interface VerifiedBranch {
  hash: string;
  required: readonly CapabilityId[];
  optional?: readonly CapabilityId[];
}

// Reviewed against the Product Design 0.1.56 installation. Any edited or newer
// document falls back to its declarations and an unverified workflow status.
const productDesignBranches: Readonly<Record<string, VerifiedBranch>> = {
  index: { hash: '8e9916d9e5dc3b6a394bedcaa38cd9c8833a1f3b0c4538b75647cf9f62f779fc', required: ['routing'], optional: ['preflight', 'persistence'] },
  audit: { hash: '087f798c3fe02e91b4cca18cc0f42c358a4dc2c02ccf37a348b476fb19b64aa3', required: ['browser', 'vision'], optional: ['preflight', 'persistence'] },
  ideate: { hash: '649e8782ca93d5aece712964fae5be2b111cc3143577e1507b98df7f9d8e6bde', required: ['imageGen', 'visualChoice'], optional: ['vision', 'preflight', 'persistence'] },
  'image-to-code': { hash: '694b4102bc339e3038173f8063d83a19e08d2a2cfab1f2e478d6412870a61ff0', required: ['vision', 'browser', 'preflight'], optional: ['imageGen', 'deploy', 'persistence'] },
  'url-to-code': { hash: '2624d0e2ec5f14ba2a4bf74fe05aaa23520b4fb76ca57973c9dadd54fd4b09d2', required: ['browser', 'vision', 'preflight'], optional: ['imageGen', 'deploy', 'persistence'] },
  share: { hash: '19327c50a52f3b9e2ebfcef47d394d988bd6f4c64524c98f665d43bdf5f02c45', required: ['deploy'], optional: ['preflight', 'persistence'] },
  'user-context': { hash: '5690a7f99cf896970493f5d0bd7f35f62ab9cbe21744352acf84dc0ceea4194c', required: ['persistence', 'preflight'] },
  'design-qa': { hash: '19303684c7c84e279f3582d784493a6f09d207d92a29e9b15b7056020bcf306e', required: ['browser', 'vision'] },
  'get-context': { hash: '151267c873003b7b03715c0842ef798369420464844218492f732edd2f6f7fd1', required: [], optional: ['preflight', 'persistence'] },
  research: { hash: 'bf824e72dd93941c8d591e4af13bb7e3a09380cd6ed7dd8c1f61a295648fa023', required: ['research'], optional: ['preflight', 'persistence'] }
};

function getVerifiedBranch(installation: CodexPluginInstallation, skillPath: string, documentHash?: string): [string, VerifiedBranch] | undefined {
  if (installation.name !== 'product-design' || installation.marketplace !== 'openai-curated-remote' || installation.version !== '0.1.56') return;
  const relative = path.relative(installation.skillsPath, skillPath).split(path.sep);
  if (relative.length !== 2 || relative[1] !== 'SKILL.md') return;
  const branch = productDesignBranches[relative[0]];
  if (branch?.hash === documentHash) return [relative[0], branch];
}

export function describeCodexPluginCapability(
  installation: CodexPluginInstallation,
  skillPath: string,
  dependencies: SkillManifest['dependencies'],
  context?: { availableTools: readonly string[]; routingAvailable?: boolean },
  documentHash?: string
): CodexPluginCapability {
  const declared: CodexPluginCapabilityRequirement[] = (dependencies ?? []).map(item => {
    const id = `${item.type}:${item.value}`;
    // Codex MCP identifiers cannot be resolved by matching a KeepSeek function name.
    const native = item.type === 'function' && item.value.startsWith('keepseek_');
    const status = native && context?.availableTools.includes(item.value)
      ? 'available' : native && !context ? 'unverified' : 'missing';
    return { id, label: { en: id, zh: id }, status, required: true };
  });
  const verified = getVerifiedBranch(installation, skillPath, documentHash);
  const known = verified?.[1];
  const requirements = [...declared];
  for (const [required, ids] of [[true, known?.required], [false, known?.optional]] as const) {
    for (const id of ids ?? []) {
      const status = id !== 'routing' ? 'missing'
        : context?.routingAvailable === undefined ? 'unverified' : context.routingAvailable ? 'available' : 'missing';
      requirements.push({ id, label: labels[id], status, required });
    }
  }
  if (requirements.some(item => item.required && item.status === 'missing')) return { status: 'missing', requirements };
  if (requirements.some(item => item.required && item.status === 'unverified')) return { status: 'unverified', requirements };
  if (verified?.[0] === 'index') return { status: 'readable', requirements };
  if (!known) return { status: 'unverified', requirements };
  return { status: requirements.some(item => item.status !== 'available') ? 'partial' : 'executable', requirements };
}

export function formatCodexPluginCapability(capability: CodexPluginCapability): string {
  return [`Workflow status: ${capability.status}`, ...capability.requirements.map(item =>
    `- ${item.label.en} / ${item.label.zh}: ${item.status} (${item.required ? 'required / 必需' : 'conditional / 视任务而定'})`)].join('\n');
}
