import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import worker from '../worker/index.mjs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
const sql = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if(file.endsWith('.sql')) sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
const DB={prepare(query){return {args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(query).get(...this.args)||null},async all(){return {results:sql.prepare(query).all(...this.args)}},async run(){const r=sql.prepare(query).run(...this.args);return {meta:{changes:Number(r.changes)},success:true}}}},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'false'};
async function req(path,body,cookie='',method=body?'POST':'GET',e=env, extraHeaders={}){const r=await worker.fetch(new Request('https://test.invalid'+path,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...extraHeaders},body:body?JSON.stringify(body):undefined}),e,{waitUntil(){}});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''}}
const material={passwordSalt:Buffer.alloc(16,1).toString('base64'),passwordVerifier:Buffer.alloc(32,2).toString('base64')};
const common={realName:'같은이름',region:'인천',challengeIntent:'both',birthYear:1986,gender:'female',organizationName:'동일회사',interests:'디자인',...material,termsAccepted:true,privacyAccepted:true};
let n=0;const pass=(label)=>{n++;console.log('PASS '+label)};
const a=await req('/api/auth/signup',{...common,displayName:'회귀활동A',phone:'01000001001',email:'a@test.invalid'});assert.equal(a.status,201,JSON.stringify(a.body));pass('ordinary signup inserts all fields');
const b=await req('/api/auth/signup',{...common,displayName:'회귀활동B',phone:'01000001002',email:'b@test.invalid'});assert.equal(b.status,201,JSON.stringify(b.body));pass('same real name / region / demographics / company allowed');
for(const [field,value,code] of [['email','a@test.invalid','EMAIL_EXISTS'],['phone','+82 10-0000-1001','PHONE_EXISTS'],['displayName','회귀활동A','DISPLAY_NAME_EXISTS']]){const r=await req('/api/auth/signup',{...common,displayName:'신규활동명',phone:'01000001003',email:'c@test.invalid',[field]:value});assert.equal(r.body.error?.code,code);pass('duplicate '+field+' specific error')}
const found=await req('/api/auth/find-email',{displayName:'같은이름',phone:'+82 10-0000-1001'});assert.equal(found.body.found,true);assert.ok(found.body.emailHint.includes('*'));pass('email lookup by real name and normalized phone, masked result');
const health=await req('/api/health');assert.equal(health.body.moneyEnabled,false);assert.equal(health.body.moneyMode,'disabled');pass('money stays disabled');
const unauth=await req('/api/admin/overview');assert.ok([401,403].includes(unauth.status));pass('admin blocks anonymous');
await req('/api/auth/logout',{},a.cookie);const me=await req('/api/me',undefined,a.cookie);assert.ok(me.status===401||me.body.user===null);pass('logout revokes session');
// OAuth pending registration is server-bound and cannot trust a client supplied email.
const token='regression-oauth-token';const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
sql.prepare("INSERT INTO oauth_signup_pending VALUES (?, 'google', 'google-test-subject', 'oauth@test.invalid', '소셜활동', datetime('now','+10 minutes'), NULL)").run(hash);
const oc='mc_oauth_signup='+token;
const os=await req('/api/auth/oauth-signup',{...common,displayName:'소셜활동',phone:'01000001004',email:'attacker@test.invalid'},oc);assert.equal(os.status,201,JSON.stringify(os.body));assert.equal(os.body.user.email,'oauth@test.invalid');assert.equal(sql.prepare("SELECT email_verified FROM users WHERE email = 'oauth@test.invalid'").get().email_verified,1);pass('Google signup without password, provider email verified');
const repeated=await req('/api/auth/oauth-signup',{...common,displayName:'중복소셜',phone:'01000001005'},oc);assert.equal(repeated.status,401);pass('OAuth signup token single use');
const challengeInput={title:'동네 로고 디자인 제안',summary:'동네 가게의 새 로고 디자인을 제안해주세요',description:'동네 가게에서 사용할 새 로고와 색상 조합을 디자인하여 제안해주세요.',category:'IDEA',rewardAmount:50000,successCriteria:'원본 디자인과 색상 조합 설명 제출',paymentTrigger:'최종 제안 확인 후 진행 조건 확정',evidenceRequirements:'디자인 원본 파일 제출',deadline:'2099-01-01',visibility:'public'};
const make=await req('/api/challenges',challengeInput,b.cookie,'POST',env,{'Idempotency-Key':'regression-create-001'});assert.equal(make.status,201,JSON.stringify(make.body));const cid=make.body.challenge.id;pass('challenge create');
const replay=await req('/api/challenges',challengeInput,b.cookie,'POST',env,{'Idempotency-Key':'regression-create-001'});assert.equal(replay.body.challenge.id,cid);pass('idempotent challenge replay');
const edited=await req('/api/challenges/'+cid,{...challengeInput,title:'수정된 동네 로고 디자인'},b.cookie,'PUT');assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.challenge.title,'수정된 동네 로고 디자인');pass('challenge edit saved and returned');
const tBody={headline:'로고 제작 경험으로 제안합니다',capability:'동네 가게의 브랜드 로고를 여러 번 제작한 경험을 바탕으로 제안합니다.',approach:'먼저 요구사항을 확인하고 스케치를 만든 다음 색상과 형태를 정리합니다.',expectedDays:7};
const submitted=await req('/api/challenges/'+cid+'/teasers',tBody,os.cookie);assert.equal(submitted.status,201,JSON.stringify(submitted.body));const tid=submitted.body.teaser.id;pass('TEASER submitted');
const te=await req('/api/challenges/'+cid+'/teasers/'+tid,{...tBody,headline:'수정된 로고 제작 제안입니다'},os.cookie,'PUT');assert.equal(te.status,200);pass('TEASER edit');
const candidates=await req('/api/challenges/'+cid+'/teasers',undefined,b.cookie);assert.equal(candidates.body.teasers[0].headline,'수정된 로고 제작 제안입니다');pass('owner candidate review reads saved content');
const forbidden=await req('/api/challenges/'+cid+'/teasers/'+tid,tBody,b.cookie,'PUT');assert.equal(forbidden.status,403);pass('another user cannot edit TEASER');
for(let i=0;i<2;i++) assert.equal((await req('/api/challenges/'+cid+'/teasers/'+tid+'/withdraw',{},os.cookie)).status,200);assert.equal(sql.prepare('SELECT teaser_count FROM challenges WHERE id=?').get(cid).teaser_count,0);assert.equal(sql.prepare('SELECT count(*) n FROM teasers WHERE id=?').get(tid).n,1);pass('withdraw retry preserves row and accurate count');
const inactive=await req('/api/challenges/'+cid+'/shortlist',{teaserId:tid},b.cookie);assert.equal(inactive.body.error?.code,'TEASER_INACTIVE');pass('withdrawn candidate cannot be shortlisted');
assert.equal((await req('/api/challenges/'+cid+'/teasers',tBody,os.cookie)).status,201);pass('withdrawn TEASER resubmits in place');
for(let i=0;i<2;i++) assert.equal((await req('/api/challenges/'+cid+'/shortlist',{teaserId:tid},b.cookie)).status,200);assert.equal(sql.prepare('SELECT shortlisted_count FROM challenges WHERE id=?').get(cid).shortlisted_count,1);pass('shortlist saves once on repeat');
const paid=await req('/api/challenges/'+cid+'/shortlist',{teaserId:tid,mode:'select'},b.cookie);assert.equal(paid.body.error?.code,'MONEY_FLOW_DISABLED');pass('financial finalist stage remains disabled');
const cancel=await req('/api/challenges/'+cid+'/cancel',{reason:'운영 일정 변경으로 챌린지를 취소합니다.'},b.cookie);assert.equal(cancel.status,200,JSON.stringify(cancel.body));assert.equal(sql.prepare('SELECT status FROM challenges WHERE id=?').get(cid).status,'CANCELLED');pass('challenge cancellation saved without deletion');
const cancelledList=await req('/api/challenges?status=CANCELLED');assert.equal(cancelledList.body.challenges.length,0);pass('explicit status filter cannot expose cancelled challenge');
const ordinaryLogin=await req('/api/auth/login',{email:'b@test.invalid',passwordVerifier:material.passwordVerifier});assert.equal(ordinaryLogin.status,200);pass('ordinary password login');
// DOM regression: run real delegated handlers against real DOM (no browser globals/auth).
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://test.invalid/',runScripts:'outside-only',pretendToBeVisual:true});const win=dom.window;win.scrollTo=()=>{};win.HTMLElement.prototype.scrollIntoView=()=>{};win.matchMedia=()=>({matches:false});
const context=dom.getInternalVMContext();let app=readFileSync(new URL('../public/assets/live-app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('init().catch((error) => fatal(error));','');
vm.runInContext("class ApiError extends Error {constructor(message, opts={}){super(message); Object.assign(this,opts)}}; const apiClient={};",context);vm.runInContext(app,context);
vm.runInContext("let detailOpens=0; openChallenge=async()=>{detailOpens++}; bindGlobalEvents();",context);
for(const id of ['challenge-edit-form','cancel-form','teaser-form','teaser-edit-form','teaser-withdraw-form']){vm.runInContext(`openModal('<form id="${id}" data-challenge-id="test"><input name="title"><textarea name="reason"></textarea><button type="submit">저장</button></form>')`,context);const form=win.document.getElementById(id);for(const field of form.querySelectorAll('input,textarea')){field.dispatchEvent(new win.MouseEvent('click',{bubbles:true,cancelable:true}));field.value='입력 유지 검증';assert.equal(field.isConnected,true)}assert.equal(vm.runInContext('detailOpens',context),0);pass(id+' input does not open detail')}
try { vm.runInContext("openAuthModal('signup'); submitSignup=async()=>{await Promise.resolve();throw new ApiError('이미 사용 중인 활동명입니다.',{code:'DISPLAY_NAME_EXISTS'})};",context);
} catch(e) {console.log(e.name,e.message,e.stack);throw e}
await vm.runInContext("handleForm(document.querySelector('#signup-form'))",context);assert.match(win.document.querySelector('.field-error').textContent,/활동명/);assert.equal(win.document.querySelector('[name=displayName]').getAttribute('aria-invalid'),'true');assert.equal(win.document.querySelector('[type=submit]').disabled,false);pass('async signup rejection shows inline error and unlocks submit');
assert.ok(win.document.querySelector('[name=realName]'));assert.equal(win.document.querySelectorAll('#signup-form .signup-consent input').length,4);pass('real name and nickname are separate');
win.close();console.log(`Passed ${n} behavioral regression checks`);
