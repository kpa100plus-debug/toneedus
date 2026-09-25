import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../worker/index.mjs';
import {emailOtpSetup} from '../worker/email-otp.mjs';
const sql=new DatabaseSync(':memory:');
for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())if(file.endsWith('.sql'))sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
const DB={prepare(query){return{args:[],bind(...args){this.args=args;return this},async first(){return sql.prepare(query).get(...this.args)||null},async all(){return{results:sql.prepare(query).all(...this.args)}},async run(){if(/\bRETURNING\b/i.test(query)){const results=sql.prepare(query).all(...this.args);return{results,meta:{changes:sql.prepare('SELECT changes() n').get().n}}}if(/^\s*SELECT/i.test(query))return this.all();return{meta:{changes:Number(sql.prepare(query).run(...this.args).changes)}}}}},async batch(stmts){sql.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const env={DB,APP_ENV:'production',PUBLIC_MONEY_ENABLED:'false',BREVO_API_KEY:'mock-only-secret-key-with-more-than-32-characters',BREVO_SENDER_EMAIL:'sender@test.invalid'};
async function req(path,body,user,options={}){const r=await worker.fetch(new Request('https://test.invalid'+path,{method:options.method||(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',Cookie:user?.cookie||'','CF-Connecting-IP':options.ip||'192.0.2.1','Idempotency-Key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)}),options.env||env,{});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''}}
let n=0;const pass=x=>{n++;console.log('PASS email OTP: '+x)};
const material={passwordSalt:Buffer.alloc(16,1).toString('base64'),passwordVerifier:Buffer.alloc(32,2).toString('base64')};
async function member(number){const r=await req('/api/auth/signup',{...material,email:`member${number}@test.invalid`,displayName:'테스트회원'+number,phone:'0101234000'+number,realName:'테스트',region:'서울',birthYear:1980,gender:'female',termsAccepted:true,privacyAccepted:true});assert.equal(r.status,201,JSON.stringify(r.body));return{cookie:r.cookie,id:r.body.user.id,email:r.body.user.email}}
const a=await member(1),b=await member(2),c=await member(3);
let mail,failDelivery=false,calls=0;
const realFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.brevo.com/v3/smtp/email');calls++;mail=JSON.parse(options.body);return new Response('{}',{status:failDelivery?503:201})};
const code=()=>mail.textContent.match(/인증번호: (\d{6})/)[1];
const relax=()=>sql.exec('DELETE FROM email_otp_limits; UPDATE email_otp_send_locks SET sent_at=0');
async function send(user,data={}){const r=await req('/api/me/email-verification/send',data,user);assert.equal(r.status,200,JSON.stringify(r.body));return{id:r.body.challenge.id,code:code()}}
async function confirm(user,challenge){return req('/api/me/email-verification/confirm',challenge,user)}
try{
 assert.equal((await req('/api/me/email-verification/send',{})).status,401);
 assert.equal((await req('/api/me/email-verification/send',{},a,{env:{...env,BREVO_API_KEY:''}})).status,503);assert.equal(calls,0);
 assert.equal((await req('/api/me',undefined,a)).body.user.emailVerified,false);
 pass('no anonymous send, missing provider fails honestly, signup never claims email verification');
 let one=await send(a);assert.equal(mail.to[0].email,a.email);assert.match(one.code,/^\d{6}$/);
 assert.equal(JSON.stringify(sql.prepare('SELECT * FROM email_otp_challenges').all()).includes(one.code),false);
 assert.equal((await req('/api/me/email-verification/send',{},a)).body.error.code,'EMAIL_RESEND_WAIT');
 assert.equal((await confirm(b,one)).body.error.code,'EMAIL_CODE_UNAVAILABLE');
 const login=await req('/api/auth/login',{email:a.email,passwordVerifier:material.passwordVerifier});assert.equal(login.status,200);
 assert.equal((await confirm({cookie:login.cookie},one)).body.error.code,'EMAIL_CODE_UNAVAILABLE');
 pass('secure six-digit challenge, cooldown, account and session binding');
 for(let i=0;i<5;i++){const wrong=await confirm(a,{id:one.id,code:one.code==='000000'?'000001':'000000'});assert.equal(wrong.body.error.code,i===4?'EMAIL_CODE_LOCKED':'EMAIL_CODE_INVALID')}
 assert.equal((await confirm(a,one)).body.error.code,'EMAIL_CODE_LOCKED');relax();
 const two=await send(a);assert.equal((await confirm(a,one)).body.error.code,'EMAIL_CODE_UNAVAILABLE');
 sql.prepare('UPDATE email_otp_challenges SET expires_at=0 WHERE id=?').run(two.id);assert.equal((await confirm(a,two)).body.error.code,'EMAIL_CODE_EXPIRED');
 pass('five wrong attempts lock even a correct code; resend invalidates old code; expiry enforced');
 relax();one=await send(a);assert.equal((await confirm(a,one)).body.verified,true);assert.equal((await confirm(a,one)).body.error.code,'EMAIL_CODE_UNAVAILABLE');
 let me=(await req('/api/me',undefined,a)).body.user;assert.equal(me.emailVerified,true);assert.equal(me.verification.identity,false);
 const relogin=await req('/api/auth/login',{email:a.email,passwordVerifier:material.passwordVerifier});assert.equal(relogin.body.user.emailVerified,true);
 pass('successful verification persists across reload/login, single use, never claims identity');
 const mission={title:'이메일 인증 미션 검증',summary:'동네 가게 로고 디자인을 요청합니다.',description:'원본 디자인 파일과 색상 조합에 대한 설명을 제작해 주세요.',category:'IDEA',rewardAmount:50000,successCriteria:'디자인 원본 파일과 색상 설명 전달',paymentTrigger:'거래 확정 후 보상금 준비',evidenceRequirements:'디자인 원본 파일 제출',deadline:'2099-01-01',visibility:'public'};
 assert.equal((await req('/api/challenges',mission,b)).body.error.code,'EMAIL_VERIFICATION_REQUIRED');
 const made=await req('/api/challenges',mission,a);assert.equal(made.status,201,JSON.stringify(made.body));const id=made.body.challenge.id;
 assert.equal((await req('/api/challenges/'+id,{...mission,title:'이메일 인증 미션 수정'},a,{method:'PUT'})).status,200);
 assert.equal((await req('/api/challenges/'+id,mission,b,{method:'PUT'})).status,403);
 const teaser={headline:'로고 디자인 수행 제안',capability:'다양한 브랜드의 로고 디자인을 제작한 경험이 있습니다.',approach:'요구 사항을 확인한 후 시안과 디자인 원본을 제작하여 전달합니다.',expectedDays:3};
 assert.equal((await req(`/api/challenges/${id}/teasers`,teaser,b)).body.error.code,'EMAIL_VERIFICATION_REQUIRED');
 relax();const bc=await send(b);assert.equal((await confirm(b,bc)).status,200);
 const applied=await req(`/api/challenges/${id}/teasers`,teaser,b);assert.equal(applied.status,201,JSON.stringify(applied.body));
 assert.equal((await req(`/api/challenges/${id}/shortlist`,{teaserId:applied.body.teaser.id,mode:'select'},a)).body.error.code,'VERIFICATION_REQUIRED');
 assert.equal((await req('/api/transactions/payments',{},a)).body.error.code,'MONEY_FLOW_DISABLED');
 assert.equal((await req(`/api/challenges/${id}/teasers/${applied.body.teaser.id}/withdraw`,{reason:'격리 테스트 신청 취소'},b)).status,200);
 pass('email-only members create/edit/apply/withdraw; roles and real transaction identity/money gates remain enforced');
 assert.equal((await req('/api/me/email-verification/send',{purpose:'change_email',email:'new@test.invalid'},a)).body.error.code,'EMAIL_REAUTH_REQUIRED');
 relax();const auth=await send(a,{purpose:'change_authorize'});assert.equal(mail.to[0].email,a.email);
 const authorized=await confirm(a,auth);assert.ok(authorized.body.proof);assert.equal(authorized.body.verified,undefined);
 assert.equal((await req('/api/me/email-verification/send',{purpose:'change_email',email:'new@test.invalid',proof:authorized.body.proof},b)).status,403);
 const change=await send(a,{purpose:'change_email',email:'new@test.invalid',proof:authorized.body.proof});assert.equal(mail.to[0].email,'new@test.invalid');
 assert.equal((await req('/api/me',undefined,a)).body.user.email,a.email);
 assert.equal((await confirm(a,change)).body.changed,true);
 me=(await req('/api/me',undefined,a)).body.user;assert.equal(me.email,'new@test.invalid');assert.equal(me.emailVerified,true);assert.equal(me.verification.identity,false);
 assert.equal((await req('/api/me',undefined,{cookie:relogin.cookie})).body.user,null);
 assert.equal((await req('/api/me/email-verification/send',{purpose:'change_email',email:'another@test.invalid',proof:authorized.body.proof},a)).status,403);
 pass('changing email requires old and new mailbox proof, keeps old address until confirmed, revokes other sessions and grant');
 relax();failDelivery=true;const failed=await req('/api/me/email-verification/send',{},c);assert.equal(failed.body.error.code,'EMAIL_DELIVERY_FAILED');assert.equal(failed.body.sent,undefined);
 assert.equal((await req('/api/me',undefined,c)).body.user.emailVerified,false);failDelivery=false;relax();
 const cc=await send(c);const statuses=await Promise.all([confirm(c,cc),confirm(c,cc)]);assert.equal(statuses.filter(r=>r.status===200).length,1);
 pass('delivery failure remains unverified; duplicate confirmation succeeds exactly once');
 relax();for(let i=0;i<10;i++)await req('/api/me/email-verification/send',{purpose:'change_authorize'},c);
 assert.equal((await req('/api/me/email-verification/send',{purpose:'change_authorize'},c)).body.error.code,'EMAIL_RATE_LIMIT');
 assert.equal(JSON.stringify(emailOtpSetup(env)).includes(env.BREVO_API_KEY),false);
 pass('successful and failed send attempts are rate-limited and admin diagnostics never expose secrets');
 sql.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(a.id);
 sql.prepare("INSERT INTO admin_roles(user_id,role) VALUES (?,'primary')").run(a.id);
 sql.prepare('UPDATE users SET identity_verified=1,business_verified=1 WHERE id=?').run(c.id);
 sql.prepare("INSERT INTO member_verifications(id,user_id,verification_type,subject_type,status,provider,status_reason) VALUES ('legacy-email-test',?,'IDENTITY','individual','VERIFIED','legacy','기존 인증 데이터 보존')").run(c.id);
 const detail=await req('/api/admin/members/'+c.id,undefined,a);assert.equal(detail.body.member.verification.identity,false);assert.equal(detail.body.member.verification.business,false);
 const reviews=await req('/api/admin/verification-reviews',undefined,a);const legacy=reviews.body.verifications.find(x=>x.id==='legacy-email-test');assert.equal(legacy.status,'RECONFIRM_REQUIRED');assert.equal(legacy.stored_status,'VERIFIED');
 assert.equal(sql.prepare("SELECT status FROM member_verifications WHERE id='legacy-email-test'").get().status,'VERIFIED');
 pass('admin lists and member badges separate preserved legacy records from current verification');

}finally{globalThis.fetch=realFetch;sql.close()}
console.log(`Passed ${n} email OTP regression groups`);
