import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deduplicateContextSources } from '../src/agent/contextDeduplication';
import {
  createContextUsageEstimate,
  createContextUsageEstimateFromMessages
} from '../src/agent/contextUsage';
import { buildCurrentRunContext } from '../src/agent/currentRunContext';
import { hashContent } from '../src/agent/projectInstructions';
import { buildInitialAgentMessages } from '../src/agent/protocol';
import { getSupportedDeepSeekV4Models } from '../src/shared/modelProfiles';
import type { ActivatedSkill, ProjectInstructionContext } from '../src/shared/types';

test('deduplicates exact normalized URIs before consuming context budget', () => {
  const result = deduplicateContextSources([
    candidate('first', 'file:///workspace/AGENTS.md', 'first content', 30),
    candidate('second', 'file:///workspace/AGENTS.md/', 'different content', 40)
  ]);

  assert.deepEqual(result.kept.map((item) => item.id), ['first']);
  assert.equal(result.discarded[0]?.reason, 'duplicate_uri');
  assert.equal(result.discarded[0]?.keptId, 'first');
});

test('deduplicates exact content hashes across different URIs', () => {
  const content = 'Identical durable rule.';
  const result = deduplicateContextSources([
    candidate('first', 'file:///workspace/AGENTS.md', content, 30),
    candidate('second', 'file:///personal/SKILL.md', content, 60)
  ]);

  assert.deepEqual(result.kept.map((item) => item.id), ['first']);
  assert.equal(result.discarded[0]?.reason, 'duplicate_content');
});

test('current-run context preserves project, explicit, default, implicit, and Legacy priority', () => {
  const project = projectInstruction('Project architecture rules.');
  const context = buildCurrentRunContext({
    projectInstructions: { instructions: [project], discarded: [] },
    skills: [
      skill('implicit', 'Implicit flow.', 'implicit'),
      skill('default', 'Default flow.', 'workspace-default'),
      skill('explicit', 'Explicit flow.', 'explicit')
    ],
    legacyMemory: {
      content: '- [project_note] Legacy fallback.',
      entryIds: ['legacy-1'],
      tokenEstimate: 8,
      sourceUris: ['file:///workspace/.keepseek/memory.json']
    },
    skillCharacterBudget: 10_000
  });

  assert.deepEqual(context.skills.map((item) => item.activation?.source), [
    'explicit',
    'workspace-default',
    'implicit'
  ]);
  assert.deepEqual(context.metadata.sources.map((item) => item.kind), [
    'project-instructions',
    'skill',
    'skill',
    'skill',
    'legacy-memory'
  ]);

  const messages = buildInitialAgentMessages({
    prompt: 'Current explicit request.',
    contextFiles: [],
    currentRunContext: context,
    history: [],
    language: 'en'
  });
  const current = messages.at(-1)?.content ?? '';
  assert.ok(current.indexOf('Project architecture rules.') < current.indexOf('Explicit flow.'));
  assert.ok(current.indexOf('Explicit flow.') < current.indexOf('Default flow.'));
  assert.ok(current.indexOf('Default flow.') < current.indexOf('Implicit flow.'));
  assert.ok(current.indexOf('Implicit flow.') < current.indexOf('Legacy fallback.'));
  assert.ok(current.endsWith('Current explicit request.'));
});

test('Skill character budget is enforced before AgentRunner consumes current-run context', () => {
  const context = buildCurrentRunContext({
    projectInstructions: { instructions: [], discarded: [] },
    skills: [skill('large', 'x'.repeat(500), 'implicit')],
    skillCharacterBudget: 120
  });

  assert.equal(context.skills.length, 1);
  assert.equal(context.metadata.sources[0]?.truncated, true);
  assert.ok(context.skills[0].content.length <= 200);
  assert.equal(context.metadata.truncated, true);

  const exhausted = buildCurrentRunContext({
    projectInstructions: { instructions: [], discarded: [] },
    skills: [skill('tiny-budget', 'large instructions', 'implicit')],
    skillCharacterBudget: 1
  });
  assert.deepEqual(exhausted.skills, []);
  assert.equal(exhausted.metadata.discarded.at(-1)?.reason, 'budget_exhausted');
});

test('contextUsage estimates the exact same current-run message projection as the Agent request', () => {
  const currentRunContext = buildCurrentRunContext({
    projectInstructions: { instructions: [projectInstruction('Use the shared projection.')], discarded: [] },
    skills: [skill('explicit', 'Follow the exact workflow.', 'explicit')],
    skillCharacterBudget: 10_000
  });
  const model = getSupportedDeepSeekV4Models()[0];
  const prompt = 'Check the projection.';
  const messages = buildInitialAgentMessages({
    prompt,
    contextFiles: [],
    currentRunContext,
    history: [],
    language: 'en'
  });
  const usage = createContextUsageEstimate({
    model,
    agentSettings: { thinkingEnabled: false, reasoningEffort: 'high' },
    contextFiles: [],
    currentRunContext,
    messages: [],
    language: 'en',
    prompt,
    includeTools: false,
    outputReserveTokens: 0,
    safetyReserveTokens: 0
  });
  const direct = createContextUsageEstimateFromMessages({
    model,
    messages,
    tools: [],
    outputReserveTokens: 0,
    safetyReserveTokens: 0
  });

  assert.equal(usage.usedTokensEstimate, direct.usedTokensEstimate);
});

function candidate(id: string, uri: string, content: string, priority: number) {
  return {
    id,
    kind: id === 'first' ? 'project-instructions' as const : 'skill' as const,
    label: id,
    uri,
    content,
    contentHash: hashContent(content),
    priority,
    value: id
  };
}

function projectInstruction(content: string): ProjectInstructionContext {
  return {
    id: 'project-root',
    uri: 'file:///workspace/AGENTS.md',
    workspaceFolder: 'workspace',
    content,
    characterCount: content.length,
    tokenEstimate: 10,
    contentHash: hashContent(content),
    truncated: false
  };
}

function skill(id: string, content: string, activation: NonNullable<ActivatedSkill['activation']>['source']): ActivatedSkill {
  return {
    id,
    name: `${id}-skill`,
    description: `${id} workflow`,
    source: activation === 'workspace-default' || activation === 'implicit' ? 'agentsWorkspace' : 'agentsUser',
    rootUri: `file:///skills/${id}`,
    skillUri: `file:///skills/${id}/SKILL.md`,
    content,
    hasScripts: false,
    activation: { source: activation, reason: `${activation} test` }
  };
}
