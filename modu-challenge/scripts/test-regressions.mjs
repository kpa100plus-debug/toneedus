import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import worker from '../worker/index.mjs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { CATEGORY_META, STATUS_META, FUNDING_META } from '../public/assets/data.js';
import { calculateSettlement } from '../public/assets/business-rules.js';
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
// Reward policy: existing-account migration, create and update boundaries.
sql.prepare("UPDATE users SET bounty_limit=1000000 WHERE email IN ('b@test.invalid','oauth@test.invalid')").run();
sql.prepare("UPDATE users SET strike_count=1 WHERE email='oauth@test.invalid'").run();
sql.exec(readFileSync(new URL('../migrations/0013_reward_limits.sql',import.meta.url),'utf8'));
assert.equal(sql.prepare("SELECT bounty_limit FROM users WHERE email='b@test.invalid'").get().bounty_limit,100000000);
assert.equal(sql.prepare("SELECT bounty_limit FROM users WHERE email='oauth@test.invalid'").get().bounty_limit,1000000);
pass('default account limit upgraded; restricted account limit preserved');
for (const rewardAmount of [9999, 100000001, 10000.5]) {
 const badCreate=await req('/api/challenges',{...challengeInput,rewardAmount},b.cookie,'POST',env,{'Idempotency-Key':'reward-boundary-'+String(rewardAmount).replace('.','-')});
 const badEdit=await req('/api/challenges/'+cid,{...challengeInput,rewardAmount},b.cookie,'PUT');
 assert.equal(badCreate.body.error?.code,'INVALID_REWARD');assert.equal(badEdit.body.error?.code,'INVALID_REWARD');
}
pass('create and edit reject below minimum, above maximum, and fractional reward');
for (const rewardAmount of [10000,3000000,100000000]) {
 const valid=await req('/api/challenges/'+cid,{...challengeInput,rewardAmount},b.cookie,'PUT');assert.equal(valid.status,200,JSON.stringify(valid.body));assert.equal(valid.body.challenge.rewardAmount,rewardAmount);
 if(rewardAmount>=500000){assert.equal(valid.body.moderationPending,true);assert.equal((await req('/api/challenges/'+cid)).status,404)}
}
pass('edit accepts minimum, 3 million, maximum; high reward remains private pending review');
const highCreate=await req('/api/challenges',{...challengeInput,rewardAmount:3000000},b.cookie,'POST',env,{'Idempotency-Key':'reward-high-create-001'});assert.equal(highCreate.status,201);assert.equal(highCreate.body.moderationPending,true);
assert.equal((await req('/api/challenges/'+highCreate.body.challenge.id,undefined,b.cookie)).body.challenge.rewardAmount,3000000);pass('new high reward saves and reopens for owner');
assert.equal((await req('/api/challenges/'+cid,{...challengeInput,rewardAmount:50000},b.cookie,'PUT')).status,200);
const tBody={headline:'로고 제작 경험으로 제안합니다',capability:'동네 가게의 브랜드 로고를 여러 번 제작한 경험을 바탕으로 제안합니다.',approach:'먼저 요구사항을 확인하고 스케치를 만든 다음 색상과 형태를 정리합니다.',expectedDays:7};
const submitted=await req('/api/challenges/'+cid+'/teasers',tBody,os.cookie);assert.equal(submitted.status,201,JSON.stringify(submitted.body));const tid=submitted.body.teaser.id;pass('TEASER submitted');
const te=await req('/api/challenges/'+cid+'/teasers/'+tid,{...tBody,headline:'수정된 로고 제작 제안입니다'},os.cookie,'PUT');assert.equal(te.status,200);pass('TEASER edit');
const candidates=await req('/api/challenges/'+cid+'/teasers',undefined,b.cookie);assert.equal(candidates.body.teasers[0].headline,'수정된 로고 제작 제안입니다');pass('owner candidate review reads saved content');
const ownRead=await req('/api/challenges/'+cid+'/my-teaser',undefined,os.cookie);assert.equal(ownRead.status,200);assert.equal(ownRead.body.teaser.capability,tBody.capability);assert.equal(ownRead.body.teaser.approach,tBody.approach);pass('own submission readable without edit');
assert.equal((await req('/api/challenges/'+cid+'/my-teaser')).status,401);
assert.equal((await req('/api/challenges/'+cid+'/my-teaser',undefined,b.cookie)).status,404);
assert.equal((await req('/api/challenges/'+cid+'/teasers',undefined,os.cookie)).status,403);pass('anonymous, other account and competitor cannot read private submissions');
const forbidden=await req('/api/challenges/'+cid+'/teasers/'+tid,tBody,b.cookie,'PUT');assert.equal(forbidden.status,403);pass('another user cannot edit TEASER');
for(let i=0;i<2;i++) assert.equal((await req('/api/challenges/'+cid+'/teasers/'+tid+'/withdraw',{},os.cookie)).status,200);assert.equal(sql.prepare('SELECT teaser_count FROM challenges WHERE id=?').get(cid).teaser_count,0);assert.equal(sql.prepare('SELECT count(*) n FROM teasers WHERE id=?').get(tid).n,1);pass('withdraw retry preserves row and accurate count');
const withdrawnRead=await req('/api/challenges/'+cid+'/my-teaser',undefined,os.cookie);assert.equal(withdrawnRead.body.teaser.status,'WITHDRAWN');assert.equal(withdrawnRead.body.teaser.canEdit,false);pass('withdrawn submission remains readable');
const inactive=await req('/api/challenges/'+cid+'/shortlist',{teaserId:tid},b.cookie);assert.equal(inactive.body.error?.code,'TEASER_INACTIVE');pass('withdrawn candidate cannot be shortlisted');
assert.equal((await req('/api/challenges/'+cid+'/teasers',tBody,os.cookie)).status,201);pass('withdrawn TEASER resubmits in place');
for(let i=0;i<2;i++) assert.equal((await req('/api/challenges/'+cid+'/shortlist',{teaserId:tid},b.cookie)).status,200);assert.equal(sql.prepare('SELECT shortlisted_count FROM challenges WHERE id=?').get(cid).shortlisted_count,1);pass('shortlist saves once on repeat');
const lockedRead=await req('/api/challenges/'+cid+'/my-teaser',undefined,os.cookie);assert.equal(lockedRead.status,200);assert.equal(lockedRead.body.teaser.canEdit,false);assert.equal(lockedRead.body.teaser.headline,tBody.headline);pass('shortlisted submission readable when editing is locked');
sql.prepare("UPDATE challenges SET visibility='private' WHERE id=?").run(cid);
assert.equal((await req('/api/challenges/'+cid,undefined,os.cookie)).status,404);
assert.equal((await req('/api/challenges/'+cid+'/my-teaser',undefined,os.cookie)).status,200);
sql.prepare("UPDATE challenges SET visibility='public' WHERE id=?").run(cid);pass('own submission survives challenge visibility changes without exposing private challenge');
assert.equal((await req('/api/challenges/'+cid+'/cancel',{reason:'취소요청'},b.cookie)).status,400);
const paid=await req('/api/challenges/'+cid+'/shortlist',{teaserId:tid,mode:'select'},b.cookie);assert.equal(paid.body.error?.code,'MONEY_FLOW_DISABLED');pass('financial finalist stage remains disabled');
const cancel=await req('/api/challenges/'+cid+'/cancel',{reason:'취소합니다'},b.cookie);assert.equal(cancel.status,200,JSON.stringify(cancel.body));assert.equal(sql.prepare('SELECT status FROM challenges WHERE id=?').get(cid).status,'CANCELLED');pass('5 character cancellation saved without deletion; 4 characters blocked');
const cancelledList=await req('/api/challenges?status=CANCELLED');assert.equal(cancelledList.body.challenges.length,0);pass('explicit status filter cannot expose cancelled challenge');
const ordinaryLogin=await req('/api/auth/login',{email:'b@test.invalid',passwordVerifier:material.passwordVerifier});assert.equal(ordinaryLogin.status,200);pass('ordinary password login');

