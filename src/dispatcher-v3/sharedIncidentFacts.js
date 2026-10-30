// AI-DISP-V3-001 02-06. Verified CAD metadata, separately attributed reports.
// Never cache an assignment as authority or allow reports to become commands.
import { hasV3Scope } from './runtimeContract.js';
import { assertV3TurnEnvelope } from './turnEnvelope.js';
import { V3_ACTIONS } from './actionContracts.js';

const TERMINAL = new Set(['closed', 'cleared', 'cancelled', 'canceled', 'voided', 'disposed']);
const UNIT_MUTATIONS = new Set([
  V3_ACTIONS.SET_UNIT_STATUS, V3_ACTIONS.CHANGE_UNIT_ZONE, V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY, V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES,
  V3_ACTIONS.CLEAR_UNIT, V3_ACTIONS.CREATE_CALL, V3_ACTIONS.CLOSE_CALL,
]);
const GROUP_REFS = new Set(['we','us','ours','our units','our officers','both','both of us','all of us',
  'all our units','everyone','the two of us','the three of us']);
const GROUP_OBJECT = /\b(?:mark|show|set|put|assign|unassign|clear|remove|attach|move|change|make|update|dispatch)\b.{0,55}?\b(?:us|both of us|all of us|our units|our officers|the two of us|the three of us)\b/i;
const GROUP_STATUS = /\b(?:we|both of us|all of us)\s+(?:are|were|will be|should be|need to be|are now)\s+(?:available|en[\s-]?route|responding|on[\s-]?scene|cleared|off[\s-]?duty|busy|out of service)\b/i;
const clean = (v,n=240) => String(v??'').trim().replace(/\s+/g,' ').slice(0,n);
const norm = v => clean(v).toLowerCase();
const callId = c => clean(c?.call_id||c?.callId||c?.id);
const active = c => !!c && !TERMINAL.has(norm(c.status));
function unitAssignments(call){
  const array=call?.assigned_units??call?.assignedUnits??call?.active_assignments??call?.assignments;
  if(!Array.isArray(array))return null;
  return array.filter(x=>x!=null && (typeof x!=='object'
    || !(x.unassigned_at||x.unassignedAt||x.cleared_at||x.clearedAt||x.active===false)))
    .map(x=>typeof x==='object'?clean(x.unit_id||x.unitId||x.unit_uuid||x.callsign||x.unit_number||x.id,80):clean(x,80))
    .filter(Boolean).slice(0,24);
}

