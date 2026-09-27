import { calculateSettlement } from '../public/assets/business-rules.js';

// Shared by the two real member sessions, isolated from providers and all real transaction/reputation tables.
const respond=(data,status=200)=>({data,status});
const fail=(status,code,message)=>respond({error:{code,message}},status);
const uid=prefix=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`;
const validKey=value=>typeof value==='string'&&/^[\w-]{16,100}$/.test(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fingerprint=body=>JSON.stringify(canonical(Object.fromEntries(Object.entries(body).filter(([key])=>key!=='requestId'))));
const sourceSQL=`SELECT c.*,t.id AS source_teaser_id,t.solver_id AS source_solver_id,t.status AS source_teaser_status,
 o.status AS owner_status,o.email_verified AS owner_email_verified,u.status AS solver_status,u.email_verified AS solver_email_verified
 FROM challenges c JOIN teasers t ON t.challenge_id=c.id JOIN users o ON o.id=c.owner_id JOIN users u ON u.id=t.solver_id`;
const validSourceSQL=`c.owner_id=? AND c.reward_amount=? AND c.status IN ('OPEN','REVIEW','SHORTLISTED') AND c.funding_status='POSTED'
 AND c.payment_due_at IS NULL AND (c.selected_solver_id IS NULL OR c.selected_solver_id=t.solver_id)
 AND t.id=? AND t.solver_id=? AND t.status IN ('SHORTLISTED','SELECTED') AND o.status='active' AND u.status='active'
 AND o.email_verified=1 AND u.email_verified=1`;
const sourceValues=row=>[row.owner_id,row.source_reward,row.teaser_id,row.solver_id];
const loadSource=(env,cid,tid)=>env.DB.prepare(`${sourceSQL} WHERE c.id=? AND t.id=?`).bind(cid,tid).first();
const sourceProblem=(source,row)=>{
 if(!source||source.owner_id!==row.owner_id||source.source_solver_id!==row.solver_id||!['SHORTLISTED','SELECTED'].includes(source.source_teaser_status))return 'CANDIDATE_CHANGED';
 if(!['OPEN','REVIEW','SHORTLISTED'].includes(source.status)||source.funding_status!=='POSTED'||source.payment_due_at||(source.selected_solver_id&&source.selected_solver_id!==row.solver_id))return 'MISSION_CHANGED';
 if(Number(source.reward_amount)!==Number(row.source_reward))return 'REWARD_CHANGED';
 if(source.owner_status!=='active'||source.solver_status!=='active')return 'PARTICIPANT_UNAVAILABLE';
 if(!source.owner_email_verified||!source.solver_email_verified)return 'EMAIL_REQUIRED';
 return null;
};
const latest=(env,cid)=>env.DB.prepare('SELECT * FROM mission_simulations WHERE challenge_id=? ORDER BY (closed_at IS NULL) DESC,rowid DESC LIMIT 1').bind(cid).first();
const isParty=(row,user)=>row&&(user.id===row.owner_id||user.id===row.solver_id);
const expose=(row,blockedReason=null)=>{
 const state=JSON.parse(row.state_json);delete state.lastEventId;
 return {...state,id:row.id,challengeId:row.challenge_id,teaserId:row.teaser_id,ownerId:row.owner_id,solverId:row.solver_id,
 revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,mode:'MISSION_SIMULATION',actualCharge:0,
 active:!blockedReason&&!row.closed_at,blockedReason};
};
async function publicRecord(env,row){return expose(row,sourceProblem(await loadSource(env,row.challenge_id,row.teaser_id),row));}
export async function readMissionSimulationContext(env,challenge,user){
 if(!user)return null;
 const row=await latest(env,challenge.id);
 return isParty(row,user)?publicRecord(env,row):null;
}
export async function missionSimulationSummaries(env,user){
 const rows=await env.DB.prepare(`SELECT * FROM mission_simulations WHERE (owner_id=? OR solver_id=?)
 AND id=(SELECT s.id FROM mission_simulations s WHERE s.challenge_id=mission_simulations.challenge_id ORDER BY (s.closed_at IS NULL) DESC,s.rowid DESC LIMIT 1)`)
 .bind(user.id,user.id).all();
 const result={};
 for(const row of rows.results||[]){const s=await publicRecord(env,row);result[row.challenge_id]={id:s.id,stage:s.stage,paymentStatus:s.paymentStatus,payoutStatus:s.payoutStatus,executionStarted:Boolean(s.executionStarted),revision:s.revision,active:s.active,blockedReason:s.blockedReason,mode:s.mode,actualCharge:0};}
 return result;
}
export async function missionSimulationLocked(env,challengeId){
 return Boolean(await env.DB.prepare(`SELECT s.id FROM mission_simulations s JOIN users owner ON owner.id=s.owner_id WHERE s.challenge_id=? AND s.closed_at IS NULL AND owner.status='active' AND json_extract(s.state_json,'$.payoutStatus')<>'PAID' LIMIT 1`).bind(challengeId).first());
}
const resultFor=async(env,row,user,extra={})=>{
 let canStart=false,candidateTeaserId=row.teaser_id;
 if(row.closed_at&&user.id===row.owner_id){
  const candidates=await env.DB.prepare("SELECT id,solver_id FROM teasers WHERE challenge_id=? AND status IN ('SHORTLISTED','SELECTED') ORDER BY CASE status WHEN 'SELECTED' THEN 0 ELSE 1 END,created_at,id").bind(row.challenge_id).all();
  const candidate=candidates.results[0];candidateTeaserId=candidate?.id||null;
  const source=candidate?await loadSource(env,row.challenge_id,candidate.id):null;
  canStart=Boolean(source&&!sourceProblem(source,{owner_id:row.owner_id,solver_id:candidate.solver_id,source_reward:Number(source.reward_amount)}));
 }
 return respond({simulation:await publicRecord(env,row),viewerRole:user.id===row.owner_id?'owner':'solver',canStart,candidateTeaserId,mode:'MISSION_SIMULATION',actualCharge:0,...extra});
};
export async function missionSimulationApi(request,env,user,challengeId,body=null){
 if(!user)return fail(401,'AUTH_REQUIRED','로그인이 필요합니다.');
 if(!['GET','POST'].includes(request.method))return fail(405,'METHOD_NOT_ALLOWED','GET 또는 POST 요청만 지원합니다.');
 const challenge=await env.DB.prepare('SELECT * FROM challenges WHERE id=?').bind(challengeId).first();
 if(!challenge)return fail(404,'CHALLENGE_NOT_FOUND','미션을 찾을 수 없습니다.');
 const row=await latest(env,challengeId),owner=challenge.owner_id===user.id;
 if(request.method==='GET'){
  if(row){if(!isParty(row,user))return fail(403,'PARTY_REQUIRED','의뢰자와 가상 최종 수행자만 확인할 수 있습니다.');return resultFor(env,row,user);}
  const candidates=await env.DB.prepare("SELECT id,solver_id FROM teasers WHERE challenge_id=? AND status IN ('SHORTLISTED','SELECTED') ORDER BY CASE status WHEN 'SELECTED' THEN 0 ELSE 1 END,created_at,id").bind(challengeId).all();
  if(!owner&&!candidates.results.some(t=>t.solver_id===user.id))return fail(403,'PARTY_REQUIRED','의뢰자와 선정 후보만 확인할 수 있습니다.');
  const candidate=candidates.results[0],source=candidate?await loadSource(env,challengeId,candidate.id):null;
  const blocked=candidate?sourceProblem(source,{owner_id:challenge.owner_id,solver_id:candidate.solver_id,source_reward:challenge.reward_amount}):'CANDIDATE_REQUIRED';
  return respond({simulation:null,viewerRole:owner?'owner':'solver',canStart:owner&&!blocked,candidateTeaserId:candidate?.id||null,blockedReason:blocked,mode:'MISSION_SIMULATION',actualCharge:0});
 }
 if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'INVALID_BODY','가상 진행 요청을 확인해주세요.');
 if(!validKey(body.requestId))return fail(400,'INVALID_REQUEST_ID','요청 식별정보를 확인해주세요.');
 if(['role','actorId','solverId'].some(key=>body[key]!==undefined))return fail(400,'SESSION_ROLE_ONLY','진행 역할은 현재 로그인한 계정으로 확인합니다.');
 const fp=fingerprint(body);
 if(body.action==='START'){
  if(!owner)return fail(403,'OWNER_REQUIRED','의뢰자만 가상 최종 수행자를 확정할 수 있습니다.');
  const previous=await env.DB.prepare('SELECT * FROM mission_simulations WHERE owner_id=? AND create_request_key=?').bind(user.id,body.requestId).first();
  if(previous)return previous.challenge_id===challengeId&&previous.start_fingerprint===fp?resultFor(env,previous,user,{idempotent:true}):fail(409,'REQUEST_REUSED','동일한 요청으로 다른 가상 진행을 시작할 수 없습니다.');
  if(body.consent!==true)return fail(400,'SIMULATION_CONSENT_REQUIRED','실제 결제·지급이 없는 가상 진행임을 확인해주세요.');
  if(row&&!row.closed_at)return fail(409,'SIMULATION_EXISTS','이 미션에 이미 가상 진행 기록이 있습니다.');
  const tid=String(body.teaserId||''),source=await loadSource(env,challengeId,tid);
  const candidate={owner_id:user.id,solver_id:source?.source_solver_id,teaser_id:tid,source_reward:Number(challenge.reward_amount)};
  if(candidate.solver_id===user.id||sourceProblem(source,candidate))return fail(409,'SIMULATION_SOURCE_CHANGED','현재 유효한 후보와 이메일 인증·미션 상태를 확인해주세요. 실제 지급 단계의 미션은 가상 시작할 수 없습니다.');
  const sid=uid('msim'),eid=uid('msev'),now=new Date().toISOString();
  const event={id:eid,action:'START',role:'owner',at:now,label:'가상 최종 수행자 확정 · 실제 결제 0원'};
  const state={mode:'MISSION_SIMULATION',actualCharge:0,title:source.title,rewardAmount:candidate.source_reward,...calculateSettlement(candidate.source_reward,.1),stage:'FUNDING_REQUIRED',paymentStatus:'NONE',payoutStatus:'NONE',executionStarted:false,proof:null,proofHistory:[],reviewReason:'',transactions:[],events:[event],lastEventId:eid};
  try{
   await env.DB.batch([
    env.DB.prepare(`INSERT INTO mission_simulations(id,challenge_id,owner_id,solver_id,teaser_id,source_reward,create_request_key,start_fingerprint,state_json)
     SELECT ?,c.id,?,t.solver_id,t.id,?,?,?,? FROM challenges c JOIN teasers t ON t.challenge_id=c.id JOIN users o ON o.id=c.owner_id JOIN users u ON u.id=t.solver_id
     WHERE c.id=? AND ${validSourceSQL} AND NOT EXISTS(SELECT 1 FROM mission_simulations WHERE challenge_id=c.id AND closed_at IS NULL)`)
     .bind(sid,user.id,candidate.source_reward,body.requestId,fp,JSON.stringify(state),challengeId,...sourceValues(candidate)),
    env.DB.prepare(`INSERT INTO mission_simulation_events(id,simulation_id,actor_id,request_key,action,fingerprint,revision,payload_json)
     SELECT ?,id,?,?, 'START',?,0,? FROM mission_simulations WHERE id=?`).bind(eid,user.id,body.requestId,fp,JSON.stringify(event),sid),
   ]);
  }catch(error){if(!String(error).includes('UNIQUE constraint'))throw error;}
  const saved=await env.DB.prepare('SELECT * FROM mission_simulations WHERE owner_id=? AND create_request_key=?').bind(user.id,body.requestId).first();
  if(!saved)return fail(409,'SIMULATION_SOURCE_CHANGED','후보 또는 진행상황이 변경되었습니다. 새로 확인해주세요.');
  if(saved.start_fingerprint!==fp||saved.challenge_id!==challengeId)return fail(409,'REQUEST_REUSED','같은 요청 식별정보로 다른 진행을 시작할 수 없습니다.');
  const result=await resultFor(env,saved,user);result.status=saved.id===sid?201:200;return result;
 }
 if(!row||!isParty(row,user))return fail(403,'PARTY_REQUIRED','의뢰자와 가상 최종 수행자만 진행할 수 있습니다.');
 const role=user.id===row.owner_id?'owner':'solver';
 const prior=await env.DB.prepare('SELECT fingerprint,actor_id FROM mission_simulation_events WHERE simulation_id=? AND request_key=?').bind(row.id,body.requestId).first();
 if(prior&&prior.actor_id!==user.id)return fail(403,'SIMULATION_ROLE_REQUIRED','다른 당사자의 요청을 재사용할 수 없습니다.');
 if(prior)return prior.fingerprint===fp?resultFor(env,row,user,{idempotent:true}):fail(409,'REQUEST_REUSED','같은 요청 식별정보로 다른 작업을 실행할 수 없습니다.');
 if(body.revision!==row.revision)return fail(409,'SIMULATION_CHANGED','다른 화면에서 진행상황이 변경되었습니다. 새로 확인해주세요.');
 const s=JSON.parse(row.state_json),source=await loadSource(env,challengeId,row.teaser_id),blocked=sourceProblem(source,row);
 const cancelling=body.action==='CANCEL'&&role==='owner'&&!row.closed_at&&s.payoutStatus!=='PAID';
 if(row.closed_at||blocked&&!cancelling)return fail(409,'SIMULATION_SOURCE_CHANGED','미션·후보·계정 상태가 변경되어 가상 진행을 계속할 수 없습니다.');
 const ownerActions=['PAY_APPROVE','PAY_FAIL','PAY_CANCEL','REVIEW_ACCEPT','REVIEW_REJECT','PAYOUT_SUCCESS','PAYOUT_FAIL','CANCEL'];
 if(!ownerActions.includes(body.action)&&!['BEGIN','SUBMIT_PROOF'].includes(body.action))return fail(400,'INVALID_ACTION','지원하지 않는 가상 진행 요청입니다.');
 if((ownerActions.includes(body.action)?'owner':'solver')!==role)return fail(403,'SIMULATION_ROLE_REQUIRED','해당 단계의 담당 계정으로 로그인해주세요.');
 const invalid=()=>fail(409,'INVALID_SIMULATION_STAGE','현재 단계에서 실행할 수 없습니다. 진행상황을 확인해주세요.');
 if(s.events.length>=300&&body.action!=='CANCEL')return fail(409,'EVENT_LIMIT','가상 진행 기록 한도에 도달했습니다. 이 진행을 취소해주세요.');
 const eid=uid('msev'),now=new Date().toISOString();let label='';
 const receipt=(kind,status,amount)=>s.transactions.push({id:uid('mvirt'),kind,status,amount,currency:'KRW',at:now,actualCharge:0,mode:'MISSION_SIMULATION'});
 switch(body.action){
  case 'PAY_APPROVE':case 'PAY_FAIL':case 'PAY_CANCEL':
   if(s.stage!=='FUNDING_REQUIRED'||s.paymentStatus==='APPROVED')return invalid();
   s.paymentStatus=body.action==='PAY_APPROVE'?'APPROVED':body.action==='PAY_FAIL'?'FAILED':'CANCELLED';
   if(s.paymentStatus==='APPROVED')s.stage='EXECUTING';
   receipt('PAYMENT',s.paymentStatus,s.rewardAmount);label=s.paymentStatus==='APPROVED'?'가상 보상금 확보 · 실제 결제 0원':'가상 결제 실패·취소 · 다시 시도 가능';break;
  case 'BEGIN':
   if(s.stage!=='EXECUTING'||s.executionStarted||s.paymentStatus!=='APPROVED')return invalid();s.executionStarted=true;label='선정 수행자 가상 수행 시작';break;
  case 'SUBMIT_PROOF':{
   if(s.stage!=='EXECUTING'||!s.executionStarted||s.paymentStatus!=='APPROVED')return invalid();
   if(typeof body.description!=='string'||body.description.trim().length<20||body.description.trim().length>6000)return fail(400,'INVALID_PROOF','수행 결과를 20자 이상 6000자 이하로 입력해주세요.');
   const evidenceUrl=String(body.evidenceUrl||'').trim();
   if(evidenceUrl){try{const url=new URL(evidenceUrl);if(url.protocol!=='https:'||url.username||url.password||evidenceUrl.length>2000)throw Error();}catch{return fail(400,'INVALID_EVIDENCE_URL','증빙 링크는 HTTPS 주소로 입력해주세요.');}}
   s.proof={id:uid('mproof'),description:body.description.trim(),evidenceUrl,status:'SUBMITTED',submittedAt:now};s.stage='PROOF_SUBMITTED';s.reviewReason='';label='선정 수행자 가상 결과·증빙 제출';break;
  }
  case 'REVIEW_REJECT':
   if(s.stage!=='PROOF_SUBMITTED'||s.proof?.status!=='SUBMITTED')return invalid();
   if(typeof body.reason!=='string'||body.reason.trim().length<5||body.reason.trim().length>1000)return fail(400,'REVIEW_REASON_REQUIRED','보완 사유를 5자 이상 1000자 이하로 입력해주세요.');
   s.reviewReason=body.reason.trim();s.proof={...s.proof,status:'REJECTED',decidedAt:now,reviewReason:s.reviewReason};s.proofHistory.push(s.proof);s.stage='EXECUTING';label='의뢰자 가상 검수 보완 요청';break;
  case 'REVIEW_ACCEPT':
   if(s.stage!=='PROOF_SUBMITTED'||s.proof?.status!=='SUBMITTED')return invalid();
   s.proof={...s.proof,status:'ACCEPTED',decidedAt:now};s.proofHistory.push(s.proof);s.stage='SUCCESS';s.payoutStatus='PROCESSING';label='의뢰자 가상 검수 승인 · 가상 지급 대기';break;
  case 'PAYOUT_SUCCESS':case 'PAYOUT_FAIL':
   if(s.stage!=='SUCCESS'||!['PROCESSING','FAILED'].includes(s.payoutStatus))return invalid();
   s.payoutStatus=body.action==='PAYOUT_SUCCESS'?'PAID':'FAILED';receipt('PAYOUT',s.payoutStatus,s.solverPayout);label=s.payoutStatus==='PAID'?'가상 클리어 보상 지급 완료 · 실제 지급 0원':'가상 지급 실패 · 다시 시도 가능';break;
  case 'CANCEL':
   if(s.payoutStatus==='PAID'||s.stage==='CANCELLED')return invalid();
   if(s.paymentStatus==='APPROVED')receipt('REFUND','REFUNDED',s.rewardAmount);
   s.stage='CANCELLED';label='가상 진행 취소 · 실제 미션은 유지';break;
 }
 const event={id:eid,action:body.action,role,at:now,label};s.events.push(event);s.lastEventId=eid;
 const sourceGuard=cancelling?'':` AND EXISTS(${sourceSQL} WHERE c.id=mission_simulations.challenge_id AND ${validSourceSQL})`;
 await env.DB.batch([
  env.DB.prepare(`UPDATE mission_simulations SET state_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP,closed_at=?
   WHERE id=? AND revision=? AND closed_at IS NULL${sourceGuard}`)
   .bind(JSON.stringify(s),s.stage==='CANCELLED'?now:null,row.id,row.revision,...(cancelling?[]:sourceValues(row))),
  env.DB.prepare(`INSERT INTO mission_simulation_events(id,simulation_id,actor_id,request_key,action,fingerprint,revision,payload_json)
   SELECT ?,id,?,?,?,?,revision,? FROM mission_simulations WHERE id=? AND revision=? AND json_extract(state_json,'$.lastEventId')=?`)
   .bind(eid,user.id,body.requestId,body.action,fp,JSON.stringify(event),row.id,row.revision+1,eid),
 ]);
 const committed=await env.DB.prepare('SELECT fingerprint,actor_id FROM mission_simulation_events WHERE simulation_id=? AND request_key=?').bind(row.id,body.requestId).first();
 if(!committed||committed.fingerprint!==fp||committed.actor_id!==user.id)return fail(409,'SIMULATION_CHANGED','진행상황이 변경되었습니다. 새로 확인해주세요.');
 return resultFor(env,await env.DB.prepare('SELECT * FROM mission_simulations WHERE id=?').bind(row.id).first(),user);
}
