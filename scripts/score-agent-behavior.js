#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
const recordsPath = process.argv[2];
if (!recordsPath) {
  process.stderr.write('Usage: node scripts/score-agent-behavior.js <records.jsonl>\n');
  process.exitCode = 2;
  return;
}

const evaluation = require(path.join(workspaceRoot, 'out', 'agent', 'behaviorEvaluation.js'));
const scenarios = JSON.parse(fs.readFileSync(
  path.join(workspaceRoot, 'eval', 'agent-behavior', 'cases.json'),
  'utf8'
));
const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
const records = fs.readFileSync(path.resolve(recordsPath), 'utf8')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });

const scored = records.map((record) => {
  if (!evaluation.isBehaviorEvalRunRecord(record)) {
    throw new Error(`Invalid behavior evaluation record for scenario ${record?.scenarioId ?? '<unknown>'}.`);
  }
  const scenario = scenariosById.get(record.scenarioId);
  if (!scenario || !evaluation.isBehaviorEvalScenario(scenario)) {
    throw new Error(`Unknown or invalid behavior evaluation scenario: ${record.scenarioId}`);
  }
  return {
    configuration: record.configuration,
    score: evaluation.scoreBehaviorEvalRun(scenario, record)
  };
});

const groups = new Map();
for (const item of scored) {
  const key = JSON.stringify(item.configuration);
  const group = groups.get(key) ?? { configuration: item.configuration, scores: [] };
  group.scores.push(item.score);
  groups.set(key, group);
}

const summary = [...groups.values()].map((group) => ({
  configuration: group.configuration,
  runCount: group.scores.length,
  averageScore: average(group.scores.map((score) => score.total)),
  completionRate: average(group.scores.map((score) => score.taskCompleted ? 1 : 0)),
  evidenceRate: average(group.scores.map((score) => score.evidenceGrounded ? 1 : 0)),
  falseClaimRate: average(group.scores.map((score) => score.falseWriteClaim || score.falseValidationClaim ? 1 : 0)),
  averageToolCalls: average(group.scores.map((score) => score.toolCallCount)),
  averageInvalidToolCalls: average(group.scores.map((score) => score.invalidToolCallCount)),
  averageInputTokens: average(group.scores.map((score) => score.inputTokens)),
  averageOutputTokens: average(group.scores.map((score) => score.outputTokens)),
  averageToolResultTokens: average(group.scores.map((score) => score.toolResultTokens)),
  averageToolRounds: average(group.scores.map((score) => score.toolRounds)),
  averageDurationMs: average(group.scores.map((score) => score.durationMs)),
  averagePartialResultQuality: average(group.scores.map((score) => score.partialResultQuality))
}));

process.stdout.write(`${JSON.stringify({ summary, runs: scored }, null, 2)}\n`);

function average(values) {
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : 0;
}
