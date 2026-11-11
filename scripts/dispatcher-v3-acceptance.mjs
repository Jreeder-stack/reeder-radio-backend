#!/usr/bin/env node
// AI-DISP-V3-001 04-08. Explicit synthetic-only acceptance runner.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
if(process.argv.length!==3||process.argv[2]!=='--synthetic'){
 console.error('Only --synthetic is supported. Real providers/radios require separate owner approval.');
 process.exit(2);
}
const dir=resolve(process.cwd(),'reports');mkdirSync(dir,{recursive:true});
const summaryPath=resolve(dir,'dispatcher-v3-synthetic-tests.json');
const tracePath=resolve(dir,'dispatcher-v3-synthetic-scenarios.json');
const finalPath=resolve(dir,'dispatcher-v3-synthetic-acceptance.json');
const selected=[
 'src/dispatcher-v3/__tests__/clarificationRecovery04.test.js',
 'src/dispatcher-v3/__tests__/truthfulFailures04.test.js',
 'src/dispatcher-v3/__tests__/radioTakeover04.test.js',
 'src/dispatcher-v3/__tests__/conversationEvaluation04.test.js',
 'src/dispatcher-v3/__tests__/naturalRadioPath04.test.js',
 'src/dispatcher-v3/__tests__/acceptanceRunner04.test.js',
 'src/dispatcher-v3/__tests__/multiUnitIntegration.test.js',
 'src/dispatcher-v3/__tests__/emergencyReplyContainment.test.js',
];
const env={...process.env,DISPATCHER_V3_ACCEPTANCE_TRACE:tracePath,DISPATCHER_V3_SYNTHETIC:'1'};
for(const key of Object.keys(env)){
 if(/^(AZURE_OPENAI_|AZURE_SPEECH_|CAD_API_KEY$|CAD_URL$|OPENAI_API_KEY$)/i.test(key)) delete env[key];
}
const vitest=resolve(process.cwd(),'node_modules','vitest','vitest.mjs');
if(!existsSync(vitest)){console.error('Run npm ci first.');process.exit(2);}
const start=Date.now();
const child=spawnSync(process.execPath,[vitest,'run',...selected,
 '--reporter=default','--reporter=json','--outputFile='+summaryPath],
 {cwd:process.cwd(),env,stdio:'inherit',timeout:120000});
let tests=null,traces=null;
try{tests=JSON.parse(readFileSync(summaryPath,'utf8'));}catch{}
try{traces=JSON.parse(readFileSync(tracePath,'utf8'));}catch{}
const report={
 plan:'AI-DISP-V3-001',item:'04-08',mode:'synthetic_mocked',
 candidateCommit:process.env.GITHUB_SHA||null,
 generatedAt:new Date().toISOString(),elapsedWallMs:Date.now()-start,
 tests:{selectedFiles:selected,passed:tests?.numPassedTests??null,
  failed:tests?.numFailedTests??null,total:tests?.numTotalTests??null,exit:child.status??1},
 traces:traces?.scenarios??[],traceCollection:traces?'synthetic_only':'missing',
 priorV3Executable:'45a50a26f5c4580e9f40442a93a84c24ba54544a',
 actualProviderModelAccuracy:null,realRadioAudibility:null,
 p50FirstAudibleMs:null,p95FirstAudibleMs:null,p95QueueAgeMs:null,
 paidProviderCostUsd:null,
 gates:{'G-01':false,'G-02':false,'G-03':false,'G-04':false},releaseAccepted:false,
};
writeFileSync(finalPath,JSON.stringify(report,null,2)+'\n');
console.log('Synthetic acceptance:',finalPath);
if(child.error)console.error(child.error.message);
process.exit(child.status===0&&(tests?.numFailedTests??1)===0&&traces?0:1);
