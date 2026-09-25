import { sha } from './secure-data.mjs';
const enc = new TextEncoder();
const TTL = 600000, COOLDOWN = 60000;
const normalize = value => String(value || '').trim().toLowerCase();
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const secret = env => String(env.EMAIL_OTP_SECRET || env.BREVO_API_KEY || '');
export function emailOtpSetup(env) {
 return [{key:'BREVO_API_KEY',ready:Boolean(String(env.BREVO_API_KEY || '').trim())},
 {key:'BREVO_SENDER_EMAIL',ready:validEmail(String(env.BREVO_SENDER_EMAIL || ''))},
 {key:'EMAIL_OTP_SERVER_SECRET',ready:secret(env).length>=32}];
}
export const emailOtpAvailable = env => emailOtpSetup(env).every(x=>x.ready);
async function mac(env,value) {
 const key=await crypto.subtle.importKey('raw',enc.encode(secret(env)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode('moduclear-email-otp-v1:'+value))),x=>x.toString(16).padStart(2,'0')).join('');
}
function code() {let n;do{n=crypto.getRandomValues(new Uint32Array(1))[0]}while(n>=4294000000);return String(n%1000000).padStart(6,'0');}
async function rate(request,env,user,action,now) {
 const window=action==='send'?3600000:900000, bucket=Math.floor(now/window);
 const ip=await sha(request.headers.get('CF-Connecting-IP') || 'unknown');
 const keys=[`email:${action}:user:${user.id}:${bucket}`,`email:${action}:ip:${ip}:${bucket}`];
 const rows=await env.DB.batch(keys.map(key=>env.DB.prepare('INSERT INTO email_otp_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,now+window*2)));
 return rows.every((r,i)=>Number(r.results?.[0]?.count ?? Infinity)<=(action==='send'?(i?30:10):(i?100:30)));
}
export async function emailOtpApi({request,env,user,path,method,body,json,problem,auditStatement}) {
 const now=Date.now(), session=await sha(request.headers.get('Cookie')?.match(/(?:^|;\s*)mc_session=([^;]+)/)?.[1] || '');
 const response=data=>json(data,200,{'Cache-Control':'private, no-store'});
 if(method==='GET' && path==='/api/me/email-verification') {
  const active=await env.DB.prepare("SELECT id,email,purpose,expires_at,created_at,attempts FROM email_otp_challenges WHERE user_id=? AND session_hash=? AND original_email=? AND purpose='verify_email' AND status='SENT' AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(user.id,session,user.email,now).first();
  return response({email:user.email,verified:Boolean(user.email_verified),available:emailOtpAvailable(env),challenge:active?{id:active.id,email:active.email,purpose:active.purpose,expiresAt:active.expires_at,resendAt:active.created_at+COOLDOWN}:null});
 }
 if(method!=='POST')return problem(405,'METHOD_NOT_ALLOWED','지원하지 않는 요청입니다.');
 if(!emailOtpAvailable(env))return problem(503,'EMAIL_DELIVERY_UNAVAILABLE','이메일 인증 발송 설정을 준비하고 있습니다. 운영팀에 문의해주세요.');
 if(path.endsWith('/send')) {
  const purpose=body.purpose || 'verify_email';
  if(!['verify_email','change_authorize','change_email'].includes(purpose))return problem(400,'INVALID_EMAIL_PURPOSE','인증 목적을 확인해주세요.');
  if(!await rate(request,env,user,'send',now))return problem(429,'EMAIL_RATE_LIMIT','인증메일 요청이 많습니다. 1시간 후 다시 시도해주세요.');
  if(purpose==='verify_email' && user.email_verified)return response({verified:true});
  if(purpose!=='verify_email' && user.is_admin)return problem(403,'ADMIN_EMAIL_CHANGE_RESTRICTED','관리자 이메일은 계정 권한 보호를 위해 별도 운영 절차로 변경해주세요.');
  const email=purpose==='change_email'?normalize(body.email):user.email;
  if(!validEmail(email))return problem(400,'INVALID_EMAIL','올바른 이메일 주소를 입력해주세요.');
  if(purpose==='change_email') {
   if(email===user.email)return problem(400,'SAME_EMAIL','다른 이메일 주소를 입력해주세요.');
   const proof=await env.DB.prepare("SELECT id FROM email_otp_challenges WHERE user_id=? AND original_email=? AND session_hash=? AND purpose='change_authorize' AND status='USED' AND proof_hash=? AND proof_expires_at>?").bind(user.id,user.email,session,await sha(String(body.proof || '')),now).first();
   if(!proof)return problem(403,'EMAIL_REAUTH_REQUIRED','기존 이메일 인증을 먼저 완료해주세요.');
   const exists=await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
   if(exists)return problem(409,'EMAIL_CHANGE_UNAVAILABLE','이 주소로 변경할 수 없습니다. 다른 이메일을 확인해주세요.');
  }
  const lock=await env.DB.prepare('INSERT INTO email_otp_send_locks (user_id,purpose,sent_at) VALUES (?,?,?) ON CONFLICT(user_id,purpose) DO UPDATE SET sent_at=excluded.sent_at WHERE sent_at<=? RETURNING sent_at').bind(user.id,purpose,now,now-COOLDOWN).all();
  if(!lock.results.length)return problem(429,'EMAIL_RESEND_WAIT','최근 요청 후 60초가 지나면 다시 보낼 수 있습니다.');
  const id='eotp_'+crypto.randomUUID(), otp=code();
  const hash=await mac(env,JSON.stringify([id,user.id,email,purpose,session,otp]));
  await env.DB.batch([
   env.DB.prepare("UPDATE email_otp_challenges SET used_at=?,status='REPLACED',proof_hash=NULL WHERE user_id=? AND purpose=? AND used_at IS NULL").bind(now,user.id,purpose),
   env.DB.prepare('INSERT INTO email_otp_challenges (id,user_id,email,original_email,purpose,session_hash,code_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,user.id,email,user.email,purpose,session,hash,now,now+TTL),
   env.DB.prepare('UPDATE email_verifications SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL').bind(user.id),
  ]);
  const label=purpose==='change_authorize'?'이메일 변경을 위한 기존 주소 확인':purpose==='change_email'?'새 이메일 주소 확인':'이메일 인증';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  let delivered=false;
  try {
   const result=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','api-key':env.BREVO_API_KEY},body:JSON.stringify({sender:{name:'모두의클리어',email:env.BREVO_SENDER_EMAIL},to:[{email}],subject:`[모두의클리어] ${label} 인증번호`,textContent:`${label}\n인증번호: ${otp}\n10분 안에 입력해주세요. 인증번호는 타인에게 알려주지 마세요. 직접 요청하지 않았다면 이 메일을 무시해주세요.\nISEA GROUP`,htmlContent:`<!doctype html><html lang="ko"><body style="font:16px sans-serif;line-height:1.6;color:#172234"><h1 style="font-size:22px">모두의클리어 ${label}</h1><p>아래 인증번호를 요청한 화면에 입력해주세요.</p><p style="font:32px monospace;letter-spacing:6px">${otp}</p><p>유효시간은 10분입니다. 인증번호를 다른 사람에게 알려주지 마세요.</p><p>직접 요청하지 않았다면 이 메일을 무시해주세요.</p><p>ISEA GROUP</p></body></html>`})});
   delivered=result.ok;
  }catch{}finally{clearTimeout(timer)}
  await env.DB.prepare('UPDATE email_otp_challenges SET status=? WHERE id=? AND status=\'PENDING\'').bind(delivered?'SENT':'FAILED',id).run();
  if(!delivered)return problem(503,'EMAIL_DELIVERY_FAILED','인증메일을 보내지 못했습니다. 60초 후 다시 시도하거나 운영팀에 문의해주세요.');
  await env.DB.prepare('UPDATE users SET email_verification_requested_at=CURRENT_TIMESTAMP WHERE id=?').bind(user.id).run();
  return response({sent:true,challenge:{id,email,purpose,expiresAt:now+TTL,resendAt:now+COOLDOWN}});
 }
 if(!path.endsWith('/confirm'))return problem(404,'NOT_FOUND','인증 경로를 찾을 수 없습니다.');
 if(!await rate(request,env,user,'verify',now))return problem(429,'EMAIL_RATE_LIMIT','확인 요청이 많습니다. 15분 후 다시 시도해주세요.');
 const row=await env.DB.prepare('SELECT * FROM email_otp_challenges WHERE id=? AND user_id=? AND session_hash=? AND original_email=?').bind(String(body.id || ''),user.id,session,user.email).first();
 if(!row || row.used_at || row.status!=='SENT')return problem(400,'EMAIL_CODE_UNAVAILABLE','사용할 수 없는 인증번호입니다. 새 번호를 요청해주세요.');
 if(row.expires_at<=now)return problem(400,'EMAIL_CODE_EXPIRED','인증번호가 만료되었습니다. 새 번호를 요청해주세요.');
 if(row.attempts>=5)return problem(429,'EMAIL_CODE_LOCKED','입력 횟수를 초과했습니다. 새 번호를 요청해주세요.');
 const hash=await mac(env,JSON.stringify([row.id,user.id,row.email,row.purpose,session,String(body.code || '')]));
 let mismatch=hash.length^row.code_hash.length;for(let i=0;i<hash.length;i++)mismatch|=hash.charCodeAt(i)^row.code_hash.charCodeAt(i);
 if(mismatch) {
  const result=await env.DB.prepare("UPDATE email_otp_challenges SET attempts=attempts+1 WHERE id=? AND used_at IS NULL AND status='SENT' AND attempts<5 RETURNING attempts").bind(row.id).all();
  const left=Math.max(0,5-(result.results?.[0]?.attempts ?? 5));
  return problem(left?400:429,left?'EMAIL_CODE_INVALID':'EMAIL_CODE_LOCKED',left?`인증번호가 일치하지 않습니다. ${left}회 남았습니다.`:'입력 횟수를 초과했습니다. 새 번호를 요청해주세요.');
 }
 const claim=crypto.randomUUID(),proof=crypto.randomUUID()+crypto.randomUUID();
 const statements=[env.DB.prepare("UPDATE email_otp_challenges SET used_at=?,status='USED',claim=?,proof_hash=?,proof_expires_at=? WHERE id=? AND code_hash=? AND used_at IS NULL AND status='SENT' AND attempts<5 AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=email_otp_challenges.user_id AND email=email_otp_challenges.original_email)").bind(now,claim,row.purpose==='change_authorize'?await sha(proof):null,now+TTL,row.id,hash,now)];
 if(row.purpose!=='change_authorize') {
  statements.push(env.DB.prepare("UPDATE users SET email=?,email_verified=1,email_verified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND email=? AND EXISTS(SELECT 1 FROM email_otp_challenges WHERE id=? AND claim=?)").bind(row.email,user.id,row.original_email,row.id,claim));
  if(row.purpose==='change_email') {
   statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND EXISTS(SELECT 1 FROM email_otp_challenges WHERE id=? AND claim=?)').bind(user.id,session,row.id,claim));
   statements.push(env.DB.prepare('UPDATE email_otp_challenges SET proof_hash=NULL WHERE user_id=? AND purpose=\'change_authorize\' AND EXISTS(SELECT 1 FROM email_otp_challenges WHERE id=? AND claim=?)').bind(user.id,row.id,claim));
   statements.push(env.DB.prepare('UPDATE password_resets SET used_at=CURRENT_TIMESTAMP WHERE user_id=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM email_otp_challenges WHERE id=? AND claim=?)').bind(user.id,row.id,claim));
  }
 }
 let results;
 try{results=await env.DB.batch(statements)}catch(error){if(String(error).includes('UNIQUE'))return problem(409,'EMAIL_CHANGE_UNAVAILABLE','이 주소로 변경할 수 없습니다. 다른 이메일을 확인해주세요.');throw error}
 if(!results[0]?.meta?.changes)return problem(409,'EMAIL_CODE_UNAVAILABLE','이미 처리된 번호입니다. 인증 상태를 새로 확인해주세요.');
 await auditStatement(env,user.id,row.purpose==='change_authorize'?'EMAIL_CHANGE_REAUTH':row.purpose==='change_email'?'EMAIL_CHANGED':'EMAIL_VERIFIED','user',user.id,null,{method:'email-otp',purpose:row.purpose}).run();
 return response(row.purpose==='change_authorize'?{reauthenticated:true,proof}:{verified:true,email:row.email,changed:row.purpose==='change_email'});
}
