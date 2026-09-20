import { testSimulations } from './simulation-regressions.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { webcrypto, hkdfSync, createDecipheriv } from 'node:crypto';
import { legacyNotificationText } from '../public/assets/brand.js';
import worker from '../worker/index.mjs';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { CATEGORY_META, STATUS_META, FUNDING_META } from '../public/assets/data.js';
import { calculateSettlement } from '../public/assets/business-rules.js';
const sql = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if(file.endsWith('.sql')) sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
const DB={prepare(query){return {args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(query).get(...this.args)||null},async all(){return {results:sql.prepare(query).all(...this.args)}},async run(){if(/^\s*SELECT/i.test(query))return {results:sql.prepare(query).all(...this.args),success:true};const r=sql.prepare(query).run(...this.args);return {meta:{changes:Number(r.changes)},success:true}}}},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
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
sql.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(b.body.user.id);
sql.prepare("INSERT INTO admin_roles (user_id,role,appointed_by) VALUES (?, 'primary', ?)").run(b.body.user.id,b.body.user.id);
const adminEnv={...env,PRIMARY_ADMIN_EMAIL:'b@test.invalid'};
assert.equal((await req('/api/admin/members/'+a.body.user.id+'/status',{status:'limited',reason:'반복 요청 검증을 위한 운영 제한 기록입니다.'},os.cookie,'POST',adminEnv)).status,403);
const limitedMember=await req('/api/admin/members/'+a.body.user.id+'/status',{status:'limited',reason:'반복 요청 검증을 위한 운영 제한 기록입니다.'},b.cookie,'POST',adminEnv);
assert.equal(limitedMember.status,200,JSON.stringify(limitedMember.body));assert.equal(sql.prepare('SELECT status FROM users WHERE id=?').get(a.body.user.id).status,'limited');
const activeMember=await req('/api/admin/members/'+a.body.user.id+'/status',{status:'active',reason:'검증 완료로 정상 이용 상태를 복구합니다.'},b.cookie,'POST',adminEnv);
assert.equal(activeMember.status,200,JSON.stringify(activeMember.body));assert.equal(sql.prepare('SELECT status FROM users WHERE id=?').get(a.body.user.id).status,'active');
assert.equal(sql.prepare("SELECT count(*) n FROM audit_logs WHERE action='ADMIN_MEMBER_STATUS_CHANGE' AND resource_id=?").get(a.body.user.id).n,2);
assert.equal((await req('/api/admin/members/'+b.body.user.id+'/status',{status:'suspended',reason:'관리자 계정 보호 동작을 확인하는 요청입니다.'},b.cookie,'POST',adminEnv)).body.error?.code,'ADMIN_ACCOUNT_PROTECTED');
pass('primary-only member status controls preserve admin account and record audit history');
const approvedOnce=await req('/api/admin/challenges/'+highCreate.body.challenge.id+'/moderation/approve',{},b.cookie,'POST',adminEnv);assert.equal(approvedOnce.status,200,JSON.stringify(approvedOnce.body));
const approvedAgain=await req('/api/admin/challenges/'+highCreate.body.challenge.id+'/moderation/approve',{},b.cookie,'POST',adminEnv);assert.equal(approvedAgain.body.idempotent,true);assert.equal(sql.prepare("SELECT count(*) n FROM challenge_events WHERE challenge_id=? AND event_type='CHALLENGE_MODERATION_APPROVED'").get(highCreate.body.challenge.id).n,1);pass('moderation approval is idempotent and records one event');
const archiveCreate=await req('/api/challenges',{...challengeInput,title:'중복 검토 로고 요청',rewardAmount:3000000},b.cookie,'POST',env,{'Idempotency-Key':'reward-archive-create-001'});assert.equal(archiveCreate.body.moderationPending,true);
const archivedOnce=await req('/api/admin/challenges/'+archiveCreate.body.challenge.id+'/moderation/archive',{reason:'중복 등록 항목 비공개 보관'},b.cookie,'POST',adminEnv);assert.equal(archivedOnce.status,200,JSON.stringify(archivedOnce.body));assert.equal(archivedOnce.body.preserved,true);
const archivedAgain=await req('/api/admin/challenges/'+archiveCreate.body.challenge.id+'/moderation/archive',{reason:'중복 등록 항목 비공개 보관'},b.cookie,'POST',adminEnv);assert.equal(archivedAgain.body.idempotent,true);assert.equal(sql.prepare('SELECT status FROM challenges WHERE id=?').get(archiveCreate.body.challenge.id).status,'DRAFT');assert.equal(sql.prepare("SELECT count(*) n FROM challenge_events WHERE challenge_id=? AND event_type='CHALLENGE_MODERATION_ARCHIVED'").get(archiveCreate.body.challenge.id).n,1);assert.equal((await req('/api/challenges/'+archiveCreate.body.challenge.id)).status,404);assert.equal((await req('/api/challenges/'+archiveCreate.body.challenge.id,undefined,b.cookie)).status,200);pass('moderation archive preserves owner access and is idempotent');
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
const mailEnv={...env,BREVO_API_KEY:'test-only-placeholder',BREVO_SENDER_EMAIL:'sender@test.invalid',GOOGLE_OAUTH_CLIENT_ID:'test-id',GOOGLE_OAUTH_CLIENT_SECRET:'test-only-placeholder',NAVER_OAUTH_CLIENT_ID:'naver-test-id',NAVER_OAUTH_CLIENT_SECRET:'test-only-placeholder'};
try {
 globalThis.fetch=async(url,options)=>{if(String(url)==='https://api.brevo.com/v3/smtp/email'){sentMail=JSON.parse(options.body);return Response.json({messageId:'test'})}throw Error('Unexpected external transport')};
 const registered=await req('/api/auth/signup',{...common,displayName:'인증테스트회원',phone:'01000001991',email:'verify@test.invalid'},'', 'POST',mailEnv);assert.equal(registered.body.pendingVerification,true);assert.equal(registered.cookie,'');
 const pendingLogin=await req('/api/auth/login',{email:'verify@test.invalid',passwordVerifier:material.passwordVerifier},'', 'POST',mailEnv);assert.equal(pendingLogin.status,403);
 assert.equal(sentMail.sender.name,'모두의클리어');assert.ok(sentMail.subject.startsWith('[모두의클리어]'));
 const verifyToken=sentMail.htmlContent.match(/token=([A-Za-z0-9_-]+)/)[1];assert.equal((await req('/api/auth/verify-email',{token:verifyToken},'', 'POST',mailEnv)).status,200);
 const verifiedLogin=await req('/api/auth/login',{email:'verify@test.invalid',passwordVerifier:material.passwordVerifier},'', 'POST',mailEnv);assert.equal(verifiedLogin.status,200);pass('signup → email verification → login with mocked mail delivery');
 assert.equal((await req('/api/auth/verify-email',{token:verifyToken},'', 'POST',mailEnv)).status,400);pass('verification link cannot be reused');
 await req('/api/auth/request-password-reset',{email:'verify@test.invalid'},'','POST',mailEnv);
 assert.ok(sentMail.subject.startsWith('[모두의클리어]'));
 const resetToken=sentMail.htmlContent.match(/token=([A-Za-z0-9_-]+)/)[1];const newMaterial={passwordSalt:Buffer.alloc(16,3).toString('base64'),passwordVerifier:Buffer.alloc(32,4).toString('base64')};
 assert.equal((await req('/api/auth/reset-password',{token:resetToken,...newMaterial},'','POST',mailEnv)).status,200);
 assert.equal((await req('/api/auth/login',{email:'verify@test.invalid',passwordVerifier:material.passwordVerifier},'','POST',mailEnv)).status,401);pass('password reset invalidates old password');
 const userCount=sql.prepare('SELECT count(*) n FROM users').get().n;
 globalThis.fetch=async(url)=> String(url).includes('/token')?Response.json({access_token:'stub-access'}):Response.json({sub:'verified-google-link',email:'verify@test.invalid',email_verified:true,name:'인증테스트회원'});
 const start=await worker.fetch(new Request('https://test.invalid/api/auth/oauth/google?returnTo=%23%2Fdashboard'),mailEnv,{});assert.equal(start.status,302);const stateToken=new URL(start.headers.get('location')).searchParams.get('state');
 const callback=await worker.fetch(new Request('https://test.invalid/api/auth/oauth/google/callback?state='+stateToken+'&code=stub',{headers:{Cookie:start.headers.get('set-cookie').split(';')[0]}}),mailEnv,{});
 assert.equal(callback.status,200);assert.match(await callback.text(),/#\/dashboard\?oauth=success/);assert.match(callback.headers.get('set-cookie'),/mc_session=/);assert.equal(sql.prepare('SELECT count(*) n FROM users').get().n,userCount);pass('Google callback links existing verified account without duplicate and restores route');

 // Exercise both providers through their real start/callback/signup/session handlers.
 async function oauthRoundTrip(provider, {cookieOverride, error, returnTo='#/dashboard'}={}) {
   const start = await worker.fetch(new Request('https://test.invalid/api/auth/oauth/'+provider+'?returnTo='+encodeURIComponent(returnTo)),mailEnv,{});
   const target = new URL(start.headers.get('location'));
   assert.equal(target.searchParams.get('redirect_uri'),'https://test.invalid/api/auth/oauth/'+provider+'/callback');
   const callbackUrl = 'https://test.invalid/api/auth/oauth/'+provider+'/callback?state='+target.searchParams.get('state')+(error?'&error='+error:'&code=stub');
   const cookie = cookieOverride ?? start.headers.get('set-cookie').split(';')[0];
   const response = await worker.fetch(new Request(callbackUrl,{headers:{Cookie:cookie}}),mailEnv,{});
   return {response, body:await response.text(), cookie:response.headers.get('set-cookie')?.split(';')[0]||'', callbackUrl, stateCookie:cookie};
 }
 let profileProvider='google';
 globalThis.fetch=async(url,options)=> {
   if(String(url)==='https://api.brevo.com/v3/smtp/email'){sentMail=JSON.parse(options.body);return Response.json({messageId:'test'})}
   if(['https://oauth2.googleapis.com/token','https://nid.naver.com/oauth2.0/token'].includes(String(url)))return Response.json({access_token:'stub-access'});
   if(profileProvider==='google'&&String(url)==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'new-google-subject',email:'new-google@test.invalid',email_verified:true,name:'구글신규'});
   if(profileProvider==='naver'&&String(url)==='https://openapi.naver.com/v1/nid/me')return Response.json({resultcode:'00',response:{id:'new-naver-subject',email:'new-naver@test.invalid',name:'네이버신규'}});
   throw Error('Unexpected provider transport');
 };
 for(const provider of ['google','naver']) {
   profileProvider=provider;
   const fresh=await oauthRoundTrip(provider,{returnTo:'#/verify-email?token=discard'});
   assert.match(fresh.body,/#\/social-signup/);assert.match(fresh.cookie,/^mc_oauth_signup=/);
   const pending=await req('/api/auth/oauth-signup',undefined,fresh.cookie,'GET',mailEnv);assert.equal(pending.body.provider,provider);
   const signup=await req('/api/auth/oauth-signup',{...common,displayName:provider+'신규회원',phone:provider==='google'?'01000001992':'01000001993'},fresh.cookie,'POST',mailEnv);
   if(provider==='naver') {
     assert.equal(signup.body.pendingVerification,true);assert.equal(signup.body.loginProvider,'naver');assert.equal(signup.cookie,'');
     const blocked=await oauthRoundTrip(provider);assert.match(decodeURIComponent(blocked.body),/가입 이메일 인증/);assert.ok(!blocked.cookie.startsWith('mc_session='));
     const token=sentMail.htmlContent.match(/token=([A-Za-z0-9_-]+)/)[1];
     const verification=await req('/api/auth/verify-email',{token},'','POST',mailEnv);assert.equal(verification.body.loginProvider,'naver');
     pass('NAVER new registration requires email verification and reports its login method');
   } else {
     assert.equal(signup.status,201);assert.equal((await req('/api/me',undefined,signup.cookie,'GET',mailEnv)).body.user.email,'new-google@test.invalid');
     pass('Google first callback → password-free signup → authenticated session');
   }
   const count=sql.prepare('SELECT count(*) n FROM users').get().n;
   const loggedIn=await oauthRoundTrip(provider,{returnTo:'#/verify-email?token=discard'});
   assert.match(loggedIn.body,/#\/home\?oauth=success/);assert.match(loggedIn.cookie,/^mc_session=/);
   assert.equal((await req('/api/me',undefined,loggedIn.cookie,'GET',mailEnv)).body.user.email,'new-'+provider+'@test.invalid');
   assert.equal(sql.prepare('SELECT count(*) n FROM users').get().n,count);
   pass(provider+' returning login retains account, session and safe destination');
   const replay=await worker.fetch(new Request(loggedIn.callbackUrl,{headers:{Cookie:loggedIn.stateCookie}}),mailEnv,{});assert.ok(!replay.headers.get('set-cookie')?.startsWith('mc_session='));
   const csrf=await oauthRoundTrip(provider,{cookieOverride:'mc_oauth_state=wrong'});assert.ok(!csrf.cookie.startsWith('mc_session='));
   pass(provider+' rejects replay and mismatched OAuth state');
   const denied=await oauthRoundTrip(provider,{error:'access_denied'});assert.match(decodeURIComponent(denied.body),/승인되지 않았습니다/);assert.ok(!denied.cookie.startsWith('mc_session='));
   pass(provider+' declined consent has an actionable error and no session');
 }
} finally {globalThis.fetch=transport}

// Push round trip with independent RFC 8291 receiver: no real devices/messages.
const vapid=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const vapidPrivate=await webcrypto.subtle.exportKey('jwk',vapid.privateKey);
const receiver=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const receiverPublic=Buffer.from(await webcrypto.subtle.exportKey('raw',receiver.publicKey));
const authSecret=Buffer.alloc(16,7);
const pushEnv={...env,VAPID_PUBLIC_KEY:Buffer.from(await webcrypto.subtle.exportKey('raw',vapid.publicKey)).toString('base64url'),VAPID_PRIVATE_KEY:vapidPrivate.d};
const endpoint='https://push.example.invalid/subscription-a';
let pushPayload=null;
try {
 globalThis.fetch=async(url,options)=>{assert.equal(String(url),endpoint);const encoded=Buffer.from(options.body);const salt=encoded.subarray(0,16);assert.equal(encoded.readUInt32BE(16),4096);assert.equal(encoded[20],65);const serverPublic=encoded.subarray(21,86);
  const secret=await webcrypto.subtle.deriveBits({name:'ECDH',public:await webcrypto.subtle.importKey('raw',serverPublic,{name:'ECDH',namedCurve:'P-256'},false,[])},receiver.privateKey,256);
  const ikm=hkdfSync('sha256',Buffer.from(secret),authSecret,Buffer.concat([Buffer.from('WebPush: info\0'),receiverPublic,serverPublic]),32);
  const key=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16);const nonce=hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12);
  const ciphertext=encoded.subarray(86);const decipher=createDecipheriv('aes-128-gcm',key,Buffer.from(nonce));decipher.setAuthTag(ciphertext.subarray(-16));const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);assert.equal(plain[plain.length-1],2);pushPayload=JSON.parse(plain.subarray(0,-1).toString());return new Response(null,{status:201});
 };
 const subscription={endpoint,keys:{p256dh:receiverPublic.toString('base64url'),auth:authSecret.toString('base64url')}};
 assert.equal((await req('/api/me/push-subscriptions',subscription,b.cookie,'POST',pushEnv)).body.delivered,true);
 assert.match(pushPayload.body,/미션/);pass('push payload decrypts with independent RFC 8291 receiver');
 await req('/api/me/push-subscriptions/remove',{endpoint},b.cookie,'POST',pushEnv);
 assert.equal((await req('/api/me/push-settings',undefined,b.cookie,'GET',pushEnv)).body.subscribed,false);
 assert.equal((await req('/api/me/push-subscriptions',subscription,b.cookie,'POST',pushEnv)).body.subscribed,true);pass('push unsubscribe and re-enable maintain account registration');
} finally {globalThis.fetch=transport}
const beforeData=sql.prepare('SELECT count(*) n FROM users').get().n;
assert.equal((await req('/api/config')).body.serviceName,'모두의클리어');assert.equal((await req('/api/config')).body.internalCode,'MODU_CHALLENGE');assert.equal((await req('/api/config')).body.moderationRewardThreshold,500000);assert.equal(sql.prepare('SELECT count(*) n FROM users').get().n,beforeData);pass('new public brand retains internal identifier, moderation threshold and accounts');
assert.equal(legacyNotificationText('모두의 챌린지에서 챌린지를 확인하세요'),'모두의클리어에서 미션을 확인하세요');pass('legacy system notification display migrates without changing stored content');

