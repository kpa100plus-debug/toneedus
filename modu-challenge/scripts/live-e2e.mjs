import { randomUUID, webcrypto } from 'node:crypto';

const origin = process.env.MODU_ORIGIN || 'https://modu-challenge.yeit.workers.dev';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const password = `E2e${suffix}Pass9`;
const ownerEmail = `e2e-owner-${suffix}@demo.invalid`;
const solverEmail = `e2e-solver-${suffix}@demo.invalid`;
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

async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return {
    status: response.status,
    payload,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
    security: {
      contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
    },
  };
}

function expect(result, status, label) {
  if (result.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${result.status} ${JSON.stringify(result.payload)}`);
  }
  return result;
}

const checks = [];
function mark(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

const ownerMaterial = await passwordMaterial(password);
const ownerSignup = expect(await request('/api/auth/signup', {
  method: 'POST',
  body: {
    displayName: 'E2E 개설자', email: ownerEmail, accountType: 'corporation',
    ...ownerMaterial, termsAccepted: true, privacyAccepted: true,
  },
}), 201, 'owner signup');
mark('owner-signup');

expect(await request('/api/auth/logout', { method: 'POST', body: {}, cookie: ownerSignup.cookie }), 200, 'owner logout');
mark('owner-logout');

const loginOptions = expect(await request('/api/auth/login-options', {
  method: 'POST', body: { email: ownerEmail },
}), 200, 'login options');
if (loginOptions.payload.iterations !== 210_000 || !loginOptions.payload.salt) throw new Error('invalid login options');
const ownerLoginMaterial = await passwordMaterial(password, loginOptions.payload.salt);
const ownerLogin = expect(await request('/api/auth/login', {
  method: 'POST', body: { email: ownerEmail, passwordVerifier: ownerLoginMaterial.passwordVerifier },
}), 200, 'owner login');
mark('owner-login');

const challenge = expect(await request('/api/challenges', {
  method: 'POST', cookie: ownerLogin.cookie,
  body: {
    title: 'E2E 자동 검수용 챌린지',
    summary: '자동 검수가 끝나면 즉시 제거되는 임시 챌린지입니다.',
    description: '회원가입, 로그인, 챌린지 등록, TEASER, 후보선정과 결제 차단을 검증하기 위한 자동 테스트입니다.',
    category: 'IDEA', region: '전국·온라인', rewardAmount: 100000,
    successCriteria: '정해진 API 흐름이 모두 예상 상태코드로 완료되면 성공입니다.',
    paymentTrigger: '최종 후보가 선택되고 사전 운영 결제 게이트가 확인된 시점입니다.',
    evidenceRequirements: '자동 테스트 결과와 상태코드 기록',
    deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
    visibility: 'public',
  },
}), 201, 'challenge create');
const challengeId = challenge.payload.challenge.id;
mark('challenge-create');

const solverMaterial = await passwordMaterial(password);
const solverSignup = expect(await request('/api/auth/signup', {
  method: 'POST',
  body: {
    displayName: 'E2E 참여자', email: solverEmail, accountType: 'individual',
    ...solverMaterial, termsAccepted: true, privacyAccepted: true,
  },
}), 201, 'solver signup');
mark('solver-signup');

const teaser = expect(await request(`/api/challenges/${challengeId}/teasers`, {
  method: 'POST', cookie: solverSignup.cookie,
  body: {
    headline: '자동 검수 흐름을 안전하게 완료할 수 있습니다',
    capability: '실제 서비스 API의 회원·챌린지·TEASER 연동을 검증하는 자동 테스트 계정입니다.',
    approach: '등록 후 개설자 계정에서 후보 목록을 조회하고 SHORTLIST 처리 결과를 확인합니다.',
    expectedDays: 3,
    maskedEvidence: '검수 완료 후 모든 임시 레코드를 삭제합니다.',
    qualificationType: '자동 E2E 검수',
  },
}), 201, 'teaser submit');
mark('teaser-submit');

const teaserList = expect(await request(`/api/challenges/${challengeId}/teasers`, {
  cookie: ownerLogin.cookie,
}), 200, 'teaser list');
if (teaserList.payload.teasers?.length !== 1) throw new Error('owner teaser list mismatch');
mark('owner-teaser-list');

expect(await request(`/api/challenges/${challengeId}/shortlist`, {
  method: 'POST', cookie: ownerLogin.cookie,
  body: { teaserId: teaser.payload.teaser.id, mode: 'shortlist' },
}), 200, 'shortlist');
mark('shortlist');

const moneyBlocked = expect(await request(`/api/challenges/${challengeId}/shortlist`, {
  method: 'POST', cookie: ownerLogin.cookie,
  body: { teaserId: teaser.payload.teaser.id, mode: 'select' },
}), 503, 'money gate');
if (moneyBlocked.payload.error?.code !== 'MONEY_FLOW_DISABLED') throw new Error('money gate code mismatch');
mark('money-flow-disabled');

const detail = expect(await request(`/api/challenges/${challengeId}`), 200, 'public detail');
if (detail.payload.challenge.status !== 'SHORTLISTED' || detail.payload.challenge.teaserCount !== 1) {
  throw new Error('public detail state mismatch');
}
mark('public-detail');

expect(await request(`/api/challenges/${challengeId}/cancel`, {
  method: 'POST', cookie: ownerLogin.cookie,
  body: { reason: '자동 E2E 검수가 완료되어 임시 챌린지를 정리합니다.' },
}), 200, 'challenge cancel');
mark('challenge-cancel');

console.log(JSON.stringify({
  ok: true,
  checks,
  cleanup: { challengeId, ownerId: ownerSignup.payload.user.id, solverId: solverSignup.payload.user.id },
}));
