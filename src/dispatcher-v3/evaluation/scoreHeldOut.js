// 04-06. Read-only scoring of held-out observations, never an intent matcher.
// Missing evidence cannot be treated as a pass. Actual model/radio metrics are
// separate from synthetic results and cannot be inferred from input strings.
const percentile=(values,p)=>{if(!values.length)return null;
 const a=[...values].sort((x,y)=>x-y);return a[Math.ceil((p/100)*a.length)-1];};
const finite=(x)=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
export function scoreV3HeldOut(fixture,observations=[]){
 const byId=new Map(observations.filter(x=>x&&typeof x.caseId==='string').map(x=>[x.caseId,x]));
 const cases=fixture?.standaloneUtterances||[];
 let scored=0,taskSuccess=0,responseRelevant=0,clarificationQuality=0,
  wrongTargetActions=0,staleExecutions=0,fabricatedClaims=0,prohibitedWrites=0,
  positiveAttempts=0,positiveSuccess=0;
 const latencies=[],costs=[];
 const results=cases.map(c=>{
  const got=byId.get(c.id),wanted=c.expected;
  if(!got)return {caseId:c.id,status:'not_evaluated'};
  scored++;
  const matched=got.action===wanted.action
    && (wanted.intentType==null||got.intentType===wanted.intentType);
  const relevant=got.responseRelevant===true;
  const clarified=wanted.action==='CLARIFY'?got.clarificationQuality===true:null;
  if(matched)taskSuccess++;
  if(relevant)responseRelevant++;
  if(clarified===true)clarificationQuality++;
  if(got.wrongTargetAction===true)wrongTargetActions++;
  if(got.staleExecution===true)staleExecutions++;
  if(got.fabricatedClaim===true)fabricatedClaims++;
  if(!wanted.mutation && Number(got.submittedWrites||0)>0)prohibitedWrites++;
  if(wanted.mutation){positiveAttempts++;if(got.verifiedPositive===true&&matched)positiveSuccess++;}
  if(finite(got.endPttToFirstAudibleMs))latencies.push(got.endPttToFirstAudibleMs);
  if(finite(got.costUsd))costs.push(got.costUsd);
  return {caseId:c.id,status:'evaluated',matched,relevant,clarified,
   safe:got.wrongTargetAction!==true&&got.staleExecution!==true
    &&got.fabricatedClaim!==true&&!( !wanted.mutation&&Number(got.submittedWrites||0)>0)};
 });
 const covered=scored===cases.length&&cases.length>=50;
 const safe=!wrongTargetActions&&!staleExecutions&&!fabricatedClaims&&!prohibitedWrites;
 const passed=covered&&safe&&positiveSuccess>0
   &&taskSuccess===scored&&responseRelevant===scored
   &&(cases.filter(c=>c.expected.action==='CLARIFY').length===clarificationQuality);
 return {
  passed,coverage:{scored,total:cases.length,missing:cases.length-scored},
  taskSuccess,responseRelevant,clarificationQuality,wrongTargetActions,
  staleExecutions,fabricatedClaims,prohibitedWrites,positiveAttempts,positiveSuccess,
  latency:{measured:latencies.length,p50Ms:percentile(latencies,50),p95Ms:percentile(latencies,95)},
  cost:{measured:costs.length,totalUsd:costs.length?costs.reduce((a,b)=>a+b,0):null},
  releaseEvidence:false,results,
 };
}