export class V3SharedIncidentFacts {
  constructor({gateway,runtimeContext,getGeneration=()=>null,now=()=>Date.now(),ttlMs=300000,maxReports=64}={}){
    if(!gateway||!runtimeContext)throw new TypeError('Shared incident facts require CAD and a runtime context');
    this.gateway=gateway;this.context=runtimeContext;this.getGeneration=getGeneration;this.now=now;
    this.ttlMs=ttlMs;this.maxReports=maxReports;this.reports=[];
  }
  async view({operationalContext,correlationId}={}){
    if(!hasV3Scope(this.context,'unit.read')||!hasV3Scope(this.context,'call.read'))return null;
    const speaker=operationalContext?.speaker,expected=clean(operationalContext?.currentCall?.id);
    if(!speaker?.unitId||!speaker?.callsign||!expected||!active(operationalContext.currentCall)
      ||!operationalContext.activeCalls?.some(c=>clean(c.id)===expected&&active(c)))return null;
    // Fresh, center-scoped, authorized read. Neither conversation text nor a model-supplied
    // call ID can authorize participation.
    const response=await this.gateway.get('/api/radio/v3/cad/calls/'+encodeURIComponent(expected),{correlationId});
    const call=response?.call;
    if(!call||callId(call)!==expected||!active(call))return null;
    const members=unitAssignments(call);
    if(!members||!members.some(r=>norm(r)===norm(speaker.unitId)||norm(r)===norm(speaker.callsign)))return null;
    this._prune();
    const notes=Array.isArray(call.call_notes)?call.call_notes:[];
    const reports=notes.slice(-8).map(note=>{
      const text=clean(typeof note==='string'?note:note?.text||note?.note);
      if(!text)return null;
      const attributed=this.reports.findLast(r=>r.callId===expected&&r.text===text);
      return {text,kind:'operational_report',factVerified:false,cadRecorded:true,
        reportedBy:attributed?.callsign||null,
        source:attributed?'authenticated_unit_cad_write':'cad_note_unattributed'};
    }).filter(Boolean);
    return {callId:expected,callNumber:clean(call.call_number||call.callNumber||call.number,80)||null,
      nature:clean(call.nature||call.type||call.call_type,100)||null,
      location:clean(call.location||call.address,150)||null,
      status:clean(call.status,40)||null,priority:clean(call.priority,40)||null,
      participatingUnits:members.slice(0,12),provenance:'fresh_center_authorized_cad',
      verifiedCadFacts:true,reports};
  }
  // Model input contains no raw report text, preventing instructions embedded in
  // recorded field reports from becoming the model's commands.
  forPlanner(view){
    if(!view)return null;
    const {reports,...facts}=view;
    return {...facts,reportCount:reports.length};
  }
  // Provenance is the authenticated transmitting speaker, never a model-supplied
  // unitRef. No failed/deferred/unknown write may be published as a CAD report.
  remember({plan,result,turnEnvelope}={}){
    if(!result?.success||!turnEnvelope||!plan)return false;
    assertV3TurnEnvelope(turnEnvelope,this.context);
    if(turnEnvelope.runtimeGeneration!==this.getGeneration())return false;
    let id=null,notes=[];
    if(plan.action===V3_ACTIONS.ADD_CALL_NOTE&&result.data?.verified===true){
      id=clean(plan.input?.callId);notes=[plan.input?.note];
    } else if([V3_ACTIONS.REPORT_FIELD_INCIDENT,V3_ACTIONS.UPDATE_FIELD_INCIDENT].includes(plan.action)){
      id=clean(result.data?.callId);
      notes=Array.isArray(result.data?.recordedReports)?result.data.recordedReports:[];
    }
    if(!id||!notes.length)return false;
    this._prune();
    for(const raw of notes.slice(0,8)){
      const text=clean(raw);if(!text)continue;
      this.reports.push({callId:id,text,callsign:clean(turnEnvelope.speaker.callsign,80),
        speakerUnitId:clean(turnEnvelope.speaker.unitId,80),expiresAt:this.now()+this.ttlMs});
    }
    if(this.reports.length>this.maxReports)this.reports.splice(0,this.reports.length-this.maxReports);
    return true;
  }
  clearAll(){this.reports=[];}
  _prune(){this.reports=this.reports.filter(r=>r.expiresAt>this.now());}
}

// Group pronouns cannot expand to another unit's CAD record. A new complete
// instruction naming individual callsigns uses ordinary authorization.
export function clarifyV3GroupMutation({plan,transcript}={}){
  const actions=plan?.action==='MULTI_ACTION'?(plan.actions||[]):[plan];
  const mutations=actions.filter(step=>UNIT_MUTATIONS.has(step?.action));
  if(!mutations.length)return null;
  const groupParam=mutations.some(step=>{
    const refs=[step.input?.unitRef,...(Array.isArray(step.input?.unitRefs)?step.input.unitRefs:
      step.input?.unitRefs?[step.input.unitRefs]:[])];
    return refs.some(ref=>GROUP_REFS.has(norm(ref)));
  });
  const text=String(transcript||'');
  const groupSpeech=GROUP_OBJECT.test(text)||(mutations.some(step=>[
    V3_ACTIONS.SET_UNIT_STATUS,V3_ACTIONS.CHANGE_UNIT_ZONE,V3_ACTIONS.CLEAR_UNIT
  ].includes(step.action))&&GROUP_STATUS.test(text));
  if(!groupParam&&!groupSpeech)return null;
  return {action:'CLARIFY',input:{},confidence:1,
    clarification:'Which individual units should I update? State their callsigns and the specific action.',
    reason:'group_target_requires_explicit_units'};
}
