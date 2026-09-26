import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../worker/index.mjs';
import {createTestOrder,transitionTestOrder} from '../worker/transactions.mjs';
import {IDENTITY_CONSENT_VERSION} from '../worker/identity.mjs';
const sql=new DatabaseSync(':memory:');
for(const f of readdirSync(new URL('../migrations/',import.meta.url)).sort()) if(f.endsWith('.sql')) sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
const DB={prepare(query){return {args:[],bind(...a){this.args=a;return this},async first(){return sql.prepare(query).get(...this.args)||null},async all(){return {results:sql.prepare(query).all(...this.args)}},async run(){if(/^\s*SELECT/.test(query)) return this.all();const r=sql.prepare(query).run(...this.args);return {meta:{changes:Number(r.changes)}}}}},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'false',VERIFICATION_ENFORCEMENT:'advisory'};
const local={...env,APP_ENV:'test',LOCAL_MONEY_SIMULATION:'false'};
async function req(path,body,cookie='',e=env,method=body===undefined?'GET':'POST',headers={}) {
 const r=await worker.fetch(new Request('https://test.invalid'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'Idempotency-Key':crypto.randomUUID(),...headers},body:body===undefined?undefined:JSON.stringify(body)}),e,{waitUntil(){}});
 return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
}
let checks=0;const pass=s=>{checks++;console.log('PASS launch: '+s)};
const common={realName:'인증테스터',region:'서울',birthYear:1980,gender:'female',termsAccepted:true,privacyAccepted:true,passwordSalt:Buffer.alloc(16,1).toString('base64'),passwordVerifier:Buffer.alloc(32,2).toString('base64')};
const a=await req('/api/auth/signup',{...common,displayName:'인증의뢰자',email:'owner@test.invalid',phone:'01011112222'});
const b=await req('/api/auth/signup',{...common,displayName:'인증수행자',email:'solver@test.invalid',phone:'01011113333'});
const c=await req('/api/auth/signup',{...common,displayName:'추가테스터',email:'third@test.invalid',phone:'01011114444'});
assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(a.body.user.verification.identity,false);pass('signup is never identity verification');
const mission={title:'지역 로고 디자인 요청',summary:'동네 가게 로고 디자인을 요청합니다.',description:'가게에서 쓸 로고를 디자인하고 수정 가능한 원본 파일과 설명을 전달해주세요.',category:'IDEA',region:'서울',rewardAmount:100000,successCriteria:'로고 파일과 색상 조합 설명 제출',paymentTrigger:'선정 후 보상금 결제 확인',evidenceRequirements:'디자인 원본 파일 제출',deadline:'2099-01-01',visibility:'public'};
assert.equal((await req('/api/challenges',mission,a.cookie)).body.error.code,'EMAIL_VERIFICATION_REQUIRED');
assert.equal((await req('/api/challenges',mission,a.cookie,{...env,IDENTITY_VERIFICATION_PROVIDER:'anything'})).body.error.code,'EMAIL_VERIFICATION_REQUIRED');
assert.equal((await req('/api/health',undefined,'',{...env,PUBLIC_MONEY_ENABLED:'true'})).body.moneyEnabled,false);
assert.equal((await req('/api/health',undefined,'',{...env,PUBLIC_MONEY_ENABLED:'true'})).body.moneyMode,'disabled');pass('production ignores advisory mode and a money toggle cannot enable live money');
for(const path of ['/api/transactions','/api/transactions/payments','/api/transactions/refunds','/api/transactions/payouts','/api/internal/payout/confirm','/api/challenges/any/funding/confirm']) assert.equal((await req(path,{},a.cookie)).status,503);
assert.equal((await req('/api/admin/verification-reviews')).status,401);
assert.equal((await req('/api/admin/verification-reviews',undefined,a.cookie)).status,403);
assert.equal((await req('/api/me/identity/start',{consent:true,consentVersion:IDENTITY_CONSENT_VERSION},a.cookie)).status,503);
assert.equal((await req('/api/me/actor-profiles',null,a.cookie)).status,400);pass('anonymous, member admin bypass, missing provider and malformed JSON fail closed');
const connected={...env,IDENTITY_VERIFICATION_PROVIDER:'portone-v2',IDENTITY_INTEGRATION_APPROVED:'true',PORTONE_STORE_ID:'store-test-1234',PORTONE_IDENTITY_CHANNEL_KEY:'channel-test-1234',PORTONE_API_SECRET:'secret-fixture-not-live',IDENTITY_HASH_SECRET:'x'.repeat(40)};
const originalFetch=globalThis.fetch;
let resultFor,providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;return Response.json(resultFor);};
async function begin(account) {
 const r=await req('/api/me/identity/start',{consent:true,consentVersion:IDENTITY_CONSENT_VERSION},account.cookie,connected);
 assert.equal(r.status,201,JSON.stringify(r.body));assert.match(r.body.identityVerificationId,/^[A-Za-z0-9]{1,40}$/);return r.body.identityVerificationId;
}
function proof(id,phone,di) {return {id,status:'VERIFIED',verifiedAt:new Date().toISOString(),verifiedCustomer:{name:common.realName,phoneNumber:phone,birthDate:'1980-01-01',di}};}
const idA=await begin(a);
resultFor=proof(idA,'01011112222','DI_A');
assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idA},b.cookie,connected)).status,404);
assert.equal(providerCalls,0);pass('identity attempt is bound to the logged-in account before provider lookup');
resultFor.status='FAILED';assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idA},a.cookie,connected)).status,409);
resultFor=proof(idA,'01011112222','DI_A');resultFor.verifiedCustomer.name='다른사람';assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idA},a.cookie,connected)).body.error.code,'IDENTITY_PROFILE_MISMATCH');
resultFor=proof(idA,'01011112222','DI_A');
assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idA},a.cookie,connected)).status,200);
assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idA},a.cookie,connected)).body.idempotent,true);
assert.equal(JSON.stringify(sql.prepare('SELECT * FROM verified_identities').all()).includes('DI_A'),false);
pass('provider result checked; mismatch rejected; replay safe; no raw DI stored');
const idB=await begin(b);resultFor=proof(idB,'01011113333','DI_A');assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idB},b.cookie,connected)).body.error.code,'IDENTITY_CONFLICT');
resultFor=proof(idB,'01011113333','DI_B');assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idB},b.cookie,connected)).status,200);pass('unique identity prevents duplicate identity across accounts');
const idC=await begin(c);sql.prepare("UPDATE identity_attempts SET expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(idC);
assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idC},c.cookie,connected)).body.error.code,'IDENTITY_ATTEMPT_EXPIRED');
globalThis.fetch=async()=>{throw Error('timeout')};const idC2=await begin(c);
assert.equal((await req('/api/me/identity/complete',{identityVerificationId:idC2},c.cookie,connected)).status,503);globalThis.fetch=originalFetch;pass('expiry and provider failure never authenticate');
// Email fixtures for mission writes; identity fixtures continue to protect transactions.
sql.prepare('UPDATE users SET email_verified=1 WHERE id IN (?,?)').run(a.body.user.id,b.body.user.id);
const made=await req('/api/challenges',mission,a.cookie,connected,'POST',{'Idempotency-Key':'launch-mission-0001'});assert.equal(made.status,201,JSON.stringify(made.body));const cid=made.body.challenge.id;
const teaser={headline:'원본 로고 제작 제안',capability:'브랜드 로고 디자인과 벡터 원본 제작 경험을 보유하고 있습니다.',approach:'요구 사항을 확인하고 시안을 제안한 후 최종 원본을 납품하겠습니다.',expectedDays:3,subjectType:'individual'};
assert.equal((await req('/api/challenges/'+cid+'/teasers',teaser,c.cookie,connected)).body.error.code,'EMAIL_VERIFICATION_REQUIRED');
const applied=await req('/api/challenges/'+cid+'/teasers',teaser,b.cookie,connected);assert.equal(applied.status,201,JSON.stringify(applied.body));
sql.prepare("UPDATE member_verifications SET expires_at='2000-01-01T00:00:00Z' WHERE user_id=?").run(b.body.user.id);
assert.equal((await req('/api/challenges/'+cid+'/shortlist',{teaserId:applied.body.teaser.id,mode:'select'},a.cookie,connected)).body.error.code,'VERIFICATION_REQUIRED');
assert.equal((await req('/api/challenges/'+cid+'/teasers/'+applied.body.teaser.id,teaser,b.cookie,connected,'PUT')).status,200);
assert.equal((await req('/api/challenges',{...mission,subjectType:'corporation'},a.cookie,connected)).status,201);
assert.equal((await req('/api/challenges/'+cid+'/shortlist',{teaserId:applied.body.teaser.id},a.cookie,connected)).status,200);
pass('email allows registration, editing and shortlist; expired identity still blocks final confirmation');
const adminEnv={...connected,PRIMARY_ADMIN_EMAIL:'owner@test.invalid'};
const verificationId=sql.prepare("SELECT id FROM member_verifications WHERE user_id=? AND provider='portone-v2'").get(b.body.user.id).id;
assert.equal((await req('/api/admin/verification-reviews',{verificationId,decision:'VERIFIED',reason:'허위 승인 시도 방지 테스트'},a.cookie,adminEnv)).status,400);
assert.equal((await req('/api/admin/verification-reviews',{verificationId,decision:'REVOKED',reason:'운영팀 재확인 필요 테스트'},a.cookie,adminEnv)).status,200);
assert.equal(sql.prepare('SELECT count(*) n FROM verification_reviews').get().n,1);assert.ok(sql.prepare('SELECT revoked_at FROM verified_identities WHERE user_id=?').get(b.body.user.id).revoked_at);pass('admin cannot fabricate approval; revocation and reason are audited');
sql.prepare('UPDATE challenges SET selected_solver_id=? WHERE id=?').run(b.body.user.id,cid);
const orderInput={challengeId:cid,ownerId:a.body.user.id,solverId:b.body.user.id,amount:100000,requestKey:'order-request-0001'};
const order=await createTestOrder(local,orderInput);
assert.equal((await createTestOrder(local,orderInput)).id,order.id);
await assert.rejects(createTestOrder(local,{...orderInput,amount:200000}),/IDEMPOTENCY_CONFLICT/);
await assert.rejects(createTestOrder(env,orderInput),/LIVE_PROVIDER_NOT_RELEASED/);
let current=order, seq=0;
async function move(action,actorId=a.body.user.id,extra={}) {const r=await transitionTestOrder(local,{orderId:order.id,requestKey:'transaction-event-'+String(++seq).padStart(4,'0'),action,actorId,revision:current.revision,...extra});current=r;return r;}
await move('REQUEST_PAYMENT');await assert.rejects(move('PAYMENT_SUCCEEDED',a.body.user.id,{providerReference:'pay-1',amount:100000}),/PROVIDER_ONLY/);
await assert.rejects(move('PAYMENT_SUCCEEDED','TEST_PROVIDER',{providerReference:'pay-1',amount:1}),/PROVIDER_RESULT_MISMATCH/);
await move('PAYMENT_SUCCEEDED','TEST_PROVIDER',{providerReference:'pay-1',amount:100000});
await assert.rejects(move('SUBMIT_PROOF',a.body.user.id),/SOLVER_ONLY/);
await move('SUBMIT_PROOF',b.body.user.id);await move('ACCEPT_PROOF');
await move('OPEN_DISPUTE',b.body.user.id,{reason:'납품과 지급 조건에 이견이 있어 확인을 요청합니다.'});
await assert.rejects(move('QUEUE_PAYOUT','TEST_OPERATOR'),/INVALID_TRANSITION/);
await move('RESOLVE_PAYOUT','TEST_OPERATOR',{reason:'양측 의견과 증빙을 대조하여 지급 합의를 확인했습니다.'});
await move('QUEUE_PAYOUT','TEST_OPERATOR');await move('PAYOUT_FAILED','TEST_PROVIDER');
await assert.rejects(move('QUEUE_PAYOUT','TEST_OPERATOR'),/INVALID_TRANSITION/);pass('10% fee, role authorization, disputed payout hold and unsafe payout retry blocked');
await move('OPEN_DISPUTE',a.body.user.id,{reason:'지급실패 결과를 확인하고 재처리를 요청합니다.'});
await move('RESOLVE_PAYOUT','TEST_OPERATOR',{reason:'업체 조회로 미지급을 확인하고 재처리 승인했습니다.'});await move('QUEUE_PAYOUT','TEST_OPERATOR');
const payoutKey='final-payout-event-0001';const params={orderId:order.id,requestKey:payoutKey,action:'PAYOUT_SUCCEEDED',actorId:'TEST_PROVIDER',revision:current.revision,providerReference:'payout-1',amount:90000};
await transitionTestOrder(local,params);assert.equal((await transitionTestOrder(local,params)).idempotent,true);
await assert.rejects(transitionTestOrder(local,{...params,amount:80000}),/IDEMPOTENCY_CONFLICT/);
const ledger=sql.prepare('SELECT SUM(debit) d,SUM(credit) c FROM transaction_ledger WHERE order_id=?').get(order.id);assert.equal(ledger.d,ledger.c);
assert.equal(sql.prepare("SELECT SUM(credit) n FROM transaction_ledger WHERE order_id=? AND account='PLATFORM_FEE'").get(order.id).n,10000);
assert.throws(()=>sql.prepare('UPDATE transaction_ledger SET debit=1').run(),/IMMUTABLE_LEDGER/);pass('duplicate payout replay produces one balanced immutable accounting entry');
for(const scenario of ['refund','cancel','stale']) {
 const mc=await req('/api/challenges',{...mission,title:'지역 '+scenario+' 결과물 제작 요청'},a.cookie,connected,'POST',{'Idempotency-Key':'order-mission-'+scenario+'-0001'});assert.equal(mc.status,201);
 sql.prepare('UPDATE challenges SET selected_solver_id=? WHERE id=?').run(b.body.user.id,mc.body.challenge.id);
 const o=await createTestOrder(local,{...orderInput,challengeId:mc.body.challenge.id,requestKey:'test-order-'+scenario+'-0001'});let r=o;let i=0;
 const step=async(action,actorId=a.body.user.id,extra={})=>r=await transitionTestOrder(local,{orderId:o.id,requestKey:'event-'+scenario+'-'+String(++i).padStart(8,'0'),action,actorId,revision:r.revision,...extra});
 if(scenario==='cancel'){await step('CANCEL');assert.equal(r.state,'CANCELLED');continue;}
 await step('REQUEST_PAYMENT');
 if(scenario==='stale'){await assert.rejects(step('PAYMENT_FAILED','TEST_PROVIDER',{revision:0}),/STALE_REVISION/);continue;}
 await step('PAYMENT_SUCCEEDED','TEST_PROVIDER',{providerReference:'pay-refund',amount:100000});await step('REQUEST_REFUND');await step('REFUND_SUCCEEDED','TEST_PROVIDER',{providerReference:'refund-ref-1',amount:100000});assert.equal(r.state,'REFUNDED');
 const balance=sql.prepare('SELECT SUM(debit)-SUM(credit) n FROM transaction_ledger WHERE order_id=?').get(o.id);assert.equal(balance.n,0);
}
assert.equal(sql.prepare("SELECT count(*) n FROM transaction_orders WHERE mode='LIVE'").get().n,0);assert.equal(sql.prepare('SELECT count(*) n FROM settlements').get().n,0);pass('cancel, full refund, stale requests and isolation from live settlements');
console.log(`Passed ${checks} launch regression groups`);