// Integration verification uses a stub mail/provider transport; no real messages are sent.
const transport=globalThis.fetch;let sentMail=null;
const mailEnv={...env,BREVO_API_KEY:'test-only-placeholder',BREVO_SENDER_EMAIL:'sender@test.invalid',GOOGLE_OAUTH_CLIENT_ID:'test-id',GOOGLE_OAUTH_CLIENT_SECRET:'test-only-placeholder'};
try {
 globalThis.fetch=async(url,options)=>{if(String(url)==='https://api.brevo.com/v3/smtp/email'){sentMail=JSON.parse(options.body);return Response.json({messageId:'test'})}throw Error('Unexpected external transport')};
 const registered=await req('/api/auth/signup',{...common,displayName:'인증테스트회원',phone:'01000001991',email:'verify@test.invalid'},'', 'POST',mailEnv);assert.equal(registered.body.pendingVerification,true);assert.equal(registered.cookie,'');
 const pendingLogin=await req('/api/auth/login',{email:'verify@test.invalid',passwordVerifier:material.passwordVerifier},'', 'POST',mailEnv);assert.equal(pendingLogin.status,403);
 const verifyToken=sentMail.htmlContent.match(/token=([A-Za-z0-9_-]+)/)[1];assert.equal((await req('/api/auth/verify-email',{token:verifyToken},'', 'POST',mailEnv)).status,200);
 const verifiedLogin=await req('/api/auth/login',{email:'verify@test.invalid',passwordVerifier:material.passwordVerifier},'', 'POST',mailEnv);assert.equal(verifiedLogin.status,200);pass('signup → email verification → login with mocked mail delivery');
 assert.equal((await req('/api/auth/verify-email',{token:verifyToken},'', 'POST',mailEnv)).status,400);pass('verification link cannot be reused');
 await req('/api/auth/request-password-reset',{email:'verify@test.invalid'},'','POST',mailEnv);
 const resetToken=sentMail.htmlContent.match(/token=([A-Za-z0-9_-]+)/)[1];const newMaterial={passwordSalt:Buffer.alloc(16,3).toString('base64'),passwordVerifier:Buffer.alloc(32,4).toString('base64')};
 assert.equal((await req('/api/auth/reset-password',{token:resetToken,...newMaterial},'','POST',mailEnv)).status,200);
 assert.equal((await req('/api/auth/login',{email:'verify@test.invalid',passwordVerifier:material.passwordVerifier},'','POST',mailEnv)).status,401);pass('password reset invalidates old password');
 const userCount=sql.prepare('SELECT count(*) n FROM users').get().n;
 globalThis.fetch=async(url)=> String(url).includes('/token')?Response.json({access_token:'stub-access'}):Response.json({sub:'verified-google-link',email:'verify@test.invalid',email_verified:true,name:'인증테스트회원'});
 const start=await worker.fetch(new Request('https://test.invalid/api/auth/oauth/google?returnTo=%23%2Fdashboard'),mailEnv,{});assert.equal(start.status,302);const stateToken=new URL(start.headers.get('location')).searchParams.get('state');
 const callback=await worker.fetch(new Request('https://test.invalid/api/auth/oauth/google/callback?state='+stateToken+'&code=stub',{headers:{Cookie:start.headers.get('set-cookie').split(';')[0]}}),mailEnv,{});
 assert.equal(callback.status,200);assert.match(await callback.text(),/#\/dashboard\?oauth=success/);assert.match(callback.headers.get('set-cookie'),/mc_session=/);assert.equal(sql.prepare('SELECT count(*) n FROM users').get().n,userCount);pass('Google callback links existing verified account without duplicate and restores route');
} finally {globalThis.fetch=transport}

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
// Real rendering and delegated clicks for the new read-only flows.
win.CATEGORY_META=CATEGORY_META;win.STATUS_META=STATUS_META;win.FUNDING_META=FUNDING_META;win.calculateSettlement=calculateSettlement;
win.readFixture={challenge:{...challengeInput,id:'read-test',ownerId:'owner',rewardAmount:3000000,teaserCount:1,participantCount:1,status:'OPEN',fundingStatus:'POSTED',owner:{displayName:'개설자',trustScore:70}},context:{viewerTeaser:{...tBody,id:'t-read',status:'SHORTLISTED',canEdit:false}}};
win.teaserFixture={challengeTitle:challengeInput.title,teaser:{...tBody,id:'t-read',status:'SHORTLISTED',canEdit:false,maskedEvidence:'원문 증빙',qualificationType:'자격 종류',qualificationRef:'자격 참조',createdAt:'2026-09-18'}};
vm.runInContext("state.user={id:'solver',bountyLimit:100000000};state.config={rewardBounds:{min:10000,max:100000000}};apiClient.getChallenge=async()=>readFixture;apiClient.getMyTeaser=async()=>teaserFixture;",context);
await vm.runInContext("openMyTeaser('read-test')",context);
for(const value of [tBody.capability,tBody.approach,'원문 증빙','자격 종류','자격 참조'])assert.ok(win.document.querySelector('.submission-reader').textContent.includes(value));
assert.equal(win.document.querySelectorAll('.submission-reader input,.submission-reader textarea').length,0);assert.equal(win.document.querySelector('[data-action=edit-teaser]'),null);pass('read-only TEASER displays all fields after edit locks');
await vm.runInContext("openChallengeContent('read-test')",context);
for(const value of [challengeInput.description,challengeInput.successCriteria,challengeInput.paymentTrigger,challengeInput.evidenceRequirements])assert.ok(win.document.querySelector('.submission-reader').textContent.includes(value));pass('challenge content displays full description and conditions without edit');
vm.runInContext("teaserFixture.teaser.headline='<img src=x onerror=alert(1)>';teaserFixture.teaser.capability='<script>bad()</script>'",context);
await vm.runInContext("openMyTeaser('read-test')",context);assert.equal(win.document.querySelector('.submission-reader img,.submission-reader script'),null);pass('submission text is escaped in read-only view');
vm.runInContext("state.trustProfile={ownerStats:{},solverStats:{teasers:1},reviewStats:{}};document.querySelector('#main').innerHTML=renderProfile();let tappedSection='';openActivitySection=(section)=>{tappedSection=section};",context);
win.document.querySelector('[data-action=view-applied-challenges] strong').click();await Promise.resolve();assert.equal(vm.runInContext('tappedSection',context),'applied');pass('TEASER number delegates to applied list');
vm.runInContext("readFixture.context.isOwner=true;readFixture.context.canEdit=true;openChallengeEditForm('read-test')",context);const rewardInput=win.document.querySelector('[name=rewardAmount]');assert.equal(rewardInput.max,'100000000');assert.equal(rewardInput.min,'10000');rewardInput.value='3000000';assert.equal(rewardInput.checkValidity(),true);pass('edit form permits 3 million and shows shared min/max');
win.close();console.log(`Passed ${n} behavioral regression checks`);
