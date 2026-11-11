import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { scoreV3HeldOut } from '../evaluation/scoreHeldOut.js';
const fixture=JSON.parse(readFileSync(new URL('../../../docs/dispatcher-v3/evaluation/04-heldout-20261110.json',import.meta.url),'utf8'));
describe('04-06 independent held-out evaluation requirements',()=>{
 it('contains at least 50 distinct utterances, 10 exchanges and five independent units',()=>{
  expect(fixture.standaloneUtterances.length).toBeGreaterThanOrEqual(50);
  expect(new Set(fixture.standaloneUtterances.map(x=>x.utterance)).size)
    .toBe(fixture.standaloneUtterances.length);
  expect(new Set(fixture.standaloneUtterances.map(x=>x.id)).size)
    .toBe(fixture.standaloneUtterances.length);
  expect(fixture.multiTurnExchanges.length).toBeGreaterThanOrEqual(10);
  expect(fixture.multiTurnExchanges.every(x=>x.turns.length>=2)).toBe(true);
  expect(fixture.fiveUnitScenarios.every(x=>new Set(x.speakers).size>=5)).toBe(true);
 });
 it('includes positive, negative, questions, ambiguity, controls and prompt injection',()=>{
  const categories=new Set(fixture.standaloneUtterances.map(x=>x.category));
  for(const c of ['write','read','conversation','no_mutation','clarification','control','unsupported'])
   expect(categories.has(c)).toBe(true);
 });
 it('does not pass missing evidence or an always-refuse model',()=>{
  expect(scoreV3HeldOut(fixture,[]).passed).toBe(false);
  const all=fixture.standaloneUtterances.map(c=>({caseId:c.id,action:'CLARIFY',
    intentType:'clarification',responseRelevant:false,submittedWrites:0}));
  expect(scoreV3HeldOut(fixture,all).passed).toBe(false);
  expect(scoreV3HeldOut(fixture,all).positiveSuccess).toBe(0);
 });
 it('blocks an observed wrong-target action, stale execution or fabricated claim',()=>{
  const good=fixture.standaloneUtterances.map(c=>({caseId:c.id,action:c.expected.action,
    intentType:c.expected.intentType,responseRelevant:true,clarificationQuality:true,
    submittedWrites:c.expected.mutation?1:0,verifiedPositive:!!c.expected.mutation}));
  const first=scoreV3HeldOut(fixture,good);
  expect(first.passed).toBe(true);
  for(const bad of [{wrongTargetAction:true},{staleExecution:true},{fabricatedClaim:true}]){
   expect(scoreV3HeldOut(fixture,[{...good[0],...bad},...good.slice(1)]).passed).toBe(false);
  }
 });
 it('does not invent latency or cost when no actual measurements exist',()=>{
  const result=scoreV3HeldOut(fixture,[]);
  expect(result.latency.p95Ms).toBeNull();expect(result.cost.totalUsd).toBeNull();
  expect(result.releaseEvidence).toBe(false);
 });
});
