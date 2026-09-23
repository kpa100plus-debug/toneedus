import {identityConfigured} from './launch-readiness.mjs';
import {identityDigest} from './identity.mjs';
import {fail,hexKey,seal,unseal,sha,unb64,limitedJson} from './secure-data.mjs';
export const ENTITY_CONSENT_VERSION='2026-09-23-entity-v1';
const types={business:'BUSINESS',corporation:'CORPORATION',organization:'ORGANIZATION'};
const ms=86400000, future=days=>new Date(Date.now()+days*ms).toISOString();
export function entityConfigured(env){return identityConfigured(env)&&env.ENTITY_REVIEW_POLICY_APPROVED==='true'&&hexKey(env.EVIDENCE_ENCRYPTION_KEY);}
async function atomic(env,row,statements){
 try{return (await env.DB.batch([env.DB.prepare('INSERT INTO entity_mutation_guards(case_id,expected_revision) VALUES(?,?)').bind(row.id,row.revision),...statements,env.DB.prepare('DELETE FROM entity_mutation_guards WHERE case_id=?').bind(row.id)])).slice(1,-1)}catch(e){if(String(e).includes('STALE_ENTITY_REVISION'))fail('STALE_REVISION');throw e}
}
const publicCase=r=>({id:r.id,subjectType:r.subject_type,status:r.status,revision:r.revision,reason:r.reason,expiresAt:r.expires_at,purgeAt:r.purge_at,registryCheckedAt:r.registry_checked_at});
async function identity(user,env){const r=await env.DB.prepare("SELECT * FROM verified_identities WHERE user_id=? AND revoked_at IS NULL AND expires_at>?").bind(user.id,new Date().toISOString()).first();if(!identityConfigured(env)||!r)fail('IDENTITY_REQUIRED',409);}
const note=(env,caseId,reviewer,action,reason,digest=null)=>env.DB.prepare('INSERT INTO entity_reviews(id,case_id,reviewer_id,action,reason,evidence_digest) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),caseId,reviewer,action,reason,digest);
export async function entityApi({request,env,user,admin,path,method,json}) {
 const base=admin?'/api/admin/entity-cases':'/api/me/entity-cases';
 const parts=path.slice(base.length).split('/').filter(Boolean);
 if(method==='GET'&&!parts.length){
  const rows=admin?await env.DB.prepare('SELECT * FROM entity_cases ORDER BY created_at DESC LIMIT 100').all():await env.DB.prepare('SELECT * FROM entity_cases WHERE user_id=?').bind(user.id).all();
  return json({available:entityConfigured(env),consentVersion:ENTITY_CONSENT_VERSION,cases:rows.results.map(publicCase),retentionDays:30});
 }
 if(!entityConfigured(env))fail('ENTITY_REVIEW_NOT_READY',503);
 if(!admin)await identity(user,env);
 let row=parts[0]?await env.DB.prepare('SELECT * FROM entity_cases WHERE id=?').bind(parts[0]).first():null;
 if(parts.length&&(!row||(!admin&&row.user_id!==user.id)))fail('CASE_NOT_FOUND',404);
 if(method==='GET'&&row){
  const docs=await env.DB.prepare('SELECT id,kind,digest,purge_at,cipher IS NOT NULL AS available FROM entity_evidence WHERE case_id=?').bind(row.id).all();
  if(parts[1]==='evidence'&&parts[2]){
   const doc=await env.DB.prepare('SELECT * FROM entity_evidence WHERE id=? AND case_id=?').bind(parts[2],row.id).first();
   if(!doc?.cipher||Date.parse(doc.purge_at)<=Date.now())fail('EVIDENCE_EXPIRED',410);
   await note(env,row.id,user.id,'EVIDENCE_READ','권한 있는 증빙 열람',doc.digest).run();
   const data=await unseal(doc.cipher,env.EVIDENCE_ENCRYPTION_KEY,doc.id);
   return new Response(unb64(data.base64),{headers:{'Content-Type':doc.mime,'Content-Disposition':'attachment; filename="evidence.'+(doc.mime==='image/png'?'png':'jpg')+'"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }
  if(admin)await note(env,row.id,user.id,'CASE_READ','자격 심사 자료 열람').run();
  const privateData=row.private_cipher&&Date.parse(row.purge_at)>Date.now()?await unseal(row.private_cipher,env.EVIDENCE_ENCRYPTION_KEY,row.id):null;
  return json({case:publicCase(row),details:privateData,evidence:docs.results});
 }
 if(method!=='POST')fail('METHOD_NOT_ALLOWED',405);
 const body=await limitedJson(request);
 if(!parts.length&&!admin){
  if(!types[body.subjectType]||body.consent!==true||body.consentVersion!==ENTITY_CONSENT_VERSION)fail('ENTITY_CONSENT_REQUIRED',400);
  const registration=String(body.registrationNumber||'').replace(/-/g,'');
  const name=String(body.organizationName||'').trim(),representative=String(body.representative||'').trim();
  if(!/^\d{10}$/.test(registration)||name.length<2||name.length>100||representative.length<2||representative.length>60||!/^\d{8}$/.test(body.openedOn||''))fail('INVALID_ENTITY_DETAILS',400);
  const id='ec_'+crypto.randomUUID();
  const privateData={registrationNumber:registration,organizationName:name,representative,openedOn:body.openedOn,authority:body.authority==='delegate'?'delegate':'representative'};
  const digest=await identityDigest('entity:'+registration,env);
  const old=await env.DB.prepare('SELECT * FROM entity_cases WHERE user_id=? AND subject_type=?').bind(user.id,body.subjectType).first();
  if(old){if(!['REJECTED','REVOKED','EXPIRED','WITHDRAWN'].includes(old.status))fail('CASE_ALREADY_EXISTS');
   const purgeAt=future(30);await atomic(env,old,[
    env.DB.prepare("UPDATE entity_cases SET status='DRAFT',registration_hash=?,private_cipher=?,consent_version=?,registry_checked_at=NULL,registry_valid=0,revision=revision+1,reason=NULL,expires_at=NULL,purge_at=? WHERE id=? AND revision=?").bind(digest,await seal(privateData,env.EVIDENCE_ENCRYPTION_KEY,old.id),ENTITY_CONSENT_VERSION,purgeAt,old.id,old.revision),
    env.DB.prepare('UPDATE entity_evidence SET cipher=NULL WHERE case_id=?').bind(old.id),note(env,old.id,user.id,'REOPEN','새 자료로 재심사 신청')]);return json({id:old.id},201);
  }
  await env.DB.batch([env.DB.prepare('INSERT INTO entity_cases(id,user_id,subject_type,registration_hash,private_cipher,consent_version,purge_at) VALUES(?,?,?,?,?,?,?)').bind(id,user.id,body.subjectType,digest,await seal(privateData,env.EVIDENCE_ENCRYPTION_KEY,id),ENTITY_CONSENT_VERSION,future(30)),note(env,id,user.id,'CREATE','자격 심사 및 30일 원문 보유에 동의')]);return json({id},201);
 }
 if(!row)fail('CASE_NOT_FOUND',404);
 if(body.revision!==row.revision)fail('STALE_REVISION');
 if(parts[1]==='evidence'&&!admin){
  if(row.status!=='DRAFT'||Date.parse(row.purge_at)<=Date.now())fail('CASE_NOT_EDITABLE');
  if(!['REGISTRATION','REGISTRY','AUTHORITY'].includes(body.kind)||!['image/png','image/jpeg'].includes(body.mime)||typeof body.base64!=='string')fail('INVALID_EVIDENCE',400);
  let bytes;try{bytes=unb64(body.base64)}catch{fail('INVALID_EVIDENCE',400)}
  if(bytes.length<8||bytes.length>512*1024)fail('EVIDENCE_SIZE_LIMIT',413);
  const isPng=[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b),isJpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(!(body.mime==='image/png'?isPng:isJpg))fail('INVALID_EVIDENCE',400);
  const docId=row.id+'_'+body.kind, digest=await sha(body.base64);
  await atomic(env,row,[env.DB.prepare('UPDATE entity_cases SET revision=revision+1 WHERE id=?').bind(row.id),env.DB.prepare('INSERT INTO entity_evidence(id,case_id,kind,cipher,digest,mime,purge_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(case_id,kind) DO UPDATE SET cipher=excluded.cipher,digest=excluded.digest,mime=excluded.mime,purge_at=excluded.purge_at').bind(docId,row.id,body.kind,await seal({base64:body.base64},env.EVIDENCE_ENCRYPTION_KEY,docId),digest,body.mime,row.purge_at),note(env,row.id,user.id,'EVIDENCE_UPLOAD',body.kind,digest)]);return json({ok:true});
 }
 if(parts[1]==='submit'&&!admin){
  if(row.status!=='DRAFT'||Date.parse(row.purge_at)<=Date.now())fail('CASE_NOT_EDITABLE');
  const docs=await env.DB.prepare('SELECT kind FROM entity_evidence WHERE case_id=? AND cipher IS NOT NULL AND purge_at>?').bind(row.id,new Date().toISOString()).all();
  const required=row.subject_type==='corporation'?['REGISTRATION','REGISTRY','AUTHORITY']:['REGISTRATION','AUTHORITY'];
  if(!required.every(k=>docs.results.some(d=>d.kind===k)))fail('EVIDENCE_REQUIRED');
  await atomic(env,row,[env.DB.prepare("UPDATE entity_cases SET status='SUBMITTED',revision=revision+1 WHERE id=? AND status='DRAFT' AND revision=?").bind(row.id,row.revision),note(env,row.id,user.id,'SUBMIT','심사 제출')]);return json({ok:true});
 }
 if(parts[1]==='registry'&&admin){
  if(row.status!=='SUBMITTED'||!row.private_cipher||Date.parse(row.purge_at)<=Date.now())fail('CASE_NOT_REVIEWABLE');
  if(!env.NTS_API_KEY)fail('NTS_PROVIDER_REQUIRED',503);
  const data=await unseal(row.private_cipher,env.EVIDENCE_ENCRYPTION_KEY,row.id);
  let result;try{const response=await fetch('https://api.odcloud.kr/api/nts-businessman/v1/validate?serviceKey='+encodeURIComponent(env.NTS_API_KEY),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businesses:[{b_no:data.registrationNumber,start_dt:data.openedOn,p_nm:data.representative}]}),signal:AbortSignal.timeout(10000)});if(!response.ok)fail('REGISTRY_UNAVAILABLE',503);result=await response.json()}catch{fail('REGISTRY_UNAVAILABLE',503)}
  const item=result.data?.[0];const valid=item?.b_no===data.registrationNumber&&item.valid==='01'&&item.status?.b_stt_cd==='01';
  await atomic(env,row,[env.DB.prepare('UPDATE entity_cases SET registry_valid=?,registry_checked_at=?,revision=revision+1 WHERE id=? AND revision=?').bind(valid?1:0,new Date().toISOString(),row.id,row.revision),note(env,row.id,user.id,'REGISTRY_CHECK',valid?'국세청 진위·계속사업 확인':'국세청 확인 불일치')]);return json({valid});
 }
 if(parts[1]==='review'&&admin){
  const action=body.decision,reason=String(body.reason||'').trim();
  if(!['APPROVED','REJECTED','REVOKED','RECONFIRM_REQUIRED'].includes(action)||reason.length<10||reason.length>500)fail('REVIEW_REASON_REQUIRED',400);
  if(user.id===row.user_id)fail('SELF_REVIEW_DENIED',403);
  if(action==='APPROVED'){
   if(row.status!=='SUBMITTED'||Date.parse(row.purge_at)<=Date.now())fail('CASE_NOT_REVIEWABLE');
   await identity({id:row.user_id},env);
   const duplicate=await env.DB.prepare("SELECT id FROM entity_cases WHERE registration_hash=? AND status='APPROVED' AND id<>?").bind(row.registration_hash,row.id).first();if(duplicate)fail('ENTITY_ALREADY_REPRESENTED');
   if(row.subject_type!=='organization'&&(!row.registry_valid||Date.parse(row.registry_checked_at)<Date.now()-ms))fail('REGISTRY_CHECK_REQUIRED');
   if(body.authorityConfirmed!==true||body.registrationConfirmed!==true||(row.subject_type==='corporation'&&body.registryConfirmed!==true))fail('AUTHORITY_REVIEW_REQUIRED');
   const docs=await env.DB.prepare('SELECT kind FROM entity_evidence WHERE case_id=? AND cipher IS NOT NULL AND purge_at>?').bind(row.id,new Date().toISOString()).all();
   if(!['REGISTRATION','AUTHORITY',...(row.subject_type==='corporation'?['REGISTRY']:[])].every(k=>docs.results.some(d=>d.kind===k)))fail('EVIDENCE_REQUIRED');
  }else if(!['SUBMITTED','APPROVED'].includes(row.status))fail('CASE_NOT_REVIEWABLE');
  const status=action==='RECONFIRM_REQUIRED'?'REVOKED':action,expires=action==='APPROVED'?future(365):null;
  const verStatus=action==='APPROVED'?'VERIFIED':action==='REJECTED'?'REJECTED':'REVOKED';
  const result=await atomic(env,row,[
   env.DB.prepare('UPDATE entity_cases SET status=?,reason=?,expires_at=?,revision=revision+1 WHERE id=? AND revision=?').bind(status,reason,expires,row.id,row.revision),
   env.DB.prepare(`INSERT INTO member_verifications(id,user_id,verification_type,subject_type,status,provider,provider_reference_hash,verified_at,expires_at,status_reason) VALUES(?,?,?,?,?,'entity-review-v1',?,?,?,?) ON CONFLICT(user_id,verification_type,subject_type) DO UPDATE SET status=excluded.status,provider=excluded.provider,provider_reference_hash=excluded.provider_reference_hash,verified_at=excluded.verified_at,expires_at=excluded.expires_at,status_reason=excluded.status_reason,revoked_at=NULL`).bind('ev_'+row.id,row.user_id,types[row.subject_type],row.subject_type,verStatus,await sha(row.id+':'+row.revision),new Date().toISOString(),expires,reason),
   note(env,row.id,user.id,action,reason)
  ]);
  if(result[0].meta.changes!==1)fail('STALE_REVISION');return json({ok:true});
 }
 if(parts[1]==='withdraw'&&!admin&&['DRAFT','SUBMITTED'].includes(row.status)){
  await atomic(env,row,[env.DB.prepare("UPDATE entity_cases SET status='WITHDRAWN',private_cipher=NULL,revision=revision+1 WHERE id=?").bind(row.id),env.DB.prepare('UPDATE entity_evidence SET cipher=NULL WHERE case_id=?').bind(row.id),note(env,row.id,user.id,'WITHDRAW','신청자 철회 및 원문 파기')]);return json({ok:true});
 }
 fail('UNKNOWN_ENTITY_ACTION',404);
}
export async function purgeEntityEvidence(env){
 const now=new Date().toISOString();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO entity_reviews(id,case_id,action,reason) SELECT 'purge_'||id||'_'||revision,id,'PURGE','30일 보유기간 만료 원문 파기' FROM entity_cases WHERE private_cipher IS NOT NULL AND purge_at<=?").bind(now),
  env.DB.prepare('UPDATE entity_cases SET private_cipher=NULL WHERE purge_at<=?').bind(now),
  env.DB.prepare('UPDATE entity_evidence SET cipher=NULL WHERE purge_at<=?').bind(now),
  env.DB.prepare("DELETE FROM entity_reviews WHERE julianday(created_at)<=julianday('now','-365 days')"),
  env.DB.prepare("DELETE FROM entity_evidence WHERE cipher IS NULL AND julianday(purge_at)<=julianday('now','-335 days')"),
  env.DB.prepare("UPDATE entity_cases SET registration_hash='',reason=NULL WHERE status IN ('REJECTED','REVOKED','EXPIRED','WITHDRAWN') AND julianday(purge_at)<=julianday('now','-335 days')"),
  env.DB.prepare("UPDATE entity_cases SET status='EXPIRED',revision=revision+1 WHERE (status='APPROVED' AND expires_at<=?) OR (status IN ('DRAFT','SUBMITTED') AND purge_at<=?)").bind(now,now)
 ]);
}
