import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../worker/index.mjs';

const sql = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
  if (file.endsWith('.sql')) sql.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
}
const DB = {
  prepare(query) {
    return { args: [], bind(...args) { this.args = args; return this; },
      async first() { return sql.prepare(query).get(...this.args) || null; },
      async all() { return { results: sql.prepare(query).all(...this.args) }; },
      execute() {
        if (/\bRETURNING\b/i.test(query)) { const results = sql.prepare(query).all(...this.args); return { results, meta: { changes: Number(sql.prepare('SELECT changes() n').get().n) } }; }
        if (/^\s*SELECT/i.test(query)) return { results: sql.prepare(query).all(...this.args) };
        return { meta: { changes: Number(sql.prepare(query).run(...this.args).changes) } };
      },
      async run() { return this.execute(); },
    };
  },
  async batch(statements) {
    sql.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  },
};
const env = { DB, APP_ENV: 'test', LOCAL_MONEY_SIMULATION: 'false', PUBLIC_MONEY_ENABLED: 'false', VERIFICATION_ENFORCEMENT: 'advisory', NAVER_OAUTH_CLIENT_ID: 'fixture', NAVER_OAUTH_CLIENT_SECRET: 'fixture', GOOGLE_OAUTH_CLIENT_ID: 'fixture', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture', BREVO_API_KEY: 'fixture-only', BREVO_SENDER_EMAIL: 'sender@test.invalid' };
const sha = text => createHash('sha256').update(text).digest('hex');
const material = { passwordSalt: Buffer.alloc(16, 1).toString('base64'), passwordVerifier: Buffer.alloc(32, 2).toString('base64') };
async function req(path, body, cookie = '', method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const response = await worker.fetch(new Request('https://test.invalid' + path, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.55', Cookie: cookie, 'Idempotency-Key': crypto.randomUUID(), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '', headers: response.headers };
}
let count = 0;
const pass = label => { count++; console.log('PASS auth security: ' + label); };
async function member(number) {
  const response = await req('/api/auth/signup', { ...material, email: `security${number}@test.invalid`, displayName: `검수활동${number}`, phone: `0105555000${number}`, region: '서울', birthYear: 1980, gender: 'female', termsAccepted: true, privacyAccepted: true });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { ...response.body.user, cookie: response.cookie };
}
const owner = await member(1), solver = await member(2), stranger = await member(3);
const legacyToken = 'A'.repeat(43);
sql.prepare("INSERT INTO email_verifications(id,user_id,token_hash,expires_at,target_email) VALUES(?,?,?,datetime('now','+10 minutes'),?)").run('legacy', owner.id, sha(legacyToken), owner.email);
assert.equal((await req('/api/auth/verify-email', { token: legacyToken }, solver.cookie)).body.error.code, 'VERIFICATION_ACCOUNT_MISMATCH');
assert.equal(sql.prepare('SELECT used_at FROM email_verifications WHERE id=?').get('legacy').used_at, null);
assert.equal(sql.prepare('SELECT email_verified FROM users WHERE id=?').get(owner.id).email_verified, 0);
pass('email link from another signed-in member cannot verify or consume the target token');
const confirmations = await Promise.all([1, 2].map(() => req('/api/auth/verify-email', { token: legacyToken }, owner.cookie)));
assert.deepEqual(confirmations.map(item => item.status).sort(), [200, 400]);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='EMAIL_VERIFIED' AND actor_id=?").get(owner.id).n, 1);
assert.equal((await req('/api/auth/verify-email', { token: legacyToken })).status, 400);
pass('concurrent legacy link confirmations have one winner and one audit entry; replay is rejected');

const beforeExpiry = (await req('/api/me', undefined, stranger.cookie)).status;
assert.equal(beforeExpiry, 200);
sql.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 60000).toISOString(), stranger.id);
assert.equal((await req('/api/me', undefined, stranger.cookie)).body.user, null);
assert.equal((await req('/api/me/verifications', undefined, stranger.cookie)).status, 401);
pass('expired ISO-format session is rejected even on the same UTC date');
stranger.cookie = (await req('/api/auth/login', { email: stranger.email, passwordVerifier: material.passwordVerifier })).cookie;

function resetToken(id, member, character) {
  const token = character.repeat(43);
  sql.prepare("INSERT INTO password_resets(id,user_id,token_hash,expires_at) VALUES(?,?,?,datetime('now','+10 minutes'))").run(id, member.id, sha(token));
  return token;
}
let token = resetToken('reset-restricted', stranger, 'B');
sql.prepare("UPDATE users SET status='suspended' WHERE id=?").run(stranger.id);
assert.equal((await req('/api/auth/reset-password', { token, ...material })).status, 403);
assert.equal(sql.prepare('SELECT status FROM users WHERE id=?').get(stranger.id).status, 'suspended');
assert.equal(sql.prepare('SELECT used_at FROM password_resets WHERE id=?').get('reset-restricted').used_at, null);
pass('a previously issued password-reset token cannot reactivate a suspended member');
sql.prepare("UPDATE users SET status='limited' WHERE id=?").run(stranger.id);
token = resetToken('reset-race', stranger, 'C');
const resets = await Promise.all([1, 2].map(() => req('/api/auth/reset-password', { token, ...material })));
assert.deepEqual(resets.map(item => item.status).sort(), [200, 400]);
stranger.cookie = resets.find(item => item.status === 200).cookie;
assert.equal(sql.prepare('SELECT status FROM users WHERE id=?').get(stranger.id).status, 'limited');
assert.equal(sql.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(stranger.id).n, 1);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='PASSWORD_RESET' AND actor_id=?").get(stranger.id).n, 1);
pass('concurrent password reset succeeds once, preserves limited status, and replaces prior sessions');

const originalFetch = globalThis.fetch;
let profile = { id: 'unlinked-naver', email: owner.email, name: '검수계정' }, googleProfile = {}, providerCalls = 0, sentMails = 0;
globalThis.fetch = async url => {
  if (String(url) === 'https://api.brevo.com/v3/smtp/email') { sentMails++; return Response.json({ messageId: 'fixture' }); }
  if (String(url).includes('/oauth2.0/token')) { providerCalls++; return Response.json({ access_token: 'fixture' }); }
  if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture' });
  if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(googleProfile);
  if (String(url) === 'https://openapi.naver.com/v1/nid/me') return Response.json({ resultcode: '00', response: profile });
  throw new Error('Unexpected external transport');
};
async function startOAuth(cookie = '', provider = 'naver') {
  const response = await worker.fetch(new Request(`https://test.invalid/api/auth/oauth/${provider}?returnTo=%23%2Fdashboard`, { headers: { Cookie: cookie } }), env, {});
  const state = new URL(response.headers.get('location')).searchParams.get('state');
  return { url: `https://test.invalid/api/auth/oauth/${provider}/callback?state=${state}&code=fixture`, cookie: [response.headers.get('set-cookie').split(';')[0], cookie].filter(Boolean).join('; ') };
}
async function callback(auth) {
  const response = await worker.fetch(new Request(auth.url, { headers: { Cookie: auth.cookie } }), env, {});
  return { text: decodeURIComponent(await response.text()), cookie: response.headers.get('set-cookie') || '' };
}
try {
  const refused = await callback(await startOAuth());
  assert.match(refused.text, /기존 계정으로 로그인/);
  assert.ok(!refused.cookie.startsWith('mc_session='));
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM auth_identities WHERE provider='naver'").get().n, 0);
  pass('unverified NAVER email match cannot link or log into an existing verified account');
  const linked = await callback(await startOAuth(owner.cookie));
  assert.match(linked.text, /dashboard\?oauth=success/);
  assert.match(linked.cookie, /^mc_session=/);
  assert.equal(sql.prepare("SELECT user_id FROM auth_identities WHERE provider='naver' AND provider_subject='unlinked-naver'").get().user_id, owner.id);
  pass('existing authenticated email-verified member can link the matching NAVER identity');
  const auth = await startOAuth(), before = providerCalls;
  const callbacks = await Promise.all([callback(auth), callback(auth)]);
  assert.equal(callbacks.filter(item => item.cookie.startsWith('mc_session=')).length, 1);
  assert.equal(providerCalls - before, 1);
  pass('concurrent OAuth callbacks consume state once before the provider token exchange');
  const preregistered = await member(4);
  sql.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,provider_email) VALUES(?,?,'naver',?,?)").run('prior-naver', preregistered.id, 'prior-naver-subject', preregistered.email);
  const oldReset = resetToken('prior-reset', preregistered, 'D');
  const userCount = sql.prepare('SELECT COUNT(*) n FROM users').get().n;
  googleProfile = { sub: 'mailbox-owner-google', email: preregistered.email, email_verified: true, name: '확인된소유자' };
  const recovered = await callback(await startOAuth('', 'google'));
  assert.match(recovered.cookie, /^mc_session=/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM users').get().n, userCount);
  assert.equal((await req('/api/me', undefined, preregistered.cookie)).body.user, null);
  assert.equal((await req('/api/auth/login', { email: preregistered.email, passwordVerifier: material.passwordVerifier })).status, 401);
  assert.equal((await req('/api/auth/reset-password', { token: oldReset, ...material })).status, 400);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM auth_identities WHERE id='prior-naver'").get().n, 1);
  assert.equal(sql.prepare("SELECT cleared_at FROM auth_identity_restrictions WHERE identity_id='prior-naver'").get().cleared_at, null);
  profile = { id: 'prior-naver-subject', email: preregistered.email, name: '이전외부계정' };
  assert.ok(!(await callback(await startOAuth())).cookie.startsWith('mc_session='));
  assert.match((await callback(await startOAuth(recovered.cookie.split(';')[0]))).cookie, /^mc_session=/);
  assert.ok(sql.prepare("SELECT cleared_at FROM auth_identity_restrictions WHERE identity_id='prior-naver'").get().cleared_at);
  pass('Google mailbox recovery revokes prior password, sessions, reset tokens and social access without deleting member/identity records; owner can relink');
  const restrictionsBefore = sql.prepare('SELECT * FROM auth_identity_restrictions').all();
  sql.exec(readFileSync(new URL('../migrations/0025_oauth_identity_restrictions.sql', import.meta.url), 'utf8'));
  assert.deepEqual(sql.prepare('SELECT * FROM auth_identity_restrictions').all(), restrictionsBefore);
  pass('OAuth restriction migration is repeat-safe and preserves revocation history');
  const verifiedPassword = sql.prepare('SELECT password_hash FROM users WHERE id=?').get(owner.id).password_hash;
  googleProfile = { sub: 'already-verified-google', email: owner.email, email_verified: true, name: '기존회원' };
  assert.match((await callback(await startOAuth('', 'google'))).cookie, /^mc_session=/);
  assert.equal(sql.prepare('SELECT password_hash FROM users WHERE id=?').get(owner.id).password_hash, verifiedPassword);
  assert.equal((await req('/api/me', undefined, owner.cookie)).body.user.id, owner.id);
  pass('Google login preserves existing password and sessions for previously verified members');
  for (let i = 0; i < 5; i++) assert.equal((await req('/api/auth/request-password-reset', { email: owner.email })).status, 200);
  assert.equal((await req('/api/auth/request-password-reset', { email: owner.email })).status, 429);
  assert.equal(sentMails, 5);
  pass('successful password-reset emails are rate limited as well as failed requests');
} finally { globalThis.fetch = originalFetch; }

const mission = { title: '동네 공원 안내문 제작 제안', summary: '지역 공원 이용 안내문을 보기 쉽게 제작합니다.', description: '제공한 공원 이용수칙을 바탕으로 안내문 초안을 만들고 문구와 구성을 함께 검토합니다.', category: 'IDEA', region: '전국', rewardAmount: 100000, successCriteria: '안내문 시안을 제출하고 요청한 한 차례 수정을 반영합니다.', paymentTrigger: '수행자를 선정한 다음 보상금을 준비합니다.', evidenceRequirements: '최종 안내문 PDF 파일을 제출합니다.', deadline: new Date(Date.now() + 86400000 * 7).toISOString(), visibility: 'public' };
assert.equal((await req('/api/challenges', mission, solver.cookie)).body.error.code, 'EMAIL_VERIFICATION_REQUIRED');
const made = await req('/api/challenges', mission, owner.cookie);
assert.equal(made.status, 201, JSON.stringify(made.body));
const id = made.body.challenge.id;
const teaser = { headline: '안내문을 읽기 쉽게 만들어드립니다', capability: '공공 안내문을 제작한 경험을 바탕으로 내용을 정리하겠습니다.', approach: '초안을 작성한 후 검토 의견을 반영하여 최종 파일을 제출하겠습니다.', expectedDays: 3, subjectType: 'individual' };
assert.equal((await req(`/api/challenges/${id}/teasers`, teaser, solver.cookie)).body.error.code, 'EMAIL_VERIFICATION_REQUIRED');
pass('server rejects mission registration and TEASER submission without verified email');
sql.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(solver.id);
sql.prepare("UPDATE challenges SET visibility='private' WHERE id=?").run(id);
assert.equal((await req(`/api/challenges/${id}/teasers`, teaser, solver.cookie)).status, 404);
assert.equal((await req(`/api/challenges/${id}`)).status, 404);
assert.equal((await req(`/api/challenges/${id}`, undefined, owner.cookie)).status, 200);
sql.prepare("UPDATE challenges SET visibility='unlisted',submitted_visibility='unlisted' WHERE id=?").run(id);
assert.equal((await req(`/api/challenges/${id}`)).status, 200);
assert.ok(!(await req('/api/challenges')).body.challenges.some(item => item.id === id));
assert.ok(!(await req('/api/bootstrap')).body.challenges.some(item => item.id === id));
const submitted = await req(`/api/challenges/${id}/teasers`, teaser, solver.cookie);
assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
pass('unlisted missions support direct-link viewing and verified applications while list/bootstrap hide them; private detail stays restricted');
assert.equal((await req(`/api/challenges/${id}/teasers`, undefined, stranger.cookie)).status, 403);
assert.equal((await req(`/api/challenges/${id}/my-teaser`, undefined, stranger.cookie)).status, 404);
assert.equal((await req(`/api/challenges/${id}/teasers/${submitted.body.teaser.id}`, teaser, stranger.cookie, 'PUT')).status, 403);
assert.equal((await req(`/api/challenges/${id}/teasers/${submitted.body.teaser.id}/withdraw`, {}, stranger.cookie)).status, 403);
pass('private mission cannot receive guessed-ID applications and other members cannot read/edit/withdraw TEASER');
sql.exec('DELETE FROM email_otp_limits');
for (let i = 0; i < 30; i++) assert.equal((await req('/api/challenges/missing', {}, owner.cookie, 'PUT')).status, 404);
assert.equal((await req('/api/challenges/missing', {}, owner.cookie, 'PUT')).status, 429);
for (let i = 0; i < 30; i++) assert.equal((await req('/api/challenges/missing/teasers', {}, solver.cookie)).status, 404);
assert.equal((await req('/api/challenges/missing/teasers', {}, solver.cookie)).status, 429);
pass('mission and TEASER write endpoints enforce atomic account request limits');
const publicProfile = await req(`/api/users/${owner.id}/trust`);
assert.equal(publicProfile.status, 200);
for (const privateField of ['email', 'phone', 'realName', 'passwordHash', 'passwordSalt', 'ci', 'di']) assert.ok(!(privateField in publicProfile.body.profile), privateField);
assert.ok(!JSON.stringify(publicProfile.body).includes(owner.email));
const scoped = await req(`/api/me/verifications?userId=${owner.id}`, undefined, solver.cookie);
assert.equal(scoped.status, 200);
assert.ok(!JSON.stringify(scoped.body).includes(owner.email));
pass('public trust profile omits personal contact and credentials; member verification is scoped to the session');
assert.equal((await req('/api/admin/verification-reviews')).status, 401);
assert.equal((await req('/api/me/verifications')).status, 401);
assert.equal((await req('/api/auth/logout', {}, owner.cookie, 'POST', { Origin: 'https://other.invalid' })).status, 403);
assert.equal((await req('/api/auth/logout', {}, owner.cookie)).status, 200);
assert.equal((await req('/api/me', undefined, owner.cookie)).body.user, null);
pass('private APIs require authentication, cross-origin writes are rejected, logout invalidates the session');
console.log(`Auth security regressions: ${count} passed, 0 failed.`);
