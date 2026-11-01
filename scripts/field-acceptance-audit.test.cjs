const { test } = require('node:test');
const assert = require('node:assert/strict');
const { union, summarizePerformance, reconcileChildren } = require('./field-acceptance-audit.cjs');
test('child counts use stable or legacy identity and never turn missing summary counts into known zero',()=>{
  const summaries=[{subagentId:'a',usage:{providerAttemptCount:2,usageResponseCount:1}},{subagentId:'b'}];
  const records=[{subagentId:'a',kind:'usage_response'},{cacheObservation:{conversationId:'a'},kind:'attempt_without_usage'}];
  const rows=reconcileChildren(summaries,records);
  assert.equal(rows[0].countsMatch,true);assert.equal(rows[0].ledgerUsage,1);
  assert.equal(rows[1].summaryAttempts,null);assert.equal(rows[1].countsMatch,null);
});
test('overlapping provider/storage/nested saves use union, missing intervals stay unknown, private data is excluded', () => {
  assert.equal(union([[0,10],[5,15],[15,20],[2,4]]),20);
  const event=(seq,type,monotonicMs,extra={})=>({ seq,type,monotonicMs,runId:'run',sessionId:'session',...extra });
  const rows=[event(1,'run_start',0,{prompt:'PRIVATE'}),event(2,'upstream_attempt_start',10,{requestId:'r',attempt:0}),
    event(3,'checkpoint_store',40,{durationMs:20}),event(4,'checkpoint_save',42,{durationMs:32}),
    event(5,'upstream_attempt_finish',50,{requestId:'r',attempt:0}),event(6,'upstream_attempt_start',55,{requestId:'open'}),event(7,'run_end',60)];
  const s=summarizePerformance(rows.concat(rows[2]),{ droppedEvents:0,writeFailures:0,rotated:false });
  assert.equal(s.providerCompletedUnionMs,40);assert.equal(s.persistenceUnionMs,20);
  assert.equal(s.providerAndPersistenceOverlapMs,20);assert.equal(s.observationWallMs,60);
  assert.deepEqual(s.openProviderAttempts,['open:0']);assert.equal(s.counts.checkpoint_store,1);
  assert.equal(s.approvalWaitMs,null);assert.doesNotMatch(JSON.stringify(s),/PRIVATE/);
  assert.equal(summarizePerformance(rows.slice(1),{droppedEvents:1}).traceComplete,false);
});
