import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {simulationApi} from '../worker/simulation.mjs';
import {sha} from '../worker/secure-data.mjs';
import worker from '../worker/index.mjs';
const sql=new DatabaseSync(':memory:');
for(const f of readdirSync(new URL('../migrations/',import.meta.url)).sort())if(f.endsWith('.sql'))sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
const DB={prepare(q){return{args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(q).get(...this.args)||null},async all(){return{results:sql.prepare(q).all(...this.args)}},async run(){const s=sql.prepare(q);if(s.columns().length)return this.all();const r=s.run(...this.args);return{meta:{changes:Number(r.changes)}}}}},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'false',PRIMARY_ADMIN_EMAIL:'simulation.admin@test.invalid'},user={id:'simulation_admin',is_admin:1},other={id:'simulation_other'};
for(const [id,email,admin] of [[user.id,env.PRIMARY_ADMIN_EMAIL,1],[other.id,'simulation.other@test.invalid',0]]){
 sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,display_name,is_admin) VALUES(?,?,?,?,?,?)').run(id,email,'fixture','fixture',id,admin);
 sql.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)').run('session_'+id,id,await sha('token_'+id),'2099-01-01');
}
sql.prepare("INSERT INTO admin_roles(user_id,role) VALUES(?,'primary')").run(user.id);
const realFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=async()=>{networkCalls++;throw Error('simulation must not call any provider')};
let serial=0,groups=0;const key=()=>`readiness_fixture_${++serial}`,pass=s=>{groups++;console.log('PASS simulation-readiness: '+s)};
async function route(cookie=''){const r=await worker.fetch(new Request('https://test.invalid/api/simulations',{headers:{Cookie:cookie}}),env,{waitUntil(){}});return r.status}
assert.equal(await route(),401);assert.equal(await route('mc_session=token_'+other.id),403);assert.equal(await route('mc_session=token_'+user.id),200);
pass('production simulator remains administrator-only without provider credentials');
const actualTables=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'payment_simulations' AND name<>'sessions' ORDER BY name").all().map(x=>x.name);
const snapshot=()=>JSON.stringify(actualTables.map(t=>[t,sql.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));const before=snapshot();
const create=async(body={})=>simulationApi({method:'POST',path:'/api/simulations',body:{requestId:key(),...body},env,user});
let s=(await create({readiness:{owner:{identity:'APPROVED'}},identityVerified:true})).data.simulation;
async function act(action,role='owner',extra={},expected=200){const r=await simulationApi({method:'POST',path:'/api/simulations/'+s.id,body:{action,role,requestId:key(),revision:s.revision,...extra},env,user});assert.equal(r.status,expected,JSON.stringify(r.data));if(r.status===200)s=r.data.simulation;return r}
const check=(role,check,result,expected=200)=>act('SET_SIMULATION_CHECK',role,{check,result},expected);
assert.equal(s.readiness.owner.identity,'UNVERIFIED');assert.equal(s.readiness.solver.accountHolder,'UNVERIFIED');assert.equal(s.readiness.mode,'SIMULATION');assert.equal(s.readiness.actualVerification,false);assert.equal(s.actualCharge,0);
await act('SET_SIMULATION_CHECK','owner',{check:'accountHolder',result:'APPROVED'},403);await act('SET_SIMULATION_CHECK','staff',{check:'identity',result:'APPROVED'},403);
await act('SET_SIMULATION_CHECK','owner',{check:'identity',result:'VERIFIED'},400);await act('SET_SUBJECT_TYPE','owner',{subjectType:'admin'},400);
assert.equal((await simulationApi({method:'POST',path:'/api/simulations/'+s.id,body:{action:'SET_SIMULATION_CHECK',role:'owner',check:'identity',result:'APPROVED',requestId:key(),revision:s.revision},env,user:other})).status,404);
pass('self-supplied real verification flags are ignored; role, result and cross-user access are validated');

await act('SUBMIT_TEASERS','solver');await act('SHORTLIST','owner',{candidateId:s.candidates[0].id});await act('SELECT','owner',{candidateId:s.candidates[0].id});
await act('PAY_APPROVE','owner',{identityVerified:true},409);await check('owner','identity','FAILED');await act('PAY_APPROVE','owner',{},409);
pass('virtual payment is blocked before owner mock identity succeeds, including failed checks');

for(const role of ['owner','solver'])for(const subjectType of ['individual','business','corporation','organization']){
 await act('SET_SUBJECT_TYPE',role,{subjectType});await check(role,'identity','RESET');
 assert.equal(s.readiness[role].qualification,subjectType==='individual'?'NOT_REQUIRED':'UNVERIFIED');
 if(subjectType!=='individual')await check(role,'qualification','APPROVED',409);
 await check(role,'identity','APPROVED');
 if(subjectType==='individual')await check(role,'qualification','APPROVED',400);
 else{await check(role,'qualification','FAILED');if(role==='owner')await act('PAY_APPROVE','owner',{},409);await check(role,'qualification','APPROVED');}
 if(role==='solver')await check(role,'accountHolder','APPROVED');
}
pass('both roles exercise all four actor types; nonindividual qualification requires identity and never creates a real badge');

const replayKey=key(),oldRevision=s.revision;await act('SET_SIMULATION_CHECK','solver',{requestId:replayKey,check:'accountHolder',result:'RESET'});
assert.equal((await act('SET_SIMULATION_CHECK','solver',{requestId:replayKey,revision:oldRevision,check:'accountHolder',result:'RESET'})).data.idempotent,true);
await act('SET_SIMULATION_CHECK','solver',{requestId:replayKey,check:'accountHolder',result:'APPROVED'},409);
const typeKey=key();await act('SET_SUBJECT_TYPE','solver',{requestId:typeKey,subjectType:'business'});
await act('SET_SUBJECT_TYPE','solver',{requestId:typeKey,subjectType:'corporation'},409);
assert.equal(s.readiness.solver.identity,'APPROVED');assert.equal(s.readiness.solver.qualification,'UNVERIFIED');assert.equal(s.readiness.solver.accountHolder,'UNVERIFIED');
await check('solver','accountHolder','APPROVED',409);await check('solver','qualification','APPROVED');await check('solver','accountHolder','APPROVED');
await check('solver','identity','RESET');assert.equal(s.readiness.solver.accountHolder,'UNVERIFIED');assert.equal(s.readiness.solver.qualification,'UNVERIFIED');
pass('idempotency fingerprints include outcome and type; changing type or resetting identity invalidates dependent mock checks');

await act('PAY_FAIL');await act('PAY_APPROVE');assert.equal(s.paymentStatus,'APPROVED');
await act('PARTIAL_REFUND','owner',{refundAmount:20000,reason:'가상 작업범위를 변경하여 일부 보상금을 환불합니다.'});
await act('SUBMIT_PROOF','solver',{proof:'가상 결과물 제출을 완료하였으며 요청한 파일과 작업 증빙을 함께 전달합니다.'});await act('REVIEW_ACCEPT');
await act('PAYOUT_SUCCESS','owner',{},409);await check('solver','identity','APPROVED');await check('solver','qualification','APPROVED');await check('solver','accountHolder','FAILED');
await act('PAYOUT_SUCCESS','owner',{},409);await check('solver','accountHolder','APPROVED');await act('PAYOUT_FAIL');await act('PAYOUT_SUCCESS');
assert.equal(s.transactions.at(-1).amount,72000);assert.equal(s.platformFee,8000);assert.equal(s.actualCharge,0);assert.equal(s.readiness.actualVerification,false);
await check('solver','identity','RESET',409);
pass('100000 mock payment, 20000 partial refund and 72000 payout require solver identity, qualification and holder checks; no actual money');

s=(await create()).data.simulation;const stale=s.revision;
const concurrent=await Promise.all(['APPROVED','FAILED'].map(result=>simulationApi({method:'POST',path:'/api/simulations/'+s.id,body:{action:'SET_SIMULATION_CHECK',role:'owner',check:'identity',result,requestId:key(),revision:stale},env,user})));
assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);
s=(await simulationApi({method:'GET',path:'/api/simulations/'+s.id,env,user})).data.simulation;await act('CANCEL');await check('owner','identity','APPROVED',409);
pass('concurrent mock check updates cannot both commit and cancelled/paid simulations cannot be rewritten');

