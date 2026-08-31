import { randomUUID, webcrypto } from 'node:crypto';

const origin = process.env.MODU_ORIGIN || 'http://127.0.0.1:8790';
const primaryEmail = 'kpa100plus@gmail.com';
const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN || 'local-admin-role-e2e-token';
const recoveryToken = process.env.PRIMARY_ADMIN_RECOVERY_TOKEN || 'local-primary-recovery-token';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const primaryPassword = `Primary${suffix}9`;
const memberPassword = `Member${suffix}9`;
const memberEmail = `role-member-${suffix}@demo.invalid`;
const encoder = new TextEncoder();

function base64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function passwordMaterial(value, saltValue) {
  const salt = saltValue ? Buffer.from(saltValue, 'base64') : webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, ['deriveBits']);
  const verifier = await webcrypto.subtle.deriveBits({
    name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256',
  }, key, 256);
  return { passwordSalt: base64(salt), passwordVerifier: base64(new Uint8Array(verifier)) };
}

async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

function expect(result, status, label, code) {
  if (result.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${result.status} ${JSON.stringify(result.payload)}`);
  }
  if (code && result.payload?.error?.code !== code) {
    throw new Error(`${label}: expected ${code}, got ${JSON.stringify(result.payload)}`);
  }
  return result;
}

const checks = [];
function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

expect(await request('/api/health'), 200, 'health');
pass('health');

const primaryMaterial = await passwordMaterial(primaryPassword);
const bootstrap = expect(await request('/api/internal/bootstrap-admin', {
  method: 'POST',
  headers: { 'X-Bootstrap-Token': bootstrapToken },
  body: { email: primaryEmail, displayName: 'juyoungkim', ...primaryMaterial },
}), 201, 'primary bootstrap');
pass('primary-bootstrap');

const recoveredPassword = `Recovered${suffix}9`;
const recoveredMaterial = await passwordMaterial(recoveredPassword);
expect(await request('/api/auth/recover-primary', {
  method: 'POST',
  body: { email: primaryEmail, recoveryToken: 'incorrect-token', ...recoveredMaterial },
}), 403, 'primary recovery rejects invalid token', 'RECOVERY_DENIED');
expect(await request('/api/auth/recover-primary', {
  method: 'POST',
  body: { email: primaryEmail, recoveryToken, ...recoveredMaterial },
}), 200, 'primary recovery');
pass('primary-recovery');

const loginOptions = expect(await request('/api/auth/login-options', {
  method: 'POST', body: { email: primaryEmail },
}), 200, 'primary login options');
const primaryLoginMaterial = await passwordMaterial(recoveredPassword, loginOptions.payload.salt);
const primaryLogin = expect(await request('/api/auth/login', {
  method: 'POST', body: { email: primaryEmail, passwordVerifier: primaryLoginMaterial.passwordVerifier },
}), 200, 'primary login');
const primaryCookie = primaryLogin.cookie;
if (primaryLogin.payload.user?.adminRole !== 'primary' || primaryLogin.payload.user?.displayName !== 'juyoungkim') {
  throw new Error(`primary login role mismatch: ${JSON.stringify(primaryLogin.payload)}`);
}
pass('primary-login-role');

const memberMaterial = await passwordMaterial(memberPassword);
const memberSignup = expect(await request('/api/auth/signup', {
  method: 'POST',
  body: {
    displayName: '권한검수 회원', email: memberEmail, accountType: 'individual',
    ...memberMaterial, termsAccepted: true, privacyAccepted: true,
  },
}), 201, 'member signup');
const memberCookie = memberSignup.cookie;
const memberId = memberSignup.payload.user?.id;
if (!memberId || memberSignup.payload.user?.adminRole !== 'member') throw new Error('member signup role mismatch');
pass('member-signup-role');

expect(await request('/api/admin/overview'), 401, 'guest overview blocked', 'AUTH_REQUIRED');
expect(await request('/api/admin/overview', { cookie: memberCookie }), 403, 'member overview blocked', 'ADMIN_REQUIRED');
expect(await request(`/api/admin/members/${encodeURIComponent(memberId)}`), 401, 'guest member detail blocked', 'AUTH_REQUIRED');
expect(await request(`/api/admin/members/${encodeURIComponent(memberId)}`, { cookie: memberCookie }), 403, 'member detail blocked', 'ADMIN_REQUIRED');
expect(await request('/api/admin/deputies', { method: 'POST', cookie: memberCookie, body: { userId: memberId } }), 403, 'member appoint blocked', 'ADMIN_REQUIRED');
expect(await request('/api/admin/strikes', { method: 'POST', cookie: memberCookie, body: {} }), 403, 'member strike blocked', 'ADMIN_REQUIRED');
pass('guest-and-member-admin-blocked');

expect(await request('/api/admin/deputies', {
  method: 'POST', cookie: primaryCookie, headers: { Origin: 'https://attacker.invalid' }, body: { userId: memberId },
}), 403, 'cross origin admin write blocked', 'ORIGIN_DENIED');
pass('cross-origin-admin-write-blocked');

const primaryOverview = expect(await request('/api/admin/overview', { cookie: primaryCookie }), 200, 'primary overview');
if (primaryOverview.payload.overview?.role !== 'primary' || !Array.isArray(primaryOverview.payload.overview?.staffCandidates)) {
  throw new Error('primary overview lacks primary-only controls');
}
pass('primary-overview');

const primaryMemberDetail = expect(await request(`/api/admin/members/${encodeURIComponent(memberId)}`, { cookie: primaryCookie }), 200, 'primary member detail');
if (
  primaryMemberDetail.payload.member?.email !== memberEmail
  || primaryMemberDetail.payload.member?.displayName !== '권한검수 회원'
  || !primaryMemberDetail.payload.member?.consent?.termsAcceptedAt
  || primaryMemberDetail.payload.member?.passwordHash !== undefined
  || primaryMemberDetail.payload.member?.passwordSalt !== undefined
) {
  throw new Error(`primary member detail response invalid: ${JSON.stringify(primaryMemberDetail.payload)}`);
}
pass('primary-member-detail');

expect(await request('/api/admin/deputies', {
  method: 'POST', cookie: primaryCookie, body: { userId: bootstrap.payload.admin.id },
}), 409, 'primary protected from deputy appointment', 'PRIMARY_PROTECTED');
expect(await request(`/api/admin/deputies/${encodeURIComponent(bootstrap.payload.admin.id)}/revoke`, {
  method: 'POST', cookie: primaryCookie, body: {},
}), 409, 'primary protected from revoke', 'DEPUTY_REQUIRED');
pass('primary-account-protected');

expect(await request('/api/admin/deputies', {
  method: 'POST', cookie: primaryCookie, body: { userId: memberId },
}), 200, 'appoint deputy');
pass('deputy-appointed');

const deputyMe = expect(await request('/api/me', { cookie: memberCookie }), 200, 'deputy me');
if (deputyMe.payload.user?.adminRole !== 'deputy') throw new Error('deputy role was not applied to existing session');
pass('deputy-role-visible');

const deputyOverview = expect(await request('/api/admin/overview', { cookie: memberCookie }), 200, 'deputy overview');
const deputy = deputyOverview.payload.overview;
if (
  deputy?.role !== 'deputy'
  || deputy?.money !== null
  || (deputy?.recentAudit || []).length
  || (deputy?.recentUsers || []).length
  || (deputy?.openDisputes || []).length
  || (deputy?.pendingSettlements || []).length
  || (deputy?.staffCandidates || []).length
  || (deputy?.staffMembers || []).length
) {
  throw new Error(`deputy response exposed restricted data: ${JSON.stringify(deputy)}`);
}
pass('deputy-readonly-minimum-response');

expect(await request('/api/admin/deputies', {
  method: 'POST', cookie: memberCookie, body: { userId: memberId },
}), 403, 'deputy appoint blocked', 'PRIMARY_ADMIN_REQUIRED');
expect(await request(`/api/admin/deputies/${encodeURIComponent(memberId)}/revoke`, {
  method: 'POST', cookie: memberCookie, body: {},
}), 403, 'deputy revoke blocked', 'PRIMARY_ADMIN_REQUIRED');
expect(await request('/api/admin/strikes', {
  method: 'POST', cookie: memberCookie, body: {},
}), 403, 'deputy strike blocked', 'PRIMARY_ADMIN_REQUIRED');
expect(await request(`/api/admin/members/${encodeURIComponent(memberId)}`, {
  cookie: memberCookie,
}), 403, 'deputy member detail blocked', 'PRIMARY_ADMIN_REQUIRED');
pass('deputy-privileged-api-blocked');

expect(await request(`/api/admin/deputies/${encodeURIComponent(memberId)}/revoke`, {
  method: 'POST', cookie: primaryCookie, body: {},
}), 200, 'revoke deputy');
const memberAfterRevoke = expect(await request('/api/me', { cookie: memberCookie }), 200, 'member role after revoke');
if (memberAfterRevoke.payload.user?.adminRole !== 'member') throw new Error('revoked deputy retained an admin role');
expect(await request('/api/admin/overview', { cookie: memberCookie }), 403, 'revoked deputy overview blocked', 'ADMIN_REQUIRED');
pass('deputy-revoked');

const auditOverview = expect(await request('/api/admin/overview', { cookie: primaryCookie }), 200, 'primary audit overview');
const actions = (auditOverview.payload.overview?.recentAudit || []).map((item) => item.action);
for (const action of ['ADMIN_BOOTSTRAP', 'ADMIN_MEMBER_DETAIL_VIEW', 'DEPUTY_ADMIN_APPOINT', 'DEPUTY_ADMIN_REVOKE']) {
  if (!actions.includes(action)) throw new Error(`missing audit action: ${action}`);
}
pass('role-audit-records');

console.log(JSON.stringify({ ok: true, checks, primaryId: bootstrap.payload.admin.id, memberId }));
