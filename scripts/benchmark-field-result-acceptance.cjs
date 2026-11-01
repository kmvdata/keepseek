/* Measure full canonical acceptance separately from small-page reading.
 * Synthetic bodies, real durable temp storage, VS Code stub, no Provider.
 * node scripts/benchmark-field-result-acceptance.cjs > OUTPUT.json
 */
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const modules = path.resolve('out-test');
require(path.join(modules,'test/registerVscodeStub'));
const vscode = require(path.join(modules,'test/stubs/vscode'));
const { SubagentStore } = require(path.join(modules,'src/agent/subagents/store'));
const sha = text=>createHash('sha256').update(text).digest('hex');
async function sample(layout, size, privateBytes, round) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'keepseek-acceptance-bench-'));
  const originalRead = vscode.workspace.fs.readFile, originalOpen = fs.open;
  try {
    const result=JSON.stringify({ taskHash:sha('fixture'),status:'complete',summary:'Synthetic canonical',evidence:[{claim:'中文😀'.repeat(Math.ceil(size/10))}],uncertainties:[] });
    const metadata={version:2,id:'child',treeId:'tree',parentSessionId:'parent',parentRunId:'root',rootRunId:'root',depth:1,
      profile:'research',lane:'research-read',task:'Synthetic',status:'completed',resultStatus:'complete',resultFormatAccepted:true,resultContractVersion:2,
      sourceId:'source',modelId:'fixture',provider:'deepseek',sourceConfigHash:sha('s'),systemPromptHash:sha('sys'),toolSchemaHash:sha('t'),
      profileHash:sha('p'),projectInstructionsHash:sha('i'),normalizedTaskHash:sha('fixture'),
      resultHash:sha(result),resultBytes:Buffer.byteLength(result),resultChars:result.length,createdAt:'',updatedAt:''};
    const transcript={version:2,metadataId:'child',contextInstructions:'Private synthetic context',result,
      messages:[{id:'private',role:'assistant',content:'p'.repeat(privateBytes),createdAt:''}]};
    const uri=vscode.Uri.file(temp), writer=new SubagentStore(uri,'workspace');
    if(layout==='state')await writer.save(metadata,transcript);
    else {const dir=path.join(temp,'chat-sessions/v1/subagents',sha('workspace').slice(0,24),'parent');
      await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'child.run.json'),JSON.stringify({metadata,transcript}));}
    const reader=new SubagentStore(uri,'workspace');let bytes=0,reads=0,privateGraphReads=0;
    vscode.workspace.fs.readFile=async uri=>{const b=await originalRead(uri);bytes+=b.length;reads++;if(uri.fsPath.includes('.state.json.objects'))privateGraphReads++;return b;};
    fs.open=async(...args)=>{const h=await originalOpen(...args),read=h.read.bind(h);h.read=async(...a)=>{const r=await read(...a);bytes+=r.bytesRead;reads++;return r;};return h;};
    const measurements=[];
    for(const operation of ['page-cold','verify-after-page','page-warm','verify-warm']) {
      bytes=0;reads=0;privateGraphReads=0;const started=performance.now();
      const value=operation.startsWith('page')?await reader.readResultPage({parentSessionId:'parent',ref:'child',limitBytes:1024}):await reader.verifyResult({parentSessionId:'parent',ref:'child'});
      const durationMs=performance.now()-started;
      if(operation.startsWith('page'))assert.equal(value.ok,true);else assert.equal(value?.resultHash,sha(result));
      if(layout==='state')assert.equal(privateGraphReads,0);
      measurements.push({operation,durationMs,readBytes:bytes,reads,privateGraphReads,deliveredBytes:value.returnedBytes??0});
    }
    return {round,layout,canonicalBytes:Buffer.byteLength(result),privateBytes,measurements};
  } finally {vscode.workspace.fs.readFile=originalRead;fs.open=originalOpen;await fs.rm(temp,{recursive:true,force:true});}
}
(async()=>{const samples=[];for(let round=0;round<3;round++)for(const layout of ['state','legacy-combined'])for(const size of [1024,120000]) {
  for(const privateBytes of [0,4000000])samples.push(await sample(layout,size,privateBytes,round));
}console.log(JSON.stringify({version:1,kind:'offline-full-canonical-acceptance',environment:{node:process.version,platform:process.platform,arch:process.arch},
  units:{duration:'ms',size:'UTF-8 bytes'},methodology:'3 fresh directories, alternating page and full verification per layout/size/private history; OS cache not flushed. Independent observations, no production p95. Large synthetic bodies intentionally exercise storage API, not profile delivery quotas or semantic acceptance. No Provider traffic.',samples},null,2));})().catch(()=>{console.error('acceptance_benchmark_failed');process.exitCode=1;});