const storedNotice='모두의 챌린지에서 챌린지를 확인하세요';
sql.prepare("INSERT INTO notifications (id,user_id,type,title,body,resource_type) VALUES (?,?,?,?,?,?)").run('legacy-brand-test',b.body.user.id,'INFO',storedNotice,storedNotice,'system');
const activityWithLegacy=await req('/api/me/activity',undefined,b.cookie);
assert.equal(activityWithLegacy.body.notifications.find(x=>x.id==='legacy-brand-test').title,'모두의클리어에서 미션을 확인하세요');
assert.equal(sql.prepare("SELECT title FROM notifications WHERE id='legacy-brand-test'").get().title,storedNotice);pass('stored legacy notifications stay intact while authenticated API returns new display copy');
assert.ok(activityWithLegacy.body.ownedChallenges.some(x=>x.id===cid));pass('existing mission ownership and activity listing survive rebrand');

// Full lifecycle in isolated SQLite only: no production records, provider calls or money.
const lifecycleEnv={...env,APP_ENV:'test',PAYOUT_WEBHOOK_SECRET:'local-fixture-only'};
const life=(await req('/api/challenges',challengeInput,b.cookie,'POST',env,{'Idempotency-Key':'lifecycle-v41-fixture-001'})).body.challenge.id;
const solver2=(await req('/api/auth/login',{email:'a@test.invalid',passwordVerifier:material.passwordVerifier})).cookie;
const lifeOne=(await req('/api/challenges/'+life+'/teasers',tBody,os.cookie)).body.teaser.id;
const lifeTwo=(await req('/api/challenges/'+life+'/teasers',tBody,solver2)).body.teaser.id;
for(const teaserId of [lifeOne,lifeTwo]) assert.equal((await req('/api/challenges/'+life+'/shortlist',{teaserId},b.cookie)).status,200);
let lc=(await req('/api/challenges/'+life,undefined,b.cookie)).body.challenge;
assert.equal(lc.participantCount,2);assert.equal(lc.teaserCount,2);assert.equal(lc.shortlistedCount,1);assert.equal(lc.status,'SHORTLISTED');
assert.equal((await req('/api/challenges/'+life+'/my-teaser',undefined,os.cookie)).body.teaser.status,'VIEWED');
assert.equal((await req('/api/challenges/'+life+'/my-teaser',undefined,solver2)).body.teaser.status,'SHORTLISTED');
assert.equal(sql.prepare("SELECT count(*) n FROM teasers WHERE challenge_id=? AND status='SHORTLISTED'").get(life).n,1);
pass('selecting another candidate preserves both submissions but keeps exactly one current candidate');
sql.prepare("UPDATE teasers SET status='SHORTLISTED', updated_at=CURRENT_TIMESTAMP WHERE id IN (?,?)").run(lifeOne,lifeTwo);
sql.prepare('UPDATE challenges SET shortlisted_count=2 WHERE id=?').run(life);
sql.exec(readFileSync(new URL('../migrations/0016_enforce_single_active_candidate.sql',import.meta.url),'utf8'));
assert.equal(sql.prepare("SELECT count(*) n FROM teasers WHERE challenge_id=?").get(life).n,2);
assert.equal(sql.prepare("SELECT count(*) n FROM teasers WHERE challenge_id=? AND status='SHORTLISTED'").get(life).n,1);
assert.equal(sql.prepare('SELECT shortlisted_count FROM challenges WHERE id=?').get(life).shortlisted_count,1);
assert.equal(sql.prepare("SELECT count(*) n FROM challenge_events WHERE challenge_id=? AND event_type='SINGLE_CANDIDATE_MIGRATION'").get(life).n,1);
pass('single-candidate migration preserves both submissions, one candidate and an audit event');
assert.equal((await req('/api/challenges/'+life+'/shortlist',{teaserId:lifeOne,mode:'select'},os.cookie,'POST',lifecycleEnv)).status,403);
assert.equal((await req('/api/challenges/'+life+'/shortlist',{teaserId:lifeOne,mode:'select'},b.cookie)).body.error.code,'MONEY_FLOW_DISABLED');
assert.equal((await req('/api/challenges/'+life+'/shortlist',{teaserId:lifeOne,mode:'select'},b.cookie,'POST',lifecycleEnv)).body.status,'FUNDING_REQUIRED');
assert.equal(sql.prepare("SELECT count(*) n FROM teasers WHERE challenge_id=? AND status='SELECTED'").get(life).n,1);
pass('only owner selects one finalist; production money guard is preserved');
const evidence={description:'요구한 로고 원본과 색상 설명을 모두 완성하여 검수용 결과를 제출합니다.',evidenceUrl:'https://example.invalid/proof'};
assert.equal((await req('/api/challenges/'+life+'/proof',evidence,os.cookie,'POST',lifecycleEnv)).status,409);
assert.equal((await req('/api/challenges/'+life+'/funding/confirm',{},solver2,'POST',lifecycleEnv)).status,403);
assert.equal((await req('/api/challenges/'+life+'/funding/confirm',{},b.cookie,'POST',lifecycleEnv)).body.status,'EXECUTING');
assert.equal((await req('/api/challenges/'+life+'/proof',evidence,solver2,'POST',lifecycleEnv)).status,403);
pass('funding must precede execution; only selected solver can submit proof');
const openedDispute=await req('/api/challenges/'+life+'/disputes',{reasonCode:'EVIDENCE',description:'제출 증빙 범위를 확인하기 위한 분쟁 검증 요청입니다.'},b.cookie,'POST',lifecycleEnv);
assert.equal(openedDispute.status,201,JSON.stringify(openedDispute.body));const disputeId=openedDispute.body.dispute.id;
const duplicateDispute=await req('/api/challenges/'+life+'/disputes',{reasonCode:'EVIDENCE',description:'동일 미션에 대한 반복 분쟁 요청이 생성되지 않아야 합니다.'},b.cookie,'POST',lifecycleEnv);
assert.equal(duplicateDispute.body.dispute.id,disputeId);assert.equal(duplicateDispute.body.idempotent,true);assert.equal(sql.prepare("SELECT count(*) n FROM disputes WHERE challenge_id=? AND status NOT IN ('DECIDED','CLOSED')").get(life).n,1);
assert.equal((await req('/api/admin/disputes/'+disputeId,undefined,os.cookie,'GET',adminEnv)).status,403);
assert.equal((await req('/api/admin/disputes/'+disputeId+'/status',{status:'EVIDENCE',resolution:'제출된 자료와 성공 조건을 추가 확인하고 있습니다.'},b.cookie,'POST',adminEnv)).status,200);
const resolvedDispute=await req('/api/admin/disputes/'+disputeId+'/status',{status:'CLOSED',outcome:'RESTORE',resolution:'검토 결과 기존 수행 단계로 복구하기로 결정했습니다.'},b.cookie,'POST',adminEnv);
assert.equal(resolvedDispute.body.moneyTransferred,false);assert.equal(sql.prepare('SELECT status FROM challenges WHERE id=?').get(life).status,'EXECUTING');assert.equal(sql.prepare('SELECT status FROM settlements WHERE challenge_id=?').get(life).status,'FUNDED');
assert.equal(sql.prepare("SELECT count(*) n FROM audit_logs WHERE action='ADMIN_DISPUTE_STATUS_CHANGE' AND resource_id=?").get(disputeId).n,2);
pass('duplicate dispute prevention and primary resolution restore workflow keep money transfer disabled');
const payoutBody={challengeId:life,provider:'test-only',payoutReference:'fixture-payment-v41',status:'PAID'};
assert.equal((await req('/api/internal/payout/confirm',payoutBody,'','POST',lifecycleEnv,{'X-Payout-Webhook-Secret':'local-fixture-only'})).status,409);
assert.equal((await req('/api/challenges/'+life+'/proof',evidence,os.cookie,'POST',lifecycleEnv)).status,201);
assert.equal((await req('/api/challenges/'+life+'/success',{},os.cookie,'POST',lifecycleEnv)).status,403);
const completed=await req('/api/challenges/'+life+'/success',{},b.cookie,'POST',lifecycleEnv);
assert.equal(completed.body.status,'SUCCESS');assert.equal(completed.body.settlement.status,'PROCESSING');
assert.equal((await req('/api/challenges/'+life+'/success',{},b.cookie,'POST',lifecycleEnv)).status,409);
pass('owner review completes mission once; completion is distinct from payout');
assert.equal((await req('/api/internal/payout/confirm',payoutBody,'','POST',lifecycleEnv)).status,403);
for(let i=0;i<2;i++)assert.equal((await req('/api/internal/payout/confirm',payoutBody,'','POST',lifecycleEnv,{'X-Payout-Webhook-Secret':'local-fixture-only'})).body.status,'PAID');
assert.equal(sql.prepare("SELECT count(*) n FROM notifications WHERE resource_id=? AND type='PAYOUT_PAID'").get(life).n,1);
pass('verified simulated payout is idempotent and cannot precede review');

