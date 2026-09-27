import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {identityApi,IDENTITY_CONSENT_VERSION} from '../worker/identity.mjs';
import {entityApi,purgeEntityEvidence,ENTITY_CONSENT_VERSION} from '../worker/entity-verification.mjs';
import {readProviderWebhook,reconcileWebhook} from '../worker/provider-operations.mjs';
import {createTestOrder} from '../worker/transactions.mjs';
import worker from '../worker/index.mjs';

const sql=new DatabaseSync(':memory:');
for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())if(file.endsWith('.sql'))sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
const DB={prepare(q){return{args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(q).get(...this.args)||null},async all(){return{results:sql.prepare(q).all(...this.args)}},async run(){const stmt=sql.prepare(q);if(stmt.columns().length)return this.all();const r=stmt.run(...this.args);return{meta:{changes:Number(r.changes)}}}}},async batch(statements){sql.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB,APP_ENV:'test',IDENTITY_VERIFICATION_PROVIDER:'portone-v2',IDENTITY_INTEGRATION_APPROVED:'true',PORTONE_STORE_ID:'store-fixture',PORTONE_IDENTITY_CHANNEL_KEY:'channel-fixture',PORTONE_API_SECRET:'fixture-secret',IDENTITY_HASH_SECRET:'h'.repeat(40),ENTITY_REVIEW_POLICY_APPROVED:'true',EVIDENCE_ENCRYPTION_KEY:'ab'.repeat(32),PROVIDER_SANDBOX_ENABLED:'true',TOSS_SECRET_KEY:'test_sk_fixture',TOSS_PAYOUT_SECURITY_KEY:'cd'.repeat(32)};
const user={id:'member_fixture_owner',real_name:'시험대표',phone:'01012345678'},solver={id:'member_fixture_solver'};
for(const [id,name] of [[user.id,'시험의뢰자'],[solver.id,'시험수행자']])sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,display_name) VALUES(?,?,?,?,?)').run(id,id+'@test.invalid','fixture','fixture',name);
const json=(body,status=200)=>({body,status}),problem=(status,code,message)=>({status,body:{error:{code,message}}});
const auditStatement=(e,actor,action,type,id,_before,after)=>e.DB.prepare('INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,after_json) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,type,id,JSON.stringify(after));
const identity=(action,body,as=user)=>identityApi({action,body,user:as,env,json,problem,auditStatement});
const begin=async(as=user)=>{const r=await identity('start',{consent:true,consentVersion:IDENTITY_CONSENT_VERSION},as);assert.equal(r.status,201);return r.body.identityVerificationId};
let passes=0;const pass=label=>{passes++;console.log('PASS identity-money: '+label)};
const originalFetch=globalThis.fetch;
let lookup=0,reply;
globalThis.fetch=async()=>{lookup++;return Response.json(reply)};
const proof=id=>({id,status:'VERIFIED',verifiedAt:new Date().toISOString(),verifiedCustomer:{name:user.real_name,phoneNumber:user.phone,birthDate:'1980-01-01',di:'fixture-private-di'}});
try{
 const id=await begin();reply=proof(id);
 assert.equal((await identity('complete',{identityVerificationId:id,status:'VERIFIED'},solver)).status,404);
 assert.equal(lookup,0);
 reply.storeId='wrong-store';assert.equal((await identity('complete',{identityVerificationId:id})).body.error.code,'IDENTITY_RESULT_INVALID');
 reply=proof(id);assert.equal((await identity('complete',{identityVerificationId:id})).status,200);
 assert.equal((await identity('complete',{identityVerificationId:id})).body.idempotent,true);
 assert.equal(sql.prepare("SELECT count(*) n FROM audit_logs WHERE action='IDENTITY_PROVIDER_VERIFIED'").get().n,1);
 pass('account binding, store binding and idempotent single audit');

 sql.prepare("UPDATE verified_identities SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=?").run(user.id);
 assert.equal((await identity('complete',{identityVerificationId:id})).body.error.code,'IDENTITY_RECONFIRM_REQUIRED');
 assert.ok(sql.prepare('SELECT revoked_at FROM verified_identities WHERE user_id=?').get(user.id).revoked_at);
 pass('replayed provider callback cannot resurrect revoked identity');

 const expired=await begin();sql.prepare("UPDATE identity_attempts SET expires_at='not-a-date' WHERE id=?").run(expired);
 assert.equal((await identity('complete',{identityVerificationId:expired})).body.error.code,'IDENTITY_ATTEMPT_EXPIRED');
 assert.equal(sql.prepare('SELECT status FROM identity_attempts WHERE id=?').get(expired).status,'EXPIRED');
 pass('invalid and expired attempt timestamps fail closed and are recorded');

 const concurrent=await begin();reply=proof(concurrent);
 const outcomes=await Promise.all([identity('complete',{identityVerificationId:concurrent}),identity('complete',{identityVerificationId:concurrent})]);
 assert.ok(outcomes.every(x=>x.status===200));
 assert.equal(sql.prepare("SELECT count(*) n FROM audit_logs WHERE action='IDENTITY_PROVIDER_VERIFIED' AND resource_id=?").get(concurrent).n,1);
 assert.equal(sql.prepare('SELECT count(*) n FROM verified_identities WHERE user_id=?').get(user.id).n,1);
 pass('concurrent callback consumes one attempt and writes one verification audit');

 const raceUser={...user,id:solver.id},raceIds=[await begin(raceUser),await begin(raceUser)];
 globalThis.fetch=async url=>{const attemptId=new URL(url).pathname.split('/').at(-1);return Response.json({...proof(attemptId),verifiedCustomer:{...proof(attemptId).verifiedCustomer,di:'race-private-di-'+attemptId}})};
 const races=await Promise.all(raceIds.map(identityVerificationId=>identity('complete',{identityVerificationId},raceUser)));
 assert.deepEqual(races.map(x=>x.status).sort(),[200,409]);
 assert.equal(sql.prepare("SELECT count(*) n FROM identity_attempts WHERE user_id=? AND status='VERIFIED'").get(raceUser.id).n,1);
 const raceSaved=sql.prepare('SELECT provider_reference_hash FROM verified_identities WHERE user_id=?').get(raceUser.id);
 assert.equal(sql.prepare("SELECT provider_reference_hash FROM member_verifications WHERE user_id=? AND verification_type='IDENTITY'").get(raceUser.id).provider_reference_hash,raceSaved.provider_reference_hash);
 assert.equal(sql.prepare("SELECT count(*) n FROM audit_logs WHERE action='IDENTITY_PROVIDER_VERIFIED' AND actor_id=?").get(raceUser.id).n,1);
 globalThis.fetch=async()=>{lookup++;return Response.json(reply)};
 pass('concurrent different identity results cannot split subject and reference across tables');

 sql.prepare("UPDATE member_verifications SET status='REVOKED' WHERE user_id=?").run(user.id);
 await assert.rejects(entityApi({request:new Request('https://test.invalid/api/me/entity-cases/unknown'),env,user,admin:false,path:'/api/me/entity-cases/unknown',method:'GET',json}),/IDENTITY_REQUIRED/);
 sql.prepare("UPDATE member_verifications SET status='VERIFIED' WHERE user_id=?").run(user.id);
 pass('entity access requires both current provider record and current member verification');

 sql.prepare("INSERT INTO entity_cases(id,user_id,subject_type,status,registration_hash,consent_version,purge_at,expires_at) VALUES('expired_entity',?,'business','APPROVED','hash','fixture','2099-01-01','2000-01-01')").run(user.id);
 sql.prepare("INSERT INTO member_verifications(id,user_id,verification_type,subject_type,status,provider,provider_reference_hash,verified_at,expires_at) VALUES('expired_entity_ver',?,'BUSINESS','business','VERIFIED','entity-review-v1','hash',CURRENT_TIMESTAMP,'2099-01-01')").run(user.id);
 const cases=await entityApi({request:new Request('https://test.invalid/api/me/entity-cases'),env,user,admin:false,path:'/api/me/entity-cases',method:'GET',json});
 assert.equal(cases.body.cases[0].status,'EXPIRED');await purgeEntityEvidence(env);await purgeEntityEvidence(env);
 assert.equal(sql.prepare("SELECT status FROM member_verifications WHERE id='expired_entity_ver'").get().status,'EXPIRED');
 pass('expired entity badge is not shown as current and maintenance is repeat-safe');

 const entityRequest=(path,body,e=env)=>entityApi({request:new Request('https://test.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env:e,user,admin:false,path,method:'POST',json});
 const created=await entityRequest('/api/me/entity-cases',{subjectType:'business',organizationName:'사업자동확인',registrationNumber:'1234567890',openedOn:'20200101',representative:user.real_name,authority:'representative',consent:true,consentVersion:ENTITY_CONSENT_VERSION});
 const entityId=created.body.id,entityPath='/api/me/entity-cases/'+entityId+'/submit',revision=()=>sql.prepare('SELECT revision FROM entity_cases WHERE id=?').get(entityId).revision;
 await assert.rejects(entityRequest(entityPath,{revision:revision()}),/NTS_PROVIDER_REQUIRED/);
 assert.equal(sql.prepare('SELECT status FROM entity_cases WHERE id=?').get(entityId).status,'DRAFT');
 globalThis.fetch=async()=>{throw new Error('provider timeout')};
 await assert.rejects(entityRequest(entityPath,{revision:revision()},{...env,NTS_API_KEY:'fixture'}),/REGISTRY_UNAVAILABLE/);
 assert.equal(sql.prepare('SELECT status FROM entity_cases WHERE id=?').get(entityId).status,'DRAFT');
 globalThis.fetch=async()=>Response.json({data:[{b_no:'1234567890',valid:'01',status:{b_stt_cd:'02'}}]});
 await assert.rejects(entityRequest(entityPath,{revision:revision()},{...env,NTS_API_KEY:'fixture'}),/REGISTRY_NOT_ACTIVE/);
 assert.equal(sql.prepare('SELECT status FROM entity_cases WHERE id=?').get(entityId).status,'DRAFT');
 sql.prepare("UPDATE member_verifications SET status='REVOKED' WHERE user_id=? AND verification_type='IDENTITY'").run(user.id);
 await assert.rejects(entityRequest(entityPath,{revision:revision()},{...env,NTS_API_KEY:'fixture'}),/IDENTITY_REQUIRED/);
 sql.prepare("UPDATE member_verifications SET status='VERIFIED' WHERE user_id=? AND verification_type='IDENTITY'").run(user.id);
 globalThis.fetch=async()=>Response.json({data:[{b_no:'1234567890',valid:'01',status:{b_stt_cd:'01'}}]});
 const auto=await entityRequest(entityPath,{revision:revision()},{...env,NTS_API_KEY:'fixture'});assert.equal(auto.body.automaticallyVerified,true);
 assert.equal(sql.prepare('SELECT count(*) n FROM entity_evidence WHERE case_id=?').get(entityId).n,0);
 assert.equal(sql.prepare("SELECT status FROM member_verifications WHERE user_id=? AND verification_type='BUSINESS'").get(user.id).status,'VERIFIED');
 assert.equal(sql.prepare("SELECT count(*) n FROM entity_reviews WHERE case_id=? AND action='AUTO_REGISTRY_APPROVED'").get(entityId).n,1);
 globalThis.fetch=async()=>{lookup++;return Response.json(reply)};
 pass('verified proprietor auto-check uses active NTS result; missing key, outage, inactive business or revoked identity never approve');

 const snapshot=JSON.stringify({subjectType:'individual',activityRequirement:'EMAIL',emailVerified:true,requirements:[{type:'IDENTITY',verificationId:'PRIVATE_IDENTIFIER',satisfied:true}],privateMetadata:'DO_NOT_EXPOSE',capturedAt:new Date().toISOString()});
 sql.prepare(`INSERT INTO challenges(id,owner_id,title,summary,description,category,reward_amount,success_criteria,payment_trigger,evidence_requirements,deadline,selected_solver_id,owner_verification_snapshot_json)
 VALUES('mission_fixture',?,'안전한 로고 제작','상점 로고 만들기','상점 로고와 원본을 제작합니다.','IDEA',100000,'원본 납품','결과 확인','원본파일','2099-01-01',?,?)`).run(user.id,solver.id,snapshot);
 const orderInput={challengeId:'mission_fixture',ownerId:user.id,solverId:solver.id,amount:10000,requestKey:'fixture_order_0001'};
 await assert.rejects(createTestOrder(env,orderInput),/MISSION_AMOUNT_MISMATCH/);
 const order=await createTestOrder(env,{...orderInput,amount:100000});assert.equal(order.fee,10000);assert.equal(order.net,90000);
 pass('durable orders cross-check DB amount and calculate 10/90 split on server');

 const publicResponse=await worker.fetch(new Request('https://test.invalid/api/challenges/mission_fixture'),env,{waitUntil(){}});
 assert.equal(publicResponse.status,200);
 const serialized=await publicResponse.text();assert.ok(!serialized.includes('PRIVATE_IDENTIFIER'));assert.ok(!serialized.includes('DO_NOT_EXPOSE'));
 pass('public mission snapshots exclude internal verification identifiers');

 const payout={eventType:'payout.changed',entityBody:{id:'fixture_payout',refPayoutId:'fixture_op'}};
 const raw=JSON.stringify(payout),time=new Date().toISOString();
 const key=await crypto.subtle.importKey('raw',Buffer.from(env.TOSS_PAYOUT_SECURITY_KEY,'hex'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw+':'+time))).toString('base64');
 const request=(content=raw,headers={})=>new Request('https://test.invalid/api/provider-webhooks/toss',{method:'POST',headers:{'Content-Type':'application/json','tosspayments-webhook-transmission-time':time,...headers},body:content});
 await assert.rejects(readProviderWebhook(request(),env),/WEBHOOK_SIGNATURE_INVALID/);
 await assert.rejects(readProviderWebhook(request(raw,{'tosspayments-webhook-signature':'v1:AAAA'}),env),/WEBHOOK_SIGNATURE_INVALID/);
 const headers={'tosspayments-webhook-signature':'v1:AAAA, v1:'+signature};
 assert.deepEqual(await readProviderWebhook(request(raw,headers),env),payout);
 await assert.rejects(readProviderWebhook(request(raw+' ',headers),env),/WEBHOOK_SIGNATURE_INVALID/);
 await assert.rejects(readProviderWebhook(request(raw,{...headers,'tosspayments-webhook-transmission-time':'2000-01-01T00:00:00Z'}),env),/WEBHOOK_TIMESTAMP_INVALID/);
 pass('payout HMAC validates exact raw body, rotation signatures and timestamp');

 const beforeCalls=lookup;
 assert.deepEqual(await reconcileWebhook(env,payout),{ok:true});assert.equal(lookup,beforeCalls);
 const payment={eventType:'PAYMENT_STATUS_CHANGED',data:{paymentKey:'unknown_fixture'}};
 assert.deepEqual(await readProviderWebhook(request(JSON.stringify(payment)),env),payment);
 await assert.rejects(readProviderWebhook(request('x'.repeat(65537)),env),/PAYLOAD_TOO_LARGE/);
 await assert.rejects(readProviderWebhook(request(raw,headers),{...env,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'true'}),/PROVIDER_SANDBOX_NOT_CONFIGURED/);
 pass('unknown references never call provider; bounded hooks and hard production prohibition');

 const signatureDenied=await worker.fetch(request(),env,{waitUntil(){}});assert.equal(signatureDenied.status,401);
 const signedAccepted=await worker.fetch(request(raw,headers),env,{waitUntil(){}});assert.equal(signedAccepted.status,200);
 const disabled=await worker.fetch(request(raw,headers),{...env,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'true'},{waitUntil(){}});assert.equal(disabled.status,503);
 pass('Worker route enforces signature and production barrier before reconciliation');
}finally{globalThis.fetch=originalFetch;sql.close()}
console.log(`Passed ${passes} identity and money security regression groups`);
