import { describe, expect, it } from 'vitest';
import { composeV3Response, formatMilitaryTimeForSpeech } from '../responseComposer.js';
const speak=(action,data,input={})=>composeV3Response({
  plan:{action,input},result:{success:true,outcome:'verified',data},speakerCallsign:'A1',
  now:new Date('2026-10-30T18:30:00Z'),
});
describe('AI-DISP-V3 03-07 factual CAD response contract',()=>{
  it('GET_CALL speaks nature, location, status and priority rather than copy',()=>{
    const reply=speak('GET_CALL',{call:{call_id:'CALL-1',nature:'ROBBERY',
      location:'100 Main Street',status:'active',priority:'high'}});
    expect(reply).toMatch(/ROBBERY.*100 Main Street.*status active.*priority high/);
  });
  it('SEARCH_CALLS returns matches and distinguishable no matches',()=>{
    expect(speak('SEARCH_CALLS',{calls:[{call_number:'26-1',nature:'ALARM',location:'Walmart'}]}))
      .toMatch(/1 CAD call matched.*ALARM.*Walmart/);
    expect(speak('SEARCH_CALLS',{calls:[]})).toMatch(/no CAD calls matched/);
  });
  it('current and active call summaries reflect returned CAD information',()=>{
    expect(speak('GET_CURRENT_CALL',{call:{call_number:'C1',type:'FIGHT',location:'100 Oak'}}))
      .toMatch(/FIGHT at 100 Oak/);
    expect(speak('LIST_ACTIVE_CALLS',{calls:[{call_number:'C2',nature:'FIRE',location:'200 Pine'}]}))
      .toMatch(/FIRE at 200 Pine/);
  });
  it('verified effects are specific without reading a generated call number',()=>{
    const made=speak('CREATE_CALL',{verified:true,call:{call_id:'NEW-CALL',nature:'BUILDING CHECK',location:'100 Main Street'}});
    expect(made).toMatch(/BUILDING CHECK.*created.*100 Main Street/i);
    expect(made).not.toContain('NEW-CALL');
    expect(speak('SET_UNIT_STATUS',{verified:true,unit:{status:'on_scene'}})).toMatch(/status on scene/);
    expect(speak('CHANGE_UNIT_ZONE',{verified:true,unit:{zone:'OPS2'}})).toMatch(/zone OPS2/);
    expect(speak('ADD_CALL_NOTE',{verified:true,call:{call_id:'C1'}})).toMatch(/note verified/);
    expect(speak('ASSIGN_UNIT',{verified:true,call:{call_id:'C1'}})).toMatch(/assignment verified/);
    expect(speak('CLOSE_CALL',{verified:true,call:{call_id:'C1'}})).toMatch(/closure/);
  });
  it('a field note failure cannot be spoken as saved, and unknown writes say not to repeat',()=>{
    expect(speak('REPORT_FIELD_INCIDENT',{verified:true,recordedReports:['Subject northbound'],
      radioResponse:"10-4. What's your location?"})).toMatch(/report verified in CAD/i);
    expect(composeV3Response({plan:{action:'ADD_CALL_NOTE'},speakerCallsign:'A1',
      result:{success:false,outcome:'unknown',submittedWrites:1,error:{code:'CAD_UNAVAILABLE'}}}))
      .toMatch(/unconfirmed.*Do not repeat/i);
    expect(composeV3Response({plan:{action:'REPORT_FIELD_INCIDENT'},speakerCallsign:'A1',
      result:{success:false,outcome:'partial',data:{partialErrors:[{outcome:'unknown'}]}}}))
      .toMatch(/submission is unconfirmed/i);
  });
  it('military time, compatibility acknowledgements and non-promissory backup survive',()=>{
    expect(formatMilitaryTimeForSpeech(new Date('2026-08-07T15:59:00Z'))).toBe('eleven fifty-nine hours');
    expect(speak('SET_UNIT_STATUS',{verified:true})).toMatch(/Ten-four/);
    expect(speak('STATUS_CHECK',{unit:{status:'en_route'}})).toMatch(/en route/);
    expect(speak('REQUEST_BACKUP',{requested:true})).not.toMatch(/en route/i);
  });
});
