import { identityConfigured } from './launch-readiness.mjs';
const enc = new TextEncoder();
export const IDENTITY_CONSENT_VERSION = '2026-09-23-identity-v1';
const timestamp = value => Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(String(value)) ? value : String(value).replace(' ', 'T') + 'Z');
export async function identityDigest(value, env) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.IDENTITY_HASH_SECRET), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function identityApi({action,user,body,env,json,problem,auditStatement}) {
  if (!identityConfigured(env)) return problem(503,'IDENTITY_PROVIDER_REQUIRED','본인확인 기관 계약·연동 검증 전입니다. 아직 인증할 수 없습니다.');
  if (action === 'start') {
    if (body.consentVersion !== IDENTITY_CONSENT_VERSION || body.consent !== true) return problem(400,'IDENTITY_CONSENT_REQUIRED','본인확인 처리 안내를 확인하고 동의해주세요.');
    const count = await env.DB.prepare("SELECT count(*) AS n FROM identity_attempts WHERE user_id=? AND created_at>datetime('now','-1 hour')").bind(user.id).first();
    if (count.n >= 5) return problem(429,'IDENTITY_RATE_LIMIT','인증 요청이 많습니다. 잠시 후 다시 시도해주세요.');
    // KCP accepts only alphanumeric request IDs, at most 40 characters.
    const id = `iv${crypto.randomUUID().replaceAll('-', '')}`;
    const expires = new Date(Date.now()+600000).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO identity_attempts(id,user_id,consent_version,expires_at) VALUES(?,?,?,?)').bind(id,user.id,IDENTITY_CONSENT_VERSION,expires),
      auditStatement(env,user.id,'IDENTITY_START','identity_attempt',id,null,{consentVersion:IDENTITY_CONSENT_VERSION})
    ]);
    return json({identityVerificationId:id,storeId:env.PORTONE_STORE_ID,channelKey:env.PORTONE_IDENTITY_CHANNEL_KEY,expiresAt:expires},201);
  }
  const id = String(body.identityVerificationId || '');
  const attempt = await env.DB.prepare('SELECT * FROM identity_attempts WHERE id=? AND user_id=?').bind(id,user.id).first();
  if (!attempt) return problem(404,'IDENTITY_ATTEMPT_NOT_FOUND','본인 계정에서 시작한 인증 요청이 아닙니다.');
  const completed = async () => {
    const current = await env.DB.prepare(`SELECT v.expires_at FROM verified_identities v JOIN member_verifications m ON m.user_id=v.user_id
      WHERE v.user_id=? AND v.provider_reference_hash=? AND v.provider='portone-v2' AND v.revoked_at IS NULL
      AND m.verification_type='IDENTITY' AND m.provider='portone-v2' AND m.status='VERIFIED' AND m.revoked_at IS NULL
      AND m.provider_reference_hash=v.provider_reference_hash AND julianday(v.expires_at)>julianday('now') AND julianday(m.expires_at)>julianday('now')`)
      .bind(user.id,await identityDigest(`portone-reference:${id}`,env)).first();
    return current ? json({ok:true,idempotent:true,status:'VERIFIED',expiresAt:current.expires_at})
      : problem(409,'IDENTITY_RECONFIRM_REQUIRED','기존 인증이 만료·취소되었거나 새 인증으로 변경되었습니다. 인증 상태를 다시 확인해주세요.');
  };
  if (attempt.status === 'VERIFIED') return completed();
  if (attempt.status !== 'PENDING' || !Number.isFinite(timestamp(attempt.expires_at)) || timestamp(attempt.expires_at)<=Date.now()) {
    await env.DB.prepare("UPDATE identity_attempts SET status='EXPIRED' WHERE id=? AND status='PENDING'").bind(id).run();
    return problem(409,'IDENTITY_ATTEMPT_EXPIRED','인증 요청이 만료되었습니다. 다시 시작해주세요.');
  }
  let data;
  try {
    const r=await fetch(`https://api.portone.io/identity-verifications/${encodeURIComponent(id)}?storeId=${encodeURIComponent(env.PORTONE_STORE_ID)}`,{
      headers:{Authorization:`PortOne ${env.PORTONE_API_SECRET}`},signal:AbortSignal.timeout(10000)
    });
    if (!r.ok) return problem(503,'IDENTITY_PROVIDER_UNAVAILABLE','인증기관 결과 확인에 실패했습니다. 인증 완료 처리되지 않았습니다.');
    data=await r.json();
  } catch { return problem(503,'IDENTITY_PROVIDER_UNAVAILABLE','인증기관 응답을 확인할 수 없습니다. 다시 확인해주세요.'); }
  const customer=data.verifiedCustomer;
  const verifiedAt=Date.parse(data.verifiedAt);
  if (data.status!=='VERIFIED' || data.id!==id || (data.storeId && data.storeId!==env.PORTONE_STORE_ID) || typeof customer?.di!=='string' || !customer.di || !Number.isFinite(verifiedAt) || verifiedAt < timestamp(attempt.created_at)-60000 || verifiedAt>Date.now()+60000) {
    return problem(409,'IDENTITY_RESULT_INVALID','기관의 인증완료 결과와 중복확인 식별값을 확인하지 못했습니다.');
  }
  // Values supplied by a client, email verification and legacy DB badges never qualify.
  const normalizedPhone=value=>String(value||'').replace(/^\+82/, '0').replace(/[^0-9]/g,'');
  if (!customer.name || customer.name.normalize('NFC').trim()!==String(user.real_name||'').normalize('NFC').trim() || normalizedPhone(customer.phoneNumber)!==normalizedPhone(user.phone)) {
    return problem(409,'IDENTITY_PROFILE_MISMATCH','가입 정보와 인증 결과가 다릅니다. 운영팀에 계정 정보 정정을 요청해주세요.');
  }
  const dob=Date.parse(customer.birthDate);
  if (!Number.isFinite(dob) || new Date(new Date(dob).getUTCFullYear()+19,new Date(dob).getUTCMonth(),new Date(dob).getUTCDate()).getTime()>Date.now()) return problem(403,'ADULT_IDENTITY_REQUIRED','현재 거래 서비스는 만 19세 이상만 지원합니다.');
  const subjectHash=await identityDigest(`portone-di:${customer.di}`,env);
  const referenceHash=await identityDigest(`portone-reference:${id}`,env);
  const existing=await env.DB.prepare('SELECT user_id,subject_hash FROM verified_identities WHERE subject_hash=? OR user_id=?').bind(subjectHash,user.id).all();
  if ((existing.results||[]).some(x=>x.user_id!==user.id || x.subject_hash!==subjectHash)) return problem(409,'IDENTITY_CONFLICT','이미 연결된 본인확인 정보가 있습니다. 운영팀의 계정 복구 심사가 필요합니다.');
  const at=new Date(verifiedAt).toISOString(), expires=new Date(verifiedAt+365*86400000).toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO verified_identities(user_id,subject_hash,provider_reference_hash,provider,verified_at,expires_at)
        SELECT ?,?,?,'portone-v2',?,? WHERE EXISTS(SELECT 1 FROM identity_attempts WHERE id=? AND status='PENDING' AND julianday(expires_at)>julianday('now'))
        ON CONFLICT(user_id) DO UPDATE SET provider_reference_hash=excluded.provider_reference_hash,verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=NULL
        WHERE verified_identities.subject_hash=excluded.subject_hash`).bind(user.id,subjectHash,referenceHash,at,expires,id),
      env.DB.prepare(`INSERT INTO member_verifications(id,user_id,verification_type,subject_type,status,provider,provider_reference_hash,verified_at,expires_at)
        SELECT ?,?,'IDENTITY','individual','VERIFIED','portone-v2',?,?,? WHERE EXISTS(SELECT 1 FROM identity_attempts WHERE id=? AND status='PENDING' AND julianday(expires_at)>julianday('now'))
        AND EXISTS(SELECT 1 FROM verified_identities WHERE user_id=? AND subject_hash=? AND provider_reference_hash=?)
        ON CONFLICT(user_id,verification_type,subject_type) DO UPDATE SET status='VERIFIED',provider='portone-v2',provider_reference_hash=excluded.provider_reference_hash,verified_at=excluded.verified_at,expires_at=excluded.expires_at,revoked_at=NULL,status_reason=NULL,updated_at=CURRENT_TIMESTAMP`).bind('identity_'+user.id,user.id,referenceHash,at,expires,id,user.id,subjectHash,referenceHash),
      env.DB.prepare(`INSERT INTO audit_logs(id,actor_id,action,resource_type,resource_id,after_json)
        SELECT ?,?,'IDENTITY_PROVIDER_VERIFIED','identity_attempt',?,? WHERE EXISTS(SELECT 1 FROM identity_attempts WHERE id=? AND status='PENDING' AND julianday(expires_at)>julianday('now'))
        AND EXISTS(SELECT 1 FROM verified_identities WHERE user_id=? AND subject_hash=? AND provider_reference_hash=?)`)
        .bind(crypto.randomUUID(),user.id,id,JSON.stringify({provider:'portone-v2',expiresAt:expires}),id,user.id,subjectHash,referenceHash),
      env.DB.prepare(`UPDATE identity_attempts SET status='VERIFIED',consumed_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING' AND julianday(expires_at)>julianday('now')
        AND EXISTS(SELECT 1 FROM verified_identities WHERE user_id=? AND subject_hash=? AND provider_reference_hash=?)`).bind(id,user.id,subjectHash,referenceHash)
    ]);
    if (!results[0].meta?.changes) return completed();
  } catch(error) {
    if (String(error).includes('UNIQUE')) return problem(409,'IDENTITY_CONFLICT','인증 정보가 다른 요청에서 사용되었습니다. 운영팀 확인이 필요합니다.');
    throw error;
  }
  return json({ok:true,status:'VERIFIED',expiresAt:expires});
}