s=(await create()).data.simulation;const legacy=JSON.parse(sql.prepare('SELECT state_json FROM payment_simulations WHERE id=?').get(s.id).state_json);delete legacy.readiness;
legacy.stage='SUCCESS';legacy.payoutStatus='PROCESSING';sql.prepare('UPDATE payment_simulations SET state_json=? WHERE id=?').run(JSON.stringify(legacy),s.id);
const rawBefore=sql.prepare('SELECT state_json FROM payment_simulations WHERE id=?').get(s.id).state_json;
s=(await simulationApi({method:'GET',path:'/api/simulations/'+s.id,env,user})).data.simulation;
assert.equal(s.readiness.owner.identity,'UNVERIFIED');assert.equal(s.readiness.solver.accountHolder,'UNVERIFIED');assert.equal(sql.prepare('SELECT state_json FROM payment_simulations WHERE id=?').get(s.id).state_json,rawBefore);
await act('PAYOUT_SUCCESS','owner',{},409);await check('solver','identity','APPROVED');await check('solver','accountHolder','APPROVED');await act('PAYOUT_SUCCESS');
pass('legacy JSON receives unverified defaults on read without rewriting saved data and can continue after mock checks');

assert.equal(snapshot(),before);assert.equal(networkCalls,0);globalThis.fetch=realFetch;sql.close();
pass('all member, identity, seller, real finance, reputation and audit tables remain byte-identical; provider calls zero');
console.log(`Passed ${groups} simulation readiness regression groups`);