const approvedSimulation=await testSimulations({req,sql,ownerCookie:b.cookie,otherCookie:os.cookie,sourceId:cid,pass});

// DOM regression: run real delegated handlers against real DOM (no browser globals/auth).
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://test.invalid/',runScripts:'outside-only',pretendToBeVisual:true});const win=dom.window;win.scrollTo=()=>{};win.HTMLElement.prototype.scrollIntoView=()=>{};win.matchMedia=()=>({matches:false});
win.legacyNotificationText=legacyNotificationText;
const context=dom.getInternalVMContext();let app=readFileSync(new URL('../public/assets/live-app.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('init().catch((error) => fatal(error));','');
vm.runInContext("class ApiError extends Error {constructor(message, opts={}){super(message); Object.assign(this,opts)}}; const apiClient={};",context);vm.runInContext(app,context);
// Reproduce the screenshot: a successful login from the verification page must leave it.
win.CATEGORY_META=CATEGORY_META;win.STATUS_META=STATUS_META;win.FUNDING_META=FUNDING_META;
win.createPasswordMaterial=async()=>material;
vm.runInContext("const savedLoadRouteData=loadRouteData;loadRouteData=async()=>{};state.loading=false;apiClient.loginOptions=async()=>({});apiClient.login=async()=>({user:{id:'test',displayName:'로그인테스터',accountType:'individual',trustScore:50}});",context);
for(const route of ['verify-email','login','signup','social-signup']) {
 vm.runInContext(`state.user=null;state.route='${route}';history.replaceState(null,'','#/${route}?token=used-test-token');openAuthModal('login');`,context);
 await vm.runInContext("submitLogin(document.querySelector('#login-form'))",context);
 assert.equal(win.location.hash,'#/home');assert.equal(vm.runInContext('state.route',context),'home');
 assert.equal(win.document.querySelector('#modal-root').innerHTML,'');assert.ok(!win.document.querySelector('#main').textContent.includes('이메일 인증 완료'));
 assert.ok(win.document.body.textContent.includes('로그인테스터'));pass('login from '+route+' renders home and signed-in header');
}
vm.runInContext("state.route='dashboard';history.replaceState(null,'','#/dashboard');",context);
await vm.runInContext("completeAuthentication(state.user)",context);assert.equal(win.location.hash,'#/dashboard');pass('login preserves a normal requested activity route');
vm.runInContext("state.user=null;state.route='verify-email';history.replaceState(null,'','#/verify-email?token=test-token');apiClient.verifyEmail=async()=>({ok:true,loginProvider:'naver'});",context);
await vm.runInContext("verifyEmailFromLink();",context);vm.runInContext("main.innerHTML=renderEmailVerification()",context);
assert.equal(win.document.querySelector('#main [data-provider=naver]').textContent,'NAVER로 계속하기');assert.equal(win.document.querySelector('#main [data-action=login]'),null);pass('NAVER email completion directs to NAVER without a password');
vm.runInContext("history.replaceState(null,'','#/home?oauth=success');renderSystemNotice();",context);assert.equal(win.document.querySelector('#system-notice').hidden,false);assert.match(win.document.querySelector('#system-notice-title').textContent,/확인 필요/);pass('missing OAuth session shows recovery guidance instead of silent success');
vm.runInContext("loadRouteData=savedLoadRouteData;state.route='home';state.loading=true;history.replaceState(null,'','#/home');",context);
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
// Brand identity, metadata and installed-app identity agree.
const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
assert.equal(manifest.name,'모두의클리어');assert.equal(manifest.short_name,'모두의클리어');assert.equal(manifest.id,'/');assert.equal(manifest.start_url,'/?source=pwa');
assert.equal(win.document.querySelector('meta[property="og:site_name"]').content,'모두의클리어');assert.ok(win.document.title.startsWith('모두의클리어 |'));
assert.equal(JSON.parse(win.document.querySelector('script[type="application/ld+json"]').textContent).name,'모두의클리어');pass('PWA, SEO and share brand match while installation identity stays unchanged');
vm.runInContext("state.user=null;state.route='home';state.config={};state.challenges=[];main.innerHTML=renderHome()",context);
assert.equal(win.document.querySelector('.hero h1').textContent,'미션을 올리고, 해결하고, 보상받다.');
for(const label of ['미션 등록','미션 찾기'])assert.ok(win.document.querySelector('.hero-actions').textContent.includes(label));
assert.ok(!/모두의\s*챌린지|모챌|MODU CHALLENGE|MODU ?CLEAR/i.test(win.document.querySelector('main').textContent));assert.ok(win.document.querySelector('.footer-company').textContent.includes('모두의클리어 운영팀'));pass('home exact tagline, mission CTAs and fixed operations footer wording');
vm.runInContext("openAuthModal('signup')",context);assert.ok(win.document.querySelector('#modal-root').textContent.includes('모두의클리어 회원가입'));pass('signup brand is visible');
// Device permission state must not be inferred from another device's account subscription.
let registrations=0, removals=0, prompts=0, currentSubscription=null;
const sub={endpoint:'https://push.example.invalid/browser',toJSON(){return {endpoint:this.endpoint}},async unsubscribe(){currentSubscription=null;return true}};
Object.defineProperty(win.navigator,'serviceWorker',{configurable:true,value:{ready:Promise.resolve({pushManager:{async getSubscription(){return currentSubscription},async subscribe(){currentSubscription=sub;return sub}}})}});
win.PushManager=function(){};win.Notification={permission:'denied',async requestPermission(){prompts++;return 'granted'}};
win.recordRegistration=()=>{registrations++;return {delivered:true}};win.recordRemoval=()=>{removals++;return {ok:true}};
vm.runInContext("apiClient.pushSettings=async()=>({configured:true,subscribed:true,publicKey:'AQ'});apiClient.savePushSubscription=async()=>recordRegistration();apiClient.removePushSubscription=async()=>recordRemoval();",context);
await vm.runInContext('enablePushNotifications()',context);assert.equal(registrations,0);assert.equal(prompts,0);pass('denied notification permission never registers or prompts repeatedly');
win.Notification.permission='granted';await vm.runInContext('enablePushNotifications()',context);assert.equal(registrations,1);pass('reallowed permission registers current device even when another device is subscribed');
await vm.runInContext('disablePushNotifications()',context);assert.equal(removals,1);assert.equal(currentSubscription,null);
await vm.runInContext('disablePushNotifications()',context);assert.equal(removals,1);pass('device unsubscribe never deletes other devices when current subscription is absent');
win.Notification.permission='default';await vm.runInContext('enablePushNotifications()',context);assert.equal(prompts,1);assert.equal(registrations,2);pass('default permission prompts once then registers');
// Presentation and role-specific next actions for each workflow stage.
vm.runInContext("state.user={id:'owner'};state.config={environment:'production',moneyEnabled:false};readFixture.challenge.status='SHORTLISTED';main.innerHTML=renderActivityChallenge(readFixture.challenge)+renderApplicationItem({challenge:readFixture.challenge,teaserStatus:'SHORTLISTED',teaserHeadline:'긴 제안 내용 '.repeat(20),teaserCreatedAt:'2026-09-18'});",context);
assert.equal(win.document.querySelector('#main .activity-badges').children.length,3);
assert.equal(win.document.querySelector('#main .candidate-confirmed').textContent,'✓ 후보선정 완료');
assert.equal(win.document.querySelector('#main .application-summary').tagName,'DIV');
assert.equal(win.document.querySelector('#main .application-summary [data-action]'),null);
assert.deepEqual([...win.document.querySelectorAll('#main .application-links [data-action]')].map(node=>node.dataset.action),['view-my-teaser','view-challenge-content','view-progress']);
assert.ok(win.document.querySelector('#main .application-links').textContent.includes('진행상황'));pass('activity cards keep status non-clickable and expose three distinct actions');
vm.runInContext("main.innerHTML=renderProgressNotice(readFixture.challenge,{isOwner:true})+renderCandidateCard('read-test',{...teaserFixture.teaser,status:'SHORTLISTED'});",context);
assert.match(win.document.querySelector('#main .workflow-notice').textContent,/결제·지급 연동.*준비 중/);
assert.equal(win.document.querySelector('#main [data-action=select-finalist]').disabled,true);
assert.equal(win.document.querySelector('#main [data-action=shortlist]').disabled,true);assert.match(win.document.querySelector('#main [data-action=shortlist]').textContent,/현재 수행자 후보/);pass('blocked finalist explains why; one current candidate is prominent');
for(const [status,role,action] of [['SHORTLISTED','isOwner','review-candidates'],['FUNDING_REQUIRED','isOwner','fund-challenge'],['EXECUTING','isSelectedSolver','submit-proof'],['PROOF_SUBMITTED','isOwner','confirm-success'],['SUCCESS','isOwner','view-settlement']]) {
 win.stage=status;win.role=role;
 vm.runInContext("state.config={environment:'test',moneyEnabled:false};main.innerHTML=renderProgressNotice({...readFixture.challenge,status:stage},{[role]:true});",context);
 assert.ok(win.document.querySelector('#main [data-action='+action+']'),status);
 vm.runInContext("main.innerHTML=renderProgressNotice({...readFixture.challenge,status:stage},{viewerTeaser:{status:'SUBMITTED'}})",context);
 assert.equal(win.document.querySelector('#main [data-action]'),null,status);
}
pass('next actions follow owner, selected solver and ordinary viewer permissions');
vm.runInContext("main.innerHTML=renderFlow({...readFixture.challenge,status:'SUCCESS',fundingStatus:'FUNDED'})+renderProgressNotice({...readFixture.challenge,status:'SUCCESS',fundingStatus:'FUNDED'},{isOwner:true});",context);
assert.equal(win.document.querySelectorAll('#main .flow-step').length,7);assert.equal(win.document.querySelector('#main [aria-current=step] strong').textContent,'보상 지급 · 현재');
assert.match(win.document.querySelector('#main .workflow-notice').textContent,/보상 지급 대기/);
vm.runInContext("main.innerHTML=renderFlow({...readFixture.challenge,status:'SUCCESS',fundingStatus:'PAID'})",context);
assert.equal(win.document.querySelectorAll('#main .flow-step.done').length,7);
vm.runInContext("main.innerHTML=renderFlow({...readFixture.challenge,status:'CANCELLED'})",context);
assert.equal(win.document.querySelectorAll('#main .flow-step.done,.flow-step.active').length,0);pass('timeline distinguishes completed payout, payout pending and stopped missions');

// Virtual checkout is usable without enabling any real payment flow.
win.approvedSimulation=approvedSimulation;
vm.runInContext("state.user={id:'sandbox-owner'};state.loading=false;state.route='simulation';state.routeError=null;state.simulations=[approvedSimulation];state.simulation={...approvedSimulation,stage:'FUNDING_REQUIRED',paymentStatus:'NONE'};state.simulationRole='owner';main.innerHTML=renderSimulation();",context);
assert.match(win.document.querySelector('#main').textContent,/실제 청구 및 송금 0원/);
assert.match(win.document.querySelector('#main .simulation-checkout').textContent,/90,000원/);
assert.ok(win.document.querySelector('#main [data-step=PAY_APPROVE]'));assert.ok(win.document.querySelector('#main [data-step=PAY_FAIL]'));assert.ok(win.document.querySelector('#main [data-step=PAY_CANCEL]'));
win.document.querySelector('#main [data-role=solver]').click();await Promise.resolve();
assert.equal(win.document.querySelector('#main [data-step=PAY_APPROVE]'),null);
assert.match(win.document.querySelector('#main .workflow-notice').textContent,/의뢰자 역할로 전환/);
pass('virtual checkout displays 10% fee, zero real charge and role-specific controls');
vm.runInContext("state.simulation={...approvedSimulation,stage:'EXECUTING'};state.simulationRole='solver';main.innerHTML=renderSimulation()",context);
assert.ok(win.document.querySelector('#main #simulation-proof-form'));
assert.equal(win.document.querySelector('#main [data-step=REFUND]'),null);
vm.runInContext("state.simulationRole='owner';main.innerHTML=renderSimulation()",context);
assert.ok(win.document.querySelector('#main [data-step=REFUND]'));assert.equal(win.document.querySelector('#main #simulation-proof-form'),null);
vm.runInContext("state.simulation={...approvedSimulation,stage:'SUCCESS',payoutStatus:'PAID',title:'<img src=x onerror=alert(1)>'};main.innerHTML=renderSimulation()",context);
assert.equal(win.document.querySelector('#main img'),null);assert.equal(win.document.querySelector('#main [data-step=PAYOUT_SUCCESS]'),null);
pass('virtual proof, refund and paid screens enforce roles and escape user content');

win.close();console.log(`Passed ${n} behavioral regression checks`);
