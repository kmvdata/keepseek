import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME
} from '../src/agent/protocol';
import { getBuiltInReadToolNames, resolveSubagentProfile } from '../src/agent/subagents/profiles';
import type { ActivatedSkill } from '../src/shared/types';

function skill(input: {
  name: string;
  tools?: string[];
  canDelegate?: boolean;
  maxSteps?: number;
}): ActivatedSkill {
  return {
    id: `skill:${input.name}`,
    name: input.name,
    content: 'Delegate this bounded task.',
    runAs: 'subagent',
    subagentProfile: {
      id: input.name,
      tools: input.tools,
      canDelegate: input.canDelegate,
      maxSteps: input.maxSteps
    }
  } as unknown as ActivatedSkill;
}

test('built-in profiles keep read-only and proposal tool sets apart', () => {
  const research = resolveSubagentProfile({ requestedId: 'research' });
  assert.ok(research);
  assert.deepEqual(research.toolNames, getBuiltInReadToolNames());
  assert.equal(research.lane, 'research-read');
  assert.equal(research.canDelegate, true);

  const proposal = resolveSubagentProfile({ requestedLane: 'proposal' });
  assert.ok(proposal);
  assert.ok(proposal.toolNames.includes(CREATE_DRAFT_EDIT_TOOL_NAME));
  assert.ok(proposal.toolNames.includes(APPLY_PATCH_TOOL_NAME));
  assert.ok(proposal.toolNames.includes(RUN_DRAFT_TOOL_NAME));
  assert.equal(proposal.lane, 'proposal');
  assert.equal(proposal.canDelegate, false);
});

test('a Skill profile takes its tools from its own declaration, not from canDelegate', () => {
  const proposalLike = resolveSubagentProfile({
    requestedId: 'edit-helper',
    skills: [skill({
      name: 'edit-helper',
      tools: [READ_WORKSPACE_FILE_TOOL_NAME, CREATE_DRAFT_EDIT_TOOL_NAME],
      canDelegate: false
    })]
  });
  assert.ok(proposalLike);
  assert.deepEqual(proposalLike.toolNames, [READ_WORKSPACE_FILE_TOOL_NAME, CREATE_DRAFT_EDIT_TOOL_NAME]);
  assert.equal(proposalLike.lane, 'proposal');
  assert.equal(proposalLike.canDelegate, false);

  const readLike = resolveSubagentProfile({
    requestedId: 'facts',
    skills: [skill({ name: 'facts', tools: [FIND_SYMBOL_TOOL_NAME], canDelegate: true })]
  });
  assert.ok(readLike);
  assert.deepEqual(readLike.toolNames, [FIND_SYMBOL_TOOL_NAME]);
  assert.equal(readLike.lane, 'research-read');
  assert.equal(readLike.canDelegate, true);
});

test('declared tool names outside the known child allowlist are dropped', () => {
  const profile = resolveSubagentProfile({
    requestedId: 'sneaky',
    skills: [skill({ name: 'sneaky', tools: [READ_WORKSPACE_FILE_TOOL_NAME, 'execute_shell'] })]
  });
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [READ_WORKSPACE_FILE_TOOL_NAME]);
  assert.equal(profile.lane, 'research-read');
});

test('a Skill profile without a tool declaration stays read-only', () => {
  const profile = resolveSubagentProfile({ requestedId: 'plain', skills: [skill({ name: 'plain' })] });
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, getBuiltInReadToolNames());
  assert.equal(profile.lane, 'research-read');
  assert.equal(profile.resultMaxChars, 120_000);
});

test('a Skill profile keeps its bounded step limit', () => {
  const profile = resolveSubagentProfile({ requestedId: 'limited', skills: [skill({ name: 'limited', maxSteps: 7 })] });
  assert.ok(profile);
  assert.equal(profile.maxSteps, 7);
});

test('an unknown profile id resolves to nothing', () => {
  assert.equal(resolveSubagentProfile({ requestedId: 'missing' }), undefined);
});
