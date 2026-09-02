import { calculateSettlement, calculateStrikeOutcome } from '../public/assets/business-rules.js';

/**
 * 모두의 챌린지 API Worker
 * © 2026 ISEA GROUP. All Rights Reserved.
 *
 * Cloudflare Workers + D1. No third-party runtime dependency.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = 'mc_session';
const MAX_JSON_BYTES = 64 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CATEGORIES = new Set(['CONNECT', 'FIND', 'IDEA', 'BUSINESS', 'ACTION', 'LOCAL', 'SOCIAL', 'PUBLIC']);
const PASSWORD_KDF_ITERATIONS = 210_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_VERIFIER_BYTES = 32;
const PASSWORD_HASH_PREFIX = 'v3$';
const REGIONS = new Set(['전국', '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '해외']);
const CHALLENGE_INTENTS = new Set(['owner', 'solver', 'both']);
const GENDERS = new Set(['female', 'male']);


function environmentName(env) {
  return String(env.APP_ENV || 'unknown').trim().toLowerCase();
}

function isLocalMoneySimulation(env) {
  return ['development', 'test'].includes(environmentName(env));
}

function isPublicMoneyEnabled(env) {
  return String(env.PUBLIC_MONEY_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function isMoneyFlowAvailable(env) {
  return isPublicMoneyEnabled(env) || isLocalMoneySimulation(env);
}

function moneyFlowMode(env) {
  if (isPublicMoneyEnabled(env)) return 'live';
  if (isLocalMoneySimulation(env)) return 'simulation';
  return 'disabled';
}

function moneyFlowGuard(env, message) {
  if (isMoneyFlowAvailable(env)) return null;
  return problem(503, 'MONEY_FLOW_DISABLED', message);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: apiHeaders() });
    }

    const originError = enforceSameOrigin(request, url);
    if (originError) return originError;

    try {
      return await route(request, env, ctx, url);
    } catch (error) {
      console.error('Unhandled API error', error);
      return problem(500, 'INTERNAL_ERROR', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processOverdueFunding(env));
  },
};

async function route(request, env, ctx, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'GET' && path === '/api/config') {
    return json(publicConfig(env), 200, {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    });
  }

  if (method === 'GET' && path === '/api/health') {
    return json(publicHealth(env));
  }

  if (method === 'GET' && path === '/api/bootstrap') return publicBootstrap(url, env);

  if (method === 'POST' && path === '/api/internal/bootstrap-admin') return bootstrapAdmin(request, env);
  if (method === 'POST' && path === '/api/internal/payout/confirm') return confirmPayoutWebhook(request, env);

  if (method === 'POST' && path === '/api/auth/signup') return signup(request, env);
  if (method === 'POST' && path === '/api/auth/login-options') return loginOptions(request, env);
  if (method === 'POST' && path === '/api/auth/login') return login(request, env);
  if (method === 'POST' && path === '/api/auth/verify-email') return verifyEmail(request, env);
  if (method === 'POST' && path === '/api/auth/resend-verification') return resendEmailVerification(request, env);
  if (method === 'POST' && path === '/api/auth/find-email') return findAccountEmail(request, env);
  if (method === 'POST' && path === '/api/auth/request-password-reset') return requestPasswordReset(request, env);
  if (method === 'POST' && path === '/api/auth/reset-password') return resetPassword(request, env);
  if (method === 'POST' && path === '/api/auth/recover-primary') return recoverPrimaryAdmin(request, env);
  if (method === 'POST' && path === '/api/auth/logout') return logout(request, env);
  if (method === 'POST' && path === '/api/auth/change-password') return changePassword(request, env);
  if (method === 'GET' && path === '/api/me') return me(request, env);
  if (method === 'GET' && path === '/api/me/activity') return meActivity(request, env);

  let match = path.match(/^\/api\/auth\/oauth\/(google|naver)$/);
  if (match && method === 'GET') return startOAuth(match[1], request, env, url);

  match = path.match(/^\/api\/auth\/oauth\/(google|naver)\/callback$/);
  if (match && method === 'GET') return finishOAuth(match[1], request, env, url);

  match = path.match(/^\/api\/me\/notifications\/([^/]+)\/read$/);
  if (match && method === 'POST') return markNotificationRead(match[1], request, env);

  if (method === 'GET' && path === '/api/challenges') return listChallenges(url, env);
  if (method === 'POST' && path === '/api/challenges') return createChallenge(request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)$/);
  if (match && method === 'GET') return getChallenge(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/cancel$/);
  if (match && method === 'POST') return cancelChallenge(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/disputes$/);
  if (match && method === 'POST') return openDispute(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/teasers$/);
  if (match && method === 'POST') return submitTeaser(match[1], request, env);
  if (match && method === 'GET') return listTeasers(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/shortlist$/);
  if (match && method === 'POST') return shortlistTeaser(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/funding\/request$/);
  if (match && method === 'POST') return requestFunding(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/funding\/confirm$/);
  if (match && method === 'POST') return confirmFunding(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/proof$/);
  if (match && method === 'POST') return submitProof(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/success$/);
  if (match && method === 'POST') return confirmSuccess(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/reviews$/);
  if (match && method === 'POST') return createReview(match[1], request, env);

  match = path.match(/^\/api\/users\/([^/]+)\/trust$/);
  if (match && method === 'GET') return getTrustProfile(match[1], env);

  if (method === 'GET' && path === '/api/admin/overview') return adminOverview(request, env);

  match = path.match(/^\/api\/admin\/challenges\/([^/]+)\/moderation\/approve$/);
  if (match && method === 'POST') return approveModerationChallenge(match[1], request, env);

  match = path.match(/^\/api\/admin\/members\/([^/]+)$/);
  if (match && method === 'GET') return getAdminMemberDetail(match[1], request, env);

  if (method === 'POST' && path === '/api/admin/deputies') return appointDeputy(request, env);

  match = path.match(/^\/api\/admin\/deputies\/([^/]+)\/revoke$/);
  if (match && method === 'POST') return revokeDeputy(match[1], request, env);

  if (method === 'POST' && path === '/api/admin/strikes') return issueStrike(request, env);

  match = path.match(/^\/api\/admin\/strikes\/([^/]+)\/revoke$/);
  if (match && method === 'POST') return revokeStrike(match[1], request, env);

  return problem(404, 'NOT_FOUND', '요청한 API를 찾을 수 없습니다.');
}

/* -------------------------------------------------------------------------- */
/* Authentication                                                             */
/* -------------------------------------------------------------------------- */

async function bootstrapAdmin(request, env) {
  const expected = String(env.ADMIN_BOOTSTRAP_TOKEN || '');
  if (!expected) return problem(404, 'NOT_FOUND', '요청한 API를 찾을 수 없습니다.');
  const provided = String(request.headers.get('X-Bootstrap-Token') || '');
  if (!constantTimeEqual(provided, expected)) return problem(403, 'BOOTSTRAP_DENIED', '관리자 초기화 권한이 없습니다.');
  await ensureAdminRoleStorage(env);

  const existing = await env.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE is_admin = 1').first();
  if (Number(existing?.count || 0) > 0) return problem(409, 'ADMIN_EXISTS', '관리자 계정이 이미 존재합니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  const displayName = cleanText(body.displayName, 2, 40) || 'MODU MEMBER';
  const passwordSalt = canonicalPasswordMaterial(body.passwordSalt, PASSWORD_SALT_BYTES);
  const passwordVerifier = canonicalPasswordMaterial(body.passwordVerifier, PASSWORD_VERIFIER_BYTES);
  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '올바른 관리자 이메일을 입력해주세요.');
  if (!passwordSalt || !passwordVerifier) {
    return problem(400, 'INVALID_PASSWORD_MATERIAL', '안전한 관리자 로그인 자료를 확인하지 못했습니다.');
  }

  const id = makeId('usr');
  const passwordHash = await hashPasswordVerifier(passwordVerifier);
  await env.DB.prepare(`
    INSERT INTO users (
      id, email, password_hash, password_salt, display_name, account_type,
      status, is_admin, identity_verified, business_verified, trust_score,
      bounty_limit, terms_version, terms_accepted_at, privacy_version, privacy_accepted_at
    ) VALUES (?, ?, ?, ?, ?, 'corporation', 'active', 1, 1, 1, 100, 1000000000, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
  `).bind(id, email, passwordHash, passwordSalt, displayName,
    env.TERMS_VERSION || '2026-08-28-v1', env.PRIVACY_VERSION || '2026-08-31-v2').run();
  await env.DB.prepare("INSERT INTO admin_roles (user_id, role, appointed_by) VALUES (?, 'primary', ?)")
    .bind(id, id).run();
  await audit(env, id, 'ADMIN_BOOTSTRAP', 'user', id, null, { email });
  return json({ ok: true, admin: { id, email, displayName } }, 201);
}

async function signup(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const email = normalizeEmail(body.email);
  const displayName = cleanText(body.displayName, 2, 40);
  const passwordSalt = canonicalPasswordMaterial(body.passwordSalt, PASSWORD_SALT_BYTES);
  const passwordVerifier = canonicalPasswordMaterial(body.passwordVerifier, PASSWORD_VERIFIER_BYTES);
  const accountType = ['individual', 'business', 'corporation', 'organization'].includes(body.accountType)
    ? body.accountType
    : 'individual';
  const phone = normalizePhone(body.phone);
  const region = cleanText(body.region, 2, 20);
  const challengeIntent = String(body.challengeIntent || 'both');
  const birthYear = optionalBirthYear(body.birthYear);
  const gender = GENDERS.has(body.gender) ? body.gender : '';
  const interests = cleanText(body.interests, 0, 300);
  const organizationName = cleanText(body.organizationName, 0, 100);
  const marketingAccepted = body.marketingAccepted === true;

  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '올바른 이메일을 입력해주세요.');
  if (!displayName) return problem(400, 'INVALID_NAME', '이름 또는 활동명을 2자 이상 입력해주세요.');
  if (!phone) return problem(400, 'INVALID_PHONE', '연락 가능한 휴대전화 번호를 입력해주세요.');
  if (!REGIONS.has(region)) return problem(400, 'INVALID_REGION', '활동 지역을 선택해주세요.');
  if (!CHALLENGE_INTENTS.has(challengeIntent)) return problem(400, 'INVALID_CHALLENGE_INTENT', '참여 목적을 선택해주세요.');
  if (!birthYear) return problem(400, 'INVALID_BIRTH_YEAR', '출생연도 네 자리를 입력해주세요.');
  if (!gender) return problem(400, 'INVALID_GENDER', '성별을 선택해주세요.');
  if (!passwordSalt || !passwordVerifier) {
    return problem(400, 'INVALID_PASSWORD_MATERIAL', '안전한 로그인 자료를 확인하지 못했습니다.');
  }
  if (body.termsAccepted !== true || body.privacyAccepted !== true) {
    return problem(400, 'CONSENT_REQUIRED', '이용약관과 개인정보처리방침에 동의해야 가입할 수 있습니다.');
  }

  const rate = await checkAuthRateLimit(request, env, 'SIGNUP', email);
  if (rate instanceof Response) return rate;
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) {
    await recordAuthAttempt(env, 'SIGNUP', rate, false);
    return problem(409, 'EMAIL_EXISTS', '이미 가입된 이메일입니다.');
  }

  const id = makeId('usr');
  const passwordHash = await hashPasswordVerifier(passwordVerifier);
  const defaultLimit = parsePositiveInt(env.OWNER_DEFAULT_BOUNTY_LIMIT, 1_000_000);

  const verificationRequired = emailVerificationEnabled(env);
  await env.DB.prepare(`
    INSERT INTO users (
      id, email, password_hash, password_salt, display_name, account_type,
      identity_verified, trust_score, bounty_limit,
      terms_version, terms_accepted_at, privacy_version, privacy_accepted_at,
      phone, region, challenge_intent, birth_year, gender, interests, organization_name,
      marketing_consent, marketing_consent_at, signup_source, email_verification_requested_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 50, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, email, passwordHash, passwordSalt, displayName, accountType, defaultLimit,
    env.TERMS_VERSION || '2026-08-28-v1', env.PRIVACY_VERSION || '2026-08-31-v2',
    phone, region, challengeIntent, birthYear, gender, interests || null, organizationName || null,
    marketingAccepted ? 1 : 0, marketingAccepted ? new Date().toISOString() : null, 'password',
    verificationRequired ? new Date().toISOString() : null).run();

  await recordAuthAttempt(env, 'SIGNUP', rate, true);
  await audit(env, id, 'USER_SIGNUP', 'user', id, null, { email, accountType, region, challengeIntent, verificationRequired });

  if (verificationRequired) {
    const sent = await issueEmailVerification(env, request, { id, email, displayName });
    if (!sent.ok) return problem(503, 'EMAIL_DELIVERY_UNAVAILABLE', '인증메일을 보내지 못했습니다. 잠시 후 다시 시도해주세요.');
    return json({ ok: true, pendingVerification: true, email });
  }

  const session = await createSession(id, request, env);

  return json({ user: publicUser({
    id, email, display_name: displayName, account_type: accountType,
    status: 'active', is_admin: 0, identity_verified: 0,
    business_verified: 0, professional_verified: 0, trust_score: 50,
    strike_count: 0, bounty_limit: defaultLimit, email_verified: 0,
  }) }, 201, { 'Set-Cookie': session.cookie });
}

async function verifyEmail(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const token = String(body.token || '');
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) return problem(400, 'INVALID_VERIFICATION_TOKEN', '인증 링크가 올바르지 않습니다.');
  const verification = await env.DB.prepare(`
    SELECT id, user_id FROM email_verifications
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
  `).bind(await sha256(token)).first();
  if (!verification) return problem(400, 'VERIFICATION_EXPIRED', '인증 링크가 만료되었거나 이미 사용되었습니다.');
  await env.DB.batch([
    env.DB.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(verification.id),
    env.DB.prepare('UPDATE users SET email_verified = 1, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(verification.user_id),
    auditStatement(env, verification.user_id, 'EMAIL_VERIFIED', 'user', verification.user_id, null, { method: 'email-link' }),
  ]);
  return json({ ok: true });
}

async function resendEmailVerification(request, env) {
  if (!emailVerificationEnabled(env)) return problem(503, 'EMAIL_VERIFICATION_UNAVAILABLE', '이메일 인증 설정을 준비하고 있습니다.');
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '올바른 이메일을 입력해주세요.');
  const rate = await checkAuthRateLimit(request, env, 'SIGNUP', email);
  if (rate instanceof Response) return rate;
  const user = await env.DB.prepare('SELECT id, email, display_name, email_verified, email_verification_requested_at FROM users WHERE email = ?').bind(email).first();
  if (!user || user.email_verified || !user.email_verification_requested_at) return json({ ok: true });
  const sent = await issueEmailVerification(env, request, user);
  await recordAuthAttempt(env, 'SIGNUP', rate, sent.ok);
  if (!sent.ok) return problem(503, 'EMAIL_DELIVERY_UNAVAILABLE', '인증메일을 보내지 못했습니다. 잠시 후 다시 시도해주세요.');
  return json({ ok: true });
}

async function findAccountEmail(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const displayName = cleanText(body.displayName, 2, 40);
  const phone = normalizePhone(body.phone);
  if (!displayName || !phone) return problem(400, 'ACCOUNT_LOOKUP_REQUIRED', '가입할 때 입력한 이름·활동명과 휴대전화를 모두 입력해주세요.');

  const rate = await checkAuthRateLimit(request, env, 'LOGIN', `find-email:${phone}`);
  if (rate instanceof Response) return rate;
  const user = await env.DB.prepare(`
    SELECT email FROM users
    WHERE lower(trim(display_name)) = lower(?)
      AND replace(replace(replace(phone, '-', ''), ' ', ''), '+82', '0') = ?
    LIMIT 1
  `).bind(displayName, phone).first();
  await recordAuthAttempt(env, 'LOGIN', rate, Boolean(user));
  if (!user?.email) return json({ found: false });
  return json({ found: true, emailHint: maskEmail(user.email) });
}

async function requestPasswordReset(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '가입 이메일을 정확히 입력해주세요.');
  const rate = await checkAuthRateLimit(request, env, 'LOGIN', `password-reset:${email}`);
  if (rate instanceof Response) return rate;

  const user = await env.DB.prepare('SELECT id, email, display_name, status FROM users WHERE email = ?').bind(email).first();
  let sent = false;
  if (user && ['active', 'limited'].includes(user.status)) sent = (await issuePasswordReset(env, request, user)).ok;
  await recordAuthAttempt(env, 'LOGIN', rate, sent);
  // Keep this response neutral so email addresses cannot be enumerated.
  return json({ ok: true });
}

async function resetPassword(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const token = String(body.token || '');
  const passwordSalt = canonicalPasswordMaterial(body.passwordSalt, PASSWORD_SALT_BYTES);
  const passwordVerifier = canonicalPasswordMaterial(body.passwordVerifier, PASSWORD_VERIFIER_BYTES);
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) return problem(400, 'INVALID_RESET_TOKEN', '비밀번호 재설정 링크가 올바르지 않습니다.');
  if (!passwordSalt || !passwordVerifier) return problem(400, 'INVALID_PASSWORD_MATERIAL', '안전한 비밀번호 설정 정보를 확인하지 못했습니다.');

  const reset = await env.DB.prepare(`
    SELECT r.id AS reset_id, r.user_id, u.* FROM password_resets r
    JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > CURRENT_TIMESTAMP
  `).bind(await sha256(token)).first();
  if (!reset) return problem(400, 'RESET_EXPIRED', '비밀번호 재설정 링크가 만료되었거나 이미 사용되었습니다. 다시 요청해주세요.');

  const passwordHash = await hashPasswordVerifier(passwordVerifier);
  await env.DB.batch([
    env.DB.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(reset.reset_id),
    env.DB.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').bind(reset.user_id),
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, status = \'active\', updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(passwordHash, passwordSalt, reset.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(reset.user_id),
    auditStatement(env, reset.user_id, 'PASSWORD_RESET', 'user', reset.user_id, null, { method: 'email-link', sessionsSignedOut: true }),
  ]);
  const session = await createSession(reset.user_id, request, env);
  const restoredUser = { ...reset, password_hash: passwordHash, password_salt: passwordSalt, status: 'active' };
  return json({ user: publicUser(restoredUser), otherSessionsSignedOut: true }, 200, { 'Set-Cookie': session.cookie });
}

async function issueEmailVerification(env, request, user) {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verificationId = makeId('emv');
  await env.DB.batch([
    env.DB.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').bind(user.id),
    env.DB.prepare(`INSERT INTO email_verifications (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, datetime('now', '+24 hours'))`).bind(verificationId, user.id, await sha256(token)),
  ]);
  const origin = new URL(request.url).origin;
  const verificationUrl = `${origin}/#/verify-email?token=${encodeURIComponent(token)}`;
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': String(env.BREVO_API_KEY) },
    body: JSON.stringify({
      sender: { name: '모두의 챌린지', email: String(env.BREVO_SENDER_EMAIL) },
      to: [{ email: user.email, name: user.display_name }],
      subject: '[모두의 챌린지] 이메일 인증을 완료해주세요',
      htmlContent: `<p>${escapeEmailHtml(user.display_name)}님, 모두의 챌린지 가입을 완료하려면 아래 버튼을 눌러주세요.</p><p><a href="${verificationUrl}">이메일 인증 완료</a></p><p>이 링크는 24시간 동안 유효합니다.</p>`,
    }),
  }).catch(() => null);
  return { ok: Boolean(response?.ok) };
}

async function issuePasswordReset(env, request, user) {
  if (!emailVerificationEnabled(env)) return { ok: false };
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const resetId = makeId('pwr');
  await env.DB.batch([
    env.DB.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').bind(user.id),
    env.DB.prepare(`INSERT INTO password_resets (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, datetime('now', '+30 minutes'))`).bind(resetId, user.id, await sha256(token)),
  ]);
  const origin = new URL(request.url).origin;
  const resetUrl = `${origin}/#/reset-password?token=${encodeURIComponent(token)}`;
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': String(env.BREVO_API_KEY) },
    body: JSON.stringify({
      sender: { name: '모두의 챌린지', email: String(env.BREVO_SENDER_EMAIL) },
      to: [{ email: user.email, name: user.display_name }],
      subject: '[모두의 챌린지] 비밀번호 재설정',
      htmlContent: `<p>${escapeEmailHtml(user.display_name)}님, 아래 버튼을 눌러 비밀번호를 새로 설정해주세요.</p><p><a href="${resetUrl}">비밀번호 새로 설정하기</a></p><p>이 링크는 30분 동안 유효하며, 사용하면 기존 로그인은 해제됩니다.</p>`,
    }),
  }).catch(() => null);
  return { ok: Boolean(response?.ok) };
}

function emailVerificationEnabled(env) {
  return Boolean(String(env.BREVO_API_KEY || '').trim() && EMAIL_RE.test(String(env.BREVO_SENDER_EMAIL || '').trim()));
}

function oauthConfig(provider, env) {
  if (provider === 'google') {
    const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
    const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  if (provider === 'naver') {
    const clientId = String(env.NAVER_OAUTH_CLIENT_ID || '').trim();
    const clientSecret = String(env.NAVER_OAUTH_CLIENT_SECRET || '').trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  return null;
}

async function fetchOAuthProfile(provider, config, code, redirectUri, state) {
  const tokenUrl = provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://nid.naver.com/oauth2.0/token';
  const tokenBody = provider === 'google'
    ? { code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }
    : { grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code, state };
  const tokenResponse = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(tokenBody) }).catch(() => null);
  const token = tokenResponse?.ok ? await tokenResponse.json().catch(() => null) : null;
  if (!token?.access_token) return null;
  if (provider === 'google') {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } }).catch(() => null);
    const data = response?.ok ? await response.json().catch(() => null) : null;
    if (!data?.sub || !data?.email || data.email_verified !== true) return null;
    return { subject: String(data.sub), email: normalizeEmail(data.email), displayName: cleanText(data.name || data.given_name, 2, 40) || 'Google 회원' };
  }
  const response = await fetch('https://openapi.naver.com/v1/nid/me', { headers: { Authorization: `Bearer ${token.access_token}` } }).catch(() => null);
  const data = response?.ok ? await response.json().catch(() => null) : null;
  const profile = data?.response;
  if (!profile?.id || !profile?.email) return null;
  return { subject: String(profile.id), email: normalizeEmail(profile.email), displayName: cleanText(profile.name || profile.nickname, 2, 40) || 'NAVER 회원' };
}

async function findOrCreateOAuthUser(env, provider, profile) {
  let identity = await env.DB.prepare('SELECT user_id FROM auth_identities WHERE provider = ? AND provider_subject = ?').bind(provider, profile.subject).first();
  if (identity?.user_id) return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(identity.user_id).first();
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(profile.email).first();
  if (!user) return null;
  await env.DB.prepare(`INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, last_login_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, provider_subject) DO UPDATE SET user_id = excluded.user_id, provider_email = excluded.provider_email, last_login_at = CURRENT_TIMESTAMP`)
    .bind(makeId('oid'), user.id, provider, profile.subject, profile.email).run();
  return user;
}

function oauthCompletionPage(request, { target, cookie = '' }) {
  // Safari can reject a redirect response from an OAuth callback when a PWA
  // service worker is active. Return a short no-store document instead, then
  // continue on the same origin without losing the newly issued session.
  const destination = new URL(target, new URL(request.url).origin).href;
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${escapeHtmlAttribute(destination)}"><title>모두의 챌린지</title></head><body><p>모두의 챌린지로 돌아가는 중입니다…</p><script>location.replace(${JSON.stringify(destination)});</script></body></html>`, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Referrer-Policy': 'no-referrer',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  });
}

function oauthFailure(request, message) {
  const origin = new URL(request.url).origin;
  const cookie = `mc_oauth_state=; Path=/api/auth/oauth/; HttpOnly${cookieSecureAttribute(request)}; SameSite=Lax; Max-Age=0`;
  return oauthCompletionPage(request, {
    target: `${origin}/#/home?oauth_error=${encodeURIComponent(message)}`,
    cookie,
  });
}

async function startOAuth(provider, request, env, url) {
  const config = oauthConfig(provider, env);
  if (!config) return problem(404, 'OAUTH_UNAVAILABLE', '소셜 로그인을 준비하고 있습니다.');
  const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const redirectUri = `${url.origin}/api/auth/oauth/${provider}/callback`;
  await env.DB.prepare(`INSERT INTO oauth_authorizations (id, provider, state_hash, expires_at)
    VALUES (?, ?, ?, datetime('now', '+10 minutes'))`).bind(makeId('oas'), provider, await sha256(state)).run();
  const params = new URLSearchParams(provider === 'google'
    ? { client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' }
    : { response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, state });
  const authorizeUrl = provider === 'google'
    ? `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    : `https://nid.naver.com/oauth2.0/authorize?${params}`;
  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl, 'Set-Cookie': `mc_oauth_state=${state}; Path=/api/auth/oauth/; HttpOnly${cookieSecureAttribute(request)}; SameSite=Lax; Max-Age=600` },
  });
}

async function finishOAuth(provider, request, env, url) {
  const config = oauthConfig(provider, env);
  const state = String(url.searchParams.get('state') || '');
  const cookieState = cookieValue(request.headers.get('Cookie'), 'mc_oauth_state');
  const code = String(url.searchParams.get('code') || '');
  if (!config || !code || !state || !constantTimeEqual(state, cookieState)) return oauthFailure(request, '소셜 로그인 확인이 만료되었습니다. 다시 시도해주세요.');
  const authorization = await env.DB.prepare(`SELECT id FROM oauth_authorizations
    WHERE provider = ? AND state_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).bind(provider, await sha256(state)).first();
  if (!authorization) return oauthFailure(request, '소셜 로그인 확인이 만료되었습니다. 다시 시도해주세요.');
  await env.DB.prepare('UPDATE oauth_authorizations SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(authorization.id).run();
  const profile = await fetchOAuthProfile(provider, config, code, `${url.origin}/api/auth/oauth/${provider}/callback`, state);
  if (!profile) return oauthFailure(request, '소셜 계정의 이메일 정보를 확인하지 못했습니다.');
  const user = await findOrCreateOAuthUser(env, provider, profile);
  if (!user) return oauthFailure(request, '소셜 계정 이메일로 먼저 회원가입과 이메일 인증을 완료해주세요.');
  if (user.email_verification_requested_at && !user.email_verified) return oauthFailure(request, '가입 이메일 인증을 완료한 뒤 소셜 로그인을 사용할 수 있습니다.');
  const session = await createSession(user.id, request, env);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id),
    auditStatement(env, user.id, 'OAUTH_LOGIN', 'user', user.id, null, { provider }),
  ]);
  return oauthCompletionPage(request, {
    target: `${url.origin}/#/home?oauth=success`,
    cookie: session.cookie,
  });
}

async function loginOptions(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const email = normalizeEmail(body.email);
  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '올바른 이메일을 입력해주세요.');

  const user = await env.DB.prepare('SELECT password_salt FROM users WHERE email = ?').bind(email).first();
  const storedSalt = canonicalPasswordMaterial(user?.password_salt, PASSWORD_SALT_BYTES);
  const salt = storedSalt || await fallbackPasswordSalt(email);
  return json({ salt, iterations: PASSWORD_KDF_ITERATIONS }, 200, { 'Cache-Control': 'no-store' });
}

async function login(request, env) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const email = normalizeEmail(body.email);
  const passwordVerifier = canonicalPasswordMaterial(body.passwordVerifier, PASSWORD_VERIFIER_BYTES);
  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '올바른 이메일을 입력해주세요.');
  const rate = await checkAuthRateLimit(request, env, 'LOGIN', email);
  if (rate instanceof Response) return rate;
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const computed = passwordVerifier ? await hashPasswordVerifier(passwordVerifier) : '';

  if (!user || user.status === 'closed' || !computed || !constantTimeEqual(computed, user.password_hash)) {
    await recordAuthAttempt(env, 'LOGIN', rate, false);
    return problem(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');
  }

  if (user.status === 'suspended') {
    return problem(403, 'ACCOUNT_SUSPENDED', '이용이 정지된 계정입니다. 이의신청 절차를 확인해주세요.');
  }
  if (user.email_verification_requested_at && !user.email_verified) {
    return problem(403, 'EMAIL_UNVERIFIED', '이메일 인증을 완료한 뒤 로그인할 수 있습니다.');
  }

  await recordAuthAttempt(env, 'LOGIN', rate, true);
  const promotedUser = await reconcilePrimaryAdmin(user, env);
  await env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(promotedUser.id).run();
  const session = await createSession(promotedUser.id, request, env);
  await audit(env, promotedUser.id, 'USER_LOGIN', 'user', promotedUser.id, null, { success: true });
  return json({ user: publicUser(promotedUser) }, 200, { 'Set-Cookie': session.cookie });
}

async function recoverPrimaryAdmin(request, env) {
  const expectedToken = String(env.PRIMARY_ADMIN_RECOVERY_TOKEN || '');
  if (!expectedToken) return problem(404, 'RECOVERY_UNAVAILABLE', '관리자 계정 복구가 아직 준비되지 않았습니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  const primaryEmail = configuredPrimaryEmail(env);
  const recoveryToken = String(body.recoveryToken || '').trim();
  const passwordSalt = canonicalPasswordMaterial(body.passwordSalt, PASSWORD_SALT_BYTES);
  const passwordVerifier = canonicalPasswordMaterial(body.passwordVerifier, PASSWORD_VERIFIER_BYTES);

  if (!primaryEmail || email !== primaryEmail || !constantTimeEqual(recoveryToken, expectedToken)) {
    return problem(403, 'RECOVERY_DENIED', '관리자 계정 복구 정보를 확인할 수 없습니다.');
  }
  if (!passwordSalt || !passwordVerifier) {
    return problem(400, 'INVALID_PASSWORD_MATERIAL', '안전한 로그인 자료를 확인하지 못했습니다.');
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) return problem(404, 'ACCOUNT_NOT_FOUND', '복구할 관리자 계정을 찾을 수 없습니다.');

  await ensureAdminRoleStorage(env);
  const passwordHash = await hashPasswordVerifier(passwordVerifier);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, display_name = ?, status = \'active\', is_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(passwordHash, passwordSalt, 'SUPER ADMIN', user.id),
    env.DB.prepare("INSERT INTO admin_roles (user_id, role, appointed_by) VALUES (?, 'primary', ?) ON CONFLICT(user_id) DO UPDATE SET role = 'primary', appointed_by = excluded.appointed_by, appointed_at = CURRENT_TIMESTAMP")
      .bind(user.id, user.id),
    env.DB.prepare("UPDATE admin_roles SET role = 'deputy', appointed_by = ? WHERE user_id <> ? AND role = 'primary'").bind(user.id, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    auditStatement(env, user.id, 'PRIMARY_ADMIN_PASSWORD_RECOVERY', 'user', user.id, { adminRole: adminRole(user) }, { adminRole: 'primary', sessionsSignedOut: true }),
  ]);

  const recoveredUser = { ...user, status: 'active', is_admin: 1, admin_role: 'primary' };
  const session = await createSession(user.id, request, env);
  return json({ user: publicUser(recoveredUser), recovered: true }, 200, { 'Set-Cookie': session.cookie });
}

async function logout(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256(token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
  }
  const secure = cookieSecureAttribute(request);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`,
  });
}

async function changePassword(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const currentVerifier = canonicalPasswordMaterial(body.currentPasswordVerifier, PASSWORD_VERIFIER_BYTES);
  const newSalt = canonicalPasswordMaterial(body.newPasswordSalt, PASSWORD_SALT_BYTES);
  const newVerifier = canonicalPasswordMaterial(body.newPasswordVerifier, PASSWORD_VERIFIER_BYTES);
  if (!currentVerifier || !newSalt || !newVerifier) {
    return problem(400, 'INVALID_PASSWORD_MATERIAL', '비밀번호 변경 정보를 확인해주세요.');
  }
  const currentHash = await hashPasswordVerifier(currentVerifier);
  if (!constantTimeEqual(currentHash, user.password_hash)) {
    return problem(401, 'INVALID_CURRENT_PASSWORD', '현재 비밀번호가 올바르지 않습니다.');
  }
  const nextHash = await hashPasswordVerifier(newVerifier);
  if (constantTimeEqual(nextHash, user.password_hash)) {
    return problem(400, 'PASSWORD_UNCHANGED', '현재 비밀번호와 다른 비밀번호를 입력해주세요.');
  }
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  const tokenHash = token ? await sha256(token) : '';
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(nextHash, newSalt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(user.id, tokenHash),
    auditStatement(env, user.id, 'PASSWORD_CHANGE', 'user', user.id, null, { otherSessionsSignedOut: true }),
  ]);
  return json({ ok: true, otherSessionsSignedOut: true });
}

async function me(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (!token) return json({ user: null });
  const user = await requireAuth(request, env);
  if (user instanceof Response) {
    if (user.status === 401) {
      return json({ user: null }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly${cookieSecureAttribute(request)}; SameSite=Lax; Max-Age=0`,
      });
    }
    return user;
  }
  return json({ user: publicUser(user) });
}

async function meActivity(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;

  const [owned, applied, settlements, notifications] = await env.DB.batch([
    env.DB.prepare(`
      SELECT c.*, u.display_name AS owner_name, u.trust_score AS owner_trust,
             u.identity_verified, u.business_verified, u.professional_verified,
             u.strike_count AS owner_strikes
      FROM challenges c JOIN users u ON u.id = c.owner_id
      WHERE c.owner_id = ? ORDER BY c.created_at DESC LIMIT 100
    `).bind(user.id),
    env.DB.prepare(`
      SELECT t.id AS teaser_id, t.status AS teaser_status, t.headline,
             t.created_at AS teaser_created_at, c.*, u.display_name AS owner_name,
             u.trust_score AS owner_trust, u.identity_verified, u.business_verified,
             u.professional_verified, u.strike_count AS owner_strikes
      FROM teasers t
      JOIN challenges c ON c.id = t.challenge_id
      JOIN users u ON u.id = c.owner_id
      WHERE t.solver_id = ? ORDER BY t.created_at DESC LIMIT 100
    `).bind(user.id),
    env.DB.prepare(`
      SELECT challenge_id, gross_reward, platform_fee, solver_payout, status,
             funded_at, paid_at, created_at
      FROM settlements WHERE owner_id = ? OR solver_id = ?
      ORDER BY created_at DESC LIMIT 100
    `).bind(user.id, user.id),
    env.DB.prepare(`
      SELECT id, type, title, body, resource_type, resource_id, read_at, created_at
      FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).bind(user.id),
  ]);

  return json({
    user: publicUser(user),
    ownedChallenges: (owned.results || []).map(publicChallenge),
    applications: (applied.results || []).map((row) => ({
      teaserId: row.teaser_id,
      teaserStatus: row.teaser_status,
      teaserHeadline: row.headline,
      teaserCreatedAt: row.teaser_created_at,
      challenge: publicChallenge(row),
    })),
    settlements: settlements.results || [],
    notifications: notifications.results || [],
  });
}

async function markNotificationRead(notificationId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const notification = await env.DB.prepare(
    'SELECT id, resource_type, resource_id, read_at FROM notifications WHERE id = ? AND user_id = ?',
  ).bind(notificationId, user.id).first();
  if (!notification) return problem(404, 'NOTIFICATION_NOT_FOUND', '알림을 찾을 수 없습니다.');
  if (!notification.read_at) {
    await env.DB.prepare('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .bind(notificationId, user.id).run();
  }
  return json({ ok: true, resourceType: notification.resource_type, resourceId: notification.resource_id });
}

async function createSession(userId, request, env) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const tokenHash = await sha256(token);
  const days = parsePositiveInt(env.SESSION_TTL_DAYS, 30);
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  const sessionId = makeId('ses');
  const ipHash = await sha256(request.headers.get('CF-Connecting-IP') || 'unknown');
  const uaHash = await sha256(request.headers.get('User-Agent') || 'unknown');

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, ip_hash, user_agent_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(sessionId, userId, tokenHash, expiresAt, ipHash, uaHash).run();

  const maxAge = days * 86400;
  return {
    token,
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly${cookieSecureAttribute(request)}; SameSite=Lax; Max-Age=${maxAge}`,
  };
}

async function requireAuth(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (!token) return problem(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  const tokenHash = await sha256(token);
  await ensureAdminRoleStorage(env);
  const user = await env.DB.prepare(`
    SELECT u.*, COALESCE(ar.role, 'member') AS admin_role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN admin_roles ar ON ar.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
  `).bind(tokenHash).first();

  if (!user) return problem(401, 'SESSION_EXPIRED', '로그인이 만료되었습니다. 다시 로그인해주세요.');
  if (user.status === 'suspended' || user.status === 'closed') {
    return problem(403, 'ACCOUNT_RESTRICTED', '현재 이용할 수 없는 계정입니다.');
  }

  env.DB.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?')
    .bind(tokenHash).run().catch(() => undefined);
  return reconcilePrimaryAdmin(user, env);
}

async function requireAdmin(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  if (!user.is_admin) return problem(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
  return user;
}

async function requirePrimaryAdmin(request, env) {
  const user = await requireAdmin(request, env);
  if (user instanceof Response) return user;
  if (adminRole(user) !== 'primary') return problem(403, 'PRIMARY_ADMIN_REQUIRED', '최고관리자 권한이 필요합니다.');
  return user;
}

function configuredPrimaryEmail(env) {
  return normalizeEmail(env.PRIMARY_ADMIN_EMAIL || '');
}

function adminRole(user) {
  if (!user?.is_admin) return 'member';
  return user.admin_role === 'deputy' ? 'deputy' : 'primary';
}

async function ensureAdminRoleStorage(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_roles (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('primary', 'deputy')),
      appointed_by TEXT,
      appointed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (appointed_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_roles_role ON admin_roles(role)').run();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO admin_roles (user_id, role)
    SELECT id, 'deputy' FROM users WHERE is_admin = 1
  `).run();
}

async function reconcilePrimaryAdmin(user, env) {
  const primaryEmail = configuredPrimaryEmail(env);
  if (!primaryEmail || normalizeEmail(user.email) !== primaryEmail || user.admin_role === 'primary') return user;

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET is_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id),
    env.DB.prepare("INSERT INTO admin_roles (user_id, role, appointed_by) VALUES (?, 'primary', ?) ON CONFLICT(user_id) DO UPDATE SET role = 'primary', appointed_by = excluded.appointed_by, appointed_at = CURRENT_TIMESTAMP").bind(user.id, user.id),
    env.DB.prepare("UPDATE admin_roles SET role = 'deputy', appointed_by = ? WHERE user_id <> ? AND role = 'primary'").bind(user.id, user.id),
    auditStatement(env, user.id, 'PRIMARY_ADMIN_CLAIM', 'user', user.id, { adminRole: adminRole(user) }, { adminRole: 'primary' }),
  ]);
  return { ...user, is_admin: 1, admin_role: 'primary' };
}

/* -------------------------------------------------------------------------- */
/* Challenge                                                                  */
/* -------------------------------------------------------------------------- */

async function listChallenges(url, env) {
  const result = await queryChallenges(url, env);
  return json(result);
}

async function queryChallenges(url, env) {
  const category = (url.searchParams.get('category') || '').toUpperCase();
  const status = (url.searchParams.get('status') || '').toUpperCase();
  const q = cleanText(url.searchParams.get('q'), 0, 80);
  const sort = ['new', 'reward', 'deadline', 'popular'].includes(url.searchParams.get('sort'))
    ? url.searchParams.get('sort')
    : 'new';
  const limit = Math.min(parsePositiveInt(url.searchParams.get('limit'), 24), 50);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const where = ["c.visibility = 'public'", "c.status <> 'DRAFT'"];
  const binds = [];
  if (CATEGORIES.has(category)) { where.push('c.category = ?'); binds.push(category); }
  if (status) { where.push('c.status = ?'); binds.push(status); }
  else where.push("c.status <> 'CANCELLED'");
  if (q) {
    where.push('(c.title LIKE ? OR c.summary LIKE ? OR c.description LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like);
  }

  const orderBy = {
    new: 'c.created_at DESC',
    reward: 'c.reward_amount DESC, c.created_at DESC',
    deadline: 'c.deadline ASC',
    popular: '(c.view_count + c.teaser_count * 5) DESC, c.created_at DESC',
  }[sort];

  const statement = env.DB.prepare(`
    SELECT c.*, u.display_name AS owner_name, u.trust_score AS owner_trust,
           u.identity_verified, u.business_verified, u.professional_verified,
           u.strike_count AS owner_strikes
    FROM challenges c
    JOIN users u ON u.id = c.owner_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset);

  const result = await statement.all();
  return { challenges: result.results.map(publicChallenge), limit, offset };
}

function publicConfig(env) {
  return {
    serviceName: '모두의 챌린지',
    internalCode: 'MODU_CHALLENGE',
    environment: env.APP_ENV || 'unknown',
    feeRate: Number(env.PLATFORM_FEE_RATE || 0.1),
    moneyEnabled: isPublicMoneyEnabled(env),
    moneyMode: moneyFlowMode(env),
    termsVersion: env.TERMS_VERSION || '2026-08-28-v1',
    privacyVersion: env.PRIVACY_VERSION || '2026-08-31-v2',
    emailVerificationRequired: emailVerificationEnabled(env),
    socialLogin: {
      google: Boolean(String(env.GOOGLE_OAUTH_CLIENT_ID || '') && String(env.GOOGLE_OAUTH_CLIENT_SECRET || '')),
      naver: Boolean(String(env.NAVER_OAUTH_CLIENT_ID || '') && String(env.NAVER_OAUTH_CLIENT_SECRET || '')),
    },
  };
}

function publicHealth(env) {
  return {
    ok: true,
    service: 'modu-challenge',
    environment: env.APP_ENV || 'unknown',
    feeRate: Number(env.PLATFORM_FEE_RATE || 0.1),
    time: new Date().toISOString(),
  };
}

async function publicBootstrap(url, env) {
  const query = new URL(url);
  query.searchParams.set('limit', '50');
  query.searchParams.set('sort', 'new');
  const challengeData = await queryChallenges(query, env);
  return json({
    config: publicConfig(env),
    health: publicHealth(env),
    ...challengeData,
  }, 200, {
    'Cache-Control': 'public, max-age=10, stale-while-revalidate=30',
  });
}

async function getChallenge(challengeId, request, env) {
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  const auth = await optionalAuth(request, env);
  const viewerAuth = !(auth instanceof Response) ? auth : null;
  if (challenge.visibility !== 'public' && (!viewerAuth || (viewerAuth.id !== challenge.owner_id && !viewerAuth.is_admin))) {
    return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  }

  env.DB.prepare('UPDATE challenges SET view_count = view_count + 1 WHERE id = ?')
    .bind(challengeId).run().catch(() => undefined);

  const recentReviews = await env.DB.prepare(`
    SELECT r.rating, r.comment, r.created_at, u.display_name AS reviewer_name
    FROM reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.reviewee_id = ?
    ORDER BY r.created_at DESC LIMIT 3
  `).bind(challenge.owner_id).all();

  let viewer = null;
  let context = null;
  if (viewerAuth) {
    viewer = publicUser(viewerAuth);
    const isOwner = viewerAuth.id === challenge.owner_id;
    const isSelectedSolver = viewerAuth.id === challenge.selected_solver_id;
    const viewerTeaser = await env.DB.prepare('SELECT id, status, headline, created_at FROM teasers WHERE challenge_id = ? AND solver_id = ?')
      .bind(challengeId, viewerAuth.id).first();
    let settlement = null;
    let latestProof = null;
    if (isOwner || isSelectedSolver || viewerAuth.is_admin) {
      settlement = await env.DB.prepare(`SELECT gross_reward, fee_rate, platform_fee, solver_payout,
        tax_withholding, status, funded_at, paid_at, created_at FROM settlements WHERE challenge_id = ?`)
        .bind(challengeId).first();
      latestProof = await env.DB.prepare(`SELECT id, solver_id, description, evidence_url, evidence_hash,
        status, submitted_at, decided_at FROM proofs WHERE challenge_id = ? ORDER BY submitted_at DESC LIMIT 1`)
        .bind(challengeId).first();
    }
    context = {
      isOwner,
      isSelectedSolver,
      isAdmin: Boolean(viewerAuth.is_admin),
      canApply: !isOwner && !viewerTeaser && !safeJsonParse(challenge.moderation_reasons_json, []).length && ['OPEN', 'REVIEW'].includes(challenge.status),
      viewerTeaser: viewerTeaser ? {
        id: viewerTeaser.id, status: viewerTeaser.status, headline: viewerTeaser.headline,
        createdAt: viewerTeaser.created_at,
      } : null,
      settlement,
      latestProof,
    };
  }

  return json({ challenge: publicChallenge(challenge), ownerReviews: recentReviews.results, viewer, context });
}

async function createChallenge(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  if (user.status === 'limited') return problem(403, 'OWNER_LIMITED', '현재 챌린지 개설이 제한되어 있습니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;

  const title = cleanText(body.title, 5, 90);
  const summary = cleanText(body.summary, 10, 180);
  const description = cleanText(body.description, 20, 4000);
  const category = String(body.category || '').toUpperCase();
  const rewardAmount = Number(body.rewardAmount);
  const successCriteria = cleanText(body.successCriteria, 10, 1600);
  const paymentTrigger = cleanText(body.paymentTrigger, 10, 800);
  const evidenceRequirements = cleanText(body.evidenceRequirements, 5, 800);
  const region = cleanText(body.region, 0, 80) || '전국·온라인';
  const deadline = normalizeFutureDate(body.deadline);
  const visibility = ['public', 'unlisted', 'private'].includes(body.visibility) ? body.visibility : 'public';

  if (!title || !summary || !description) return problem(400, 'INVALID_CONTENT', '제목과 설명을 충분히 입력해주세요.');
  if (!CATEGORIES.has(category)) return problem(400, 'INVALID_CATEGORY', '올바른 카테고리를 선택해주세요.');
  if (!Number.isSafeInteger(rewardAmount) || rewardAmount < 10_000) {
    return problem(400, 'INVALID_REWARD', '보상금은 10,000원 이상 정수로 입력해주세요.');
  }
  if (rewardAmount > Number(user.bounty_limit)) {
    return problem(403, 'BOUNTY_LIMIT_EXCEEDED', `현재 계정의 보상금 표시 한도는 ${formatWon(user.bounty_limit)}입니다.`);
  }
  if (!successCriteria || !paymentTrigger || !evidenceRequirements || !deadline) {
    return problem(400, 'MISSING_RULES', '성공조건, Funding 시점, 증빙기준과 마감일을 입력해주세요.');
  }

  const id = makeId('chl');
  const feeRate = Number(env.PLATFORM_FEE_RATE || 0.1);
  const moderationReasons = analyzeChallengeForModeration({ title, summary, description, successCriteria, rewardAmount });
  const moderationPending = moderationReasons.length > 0;
  const initialStatus = moderationPending ? 'REVIEW' : 'OPEN';
  const initialVisibility = moderationPending ? 'private' : visibility;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO challenges (
        id, owner_id, title, summary, description, category, region,
        reward_amount, fee_rate, success_criteria, payment_trigger,
        evidence_requirements, deadline, status, funding_status, visibility,
        submitted_visibility, moderation_reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?)
    `).bind(id, user.id, title, summary, description, category, region,
      rewardAmount, feeRate, successCriteria, paymentTrigger, evidenceRequirements, deadline, initialStatus,
      initialVisibility, visibility, JSON.stringify(moderationReasons)),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, to_status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(makeId('evt'), id, user.id, moderationPending ? 'CHALLENGE_MODERATION_PENDING' : 'CHALLENGE_CREATED', initialStatus,
      JSON.stringify({ rewardAmount, fundingStatus: 'POSTED', moderationReasons })),
    auditStatement(env, user.id, moderationPending ? 'CHALLENGE_MODERATION_PENDING' : 'CHALLENGE_CREATE', 'challenge', id, null,
      { title, category, rewardAmount, moderationReasons }),
  ]);

  return json({ challenge: publicChallenge(await fetchChallenge(id, env)), moderationPending, moderationReasons }, 201);
}

function analyzeChallengeForModeration({ title, summary, description, successCriteria, rewardAmount }) {
  const combined = `${title}\n${summary}\n${description}\n${successCriteria}`.toLowerCase();
  const rules = [
    ['HIGH_REWARD', rewardAmount >= 500000, '고액 보상금(50만원 이상)'],
    ['PERSONAL_INFORMATION', /(주민등록|주민번호|전화번호|연락처|카카오톡|텔레그램|주소|계좌번호|sns.?아이디|인스타.?아이디)/i.test(combined), '개인정보·직접 연락처 관련 표현'],
    ['DATING_RELATIONSHIP', /(소개팅|연애|이성|만남|데이트|결혼.?상대|배우자)/i.test(combined), '연애·만남 관련 표현'],
    ['MEDICAL', /(의료|진단|처방|치료|수술|약물|병원|의사|환자)/i.test(combined), '의료·건강 고위험 표현'],
    ['LEGAL', /(법률|소송|고소|고발|변호사|법적.?조치|판결)/i.test(combined), '법률·분쟁 관련 표현'],
    ['DANGEROUS_ACTIVITY', /(폭력|위협|무기|마약|도박|자해|불법|침입|해킹|추적)/i.test(combined), '위험·불법 가능성 표현'],
    ['AMBIGUOUS_SUCCESS', /(알아서|무조건.?성공|완벽하게|좋은.?결과|만족.?할.?때|적당히)/i.test(successCriteria), '성공조건이 모호할 수 있는 표현'],
  ];
  return rules.filter(([, matched]) => matched).map(([code, , label]) => ({ code, label }));
}

async function approveModerationChallenge(challengeId, request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.status !== 'REVIEW') return problem(409, 'MODERATION_NOT_PENDING', '관리자 검토 대기 상태의 챌린지만 승인할 수 있습니다.');
  const visibility = ['public', 'unlisted', 'private'].includes(challenge.submitted_visibility) ? challenge.submitted_visibility : 'public';
  await env.DB.batch([
    env.DB.prepare(`UPDATE challenges SET status = 'OPEN', visibility = ?, moderation_reviewed_by = ?, moderation_reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visibility, admin.id, challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json) VALUES (?, ?, ?, 'CHALLENGE_MODERATION_APPROVED', 'REVIEW', 'OPEN', ?)`)
      .bind(makeId('evt'), challengeId, admin.id, JSON.stringify({ visibility, moderationReasons: safeJsonParse(challenge.moderation_reasons_json, []) })),
    auditStatement(env, admin.id, 'CHALLENGE_MODERATION_APPROVE', 'challenge', challengeId, { status: 'REVIEW' }, { status: 'OPEN', visibility }),
  ]);
  return json({ challenge: publicChallenge(await fetchChallenge(challengeId, env)) });
}

async function cancelChallenge(challengeId, request, env) {
  const actor = await requireAuth(request, env);
  if (actor instanceof Response) return actor;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.owner_id !== actor.id && !actor.is_admin) return problem(403, 'OWNER_REQUIRED', '챌린지를 취소할 권한이 없습니다.');
  if (['FUNDED', 'PAID'].includes(challenge.funding_status) || ['EXECUTING', 'PROOF_SUBMITTED', 'SUCCESS', 'DISPUTED'].includes(challenge.status)) {
    return problem(409, 'CANCELLATION_REQUIRES_REVIEW', 'Funding 또는 수행이 시작된 챌린지는 일반 취소가 불가능합니다. 분쟁·환불 절차를 이용해주세요.');
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const reason = cleanText(body.reason, 10, 500);
  if (!reason) return problem(400, 'CANCELLATION_REASON_REQUIRED', '취소 사유를 입력해주세요.');
  await env.DB.batch([
    env.DB.prepare("UPDATE challenges SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, 'CHALLENGE_CANCELLED', ?, 'CANCELLED', ?)`)
      .bind(makeId('evt'), challengeId, actor.id, challenge.status, JSON.stringify({ reason })),
    auditStatement(env, actor.id, 'CHALLENGE_CANCEL', 'challenge', challengeId, { status: challenge.status }, { status: 'CANCELLED', reason }),
  ]);
  return json({ ok: true, status: 'CANCELLED' });
}

async function openDispute(challengeId, request, env) {
  const actor = await requireAuth(request, env);
  if (actor instanceof Response) return actor;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  const isParty = actor.id === challenge.owner_id || actor.id === challenge.selected_solver_id || actor.is_admin;
  if (!isParty) return problem(403, 'PARTY_REQUIRED', '챌린지 당사자만 분쟁을 신청할 수 있습니다.');
  if (!['FUNDING_REQUIRED', 'EXECUTING', 'PROOF_SUBMITTED', 'SUCCESS', 'FAILED'].includes(challenge.status)) {
    return problem(409, 'DISPUTE_NOT_READY', '현재 단계에서는 분쟁절차를 시작할 수 없습니다.');
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const reasonCode = cleanText(body.reasonCode, 3, 50);
  const description = cleanText(body.description, 20, 3000);
  if (!reasonCode || !description) return problem(400, 'INVALID_DISPUTE', '분쟁 사유와 상세내용을 입력해주세요.');
  const disputeId = makeId('dsp');
  const respondentId = actor.id === challenge.owner_id ? challenge.selected_solver_id : challenge.owner_id;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO disputes (id, challenge_id, opened_by, respondent_id, reason_code, description)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(disputeId, challengeId, actor.id, respondentId || null, reasonCode, description),
    env.DB.prepare("UPDATE challenges SET status = 'DISPUTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challengeId),
    env.DB.prepare("UPDATE settlements SET status = 'DISPUTED' WHERE challenge_id = ? AND status NOT IN ('PAID','REFUNDED')").bind(challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, 'DISPUTE_OPENED', ?, 'DISPUTED', ?)`)
      .bind(makeId('evt'), challengeId, actor.id, challenge.status, JSON.stringify({ disputeId, reasonCode })),
    auditStatement(env, actor.id, 'DISPUTE_OPEN', 'dispute', disputeId, null, { challengeId, reasonCode }),
  ]);
  return json({ dispute: { id: disputeId, status: 'OPEN' } }, 201);
}

async function submitTeaser(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.owner_id === user.id) return problem(409, 'OWNER_CANNOT_APPLY', '자신이 개설한 챌린지에는 참가할 수 없습니다.');
  if (!['OPEN', 'REVIEW'].includes(challenge.status)) return problem(409, 'APPLICATION_CLOSED', '현재 참가 신청을 받지 않는 챌린지입니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const headline = cleanText(body.headline, 5, 100);
  const capability = cleanText(body.capability, 20, 1200);
  const approach = cleanText(body.approach, 20, 1600);
  const expectedDays = Number(body.expectedDays);
  const maskedEvidence = cleanText(body.maskedEvidence, 0, 1000);
  const qualificationType = cleanText(body.qualificationType, 0, 80);
  const qualificationRef = cleanText(body.qualificationRef, 0, 160);

  if (!headline || !capability || !approach || !Number.isSafeInteger(expectedDays) || expectedDays < 1 || expectedDays > 365) {
    return problem(400, 'INVALID_TEASER', '해결 가능성, 접근방법과 예상기간을 정확히 입력해주세요.');
  }

  const teaserId = makeId('tsr');
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO teasers (
          id, challenge_id, solver_id, headline, capability, approach,
          expected_days, masked_evidence, qualification_type, qualification_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(teaserId, challengeId, user.id, headline, capability, approach,
        expectedDays, maskedEvidence || null, qualificationType || null, qualificationRef || null),
      env.DB.prepare(`
        UPDATE challenges
        SET teaser_count = teaser_count + 1, participant_count = participant_count + 1,
            status = CASE WHEN status = 'OPEN' THEN 'REVIEW' ELSE status END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(challengeId),
      env.DB.prepare(`
        INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, metadata_json)
        VALUES (?, ?, ?, 'TEASER_SUBMITTED', ?)
      `).bind(makeId('evt'), challengeId, user.id, JSON.stringify({ teaserId })),
      auditStatement(env, user.id, 'TEASER_SUBMIT', 'teaser', teaserId, null, { challengeId }),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return problem(409, 'TEASER_EXISTS', '이미 이 챌린지에 TEASER를 제출했습니다.');
    throw error;
  }

  return json({ teaser: { id: teaserId, status: 'SUBMITTED' } }, 201);
}

async function listTeasers(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.owner_id !== user.id && !user.is_admin) return problem(403, 'OWNER_REQUIRED', '개설자만 후보를 심사할 수 있습니다.');

  const result = await env.DB.prepare(`
    SELECT t.*, u.display_name AS solver_name, u.trust_score AS solver_trust,
           u.identity_verified, u.business_verified, u.professional_verified,
           u.strike_count
    FROM teasers t JOIN users u ON u.id = t.solver_id
    WHERE t.challenge_id = ?
    ORDER BY CASE t.status WHEN 'SELECTED' THEN 0 WHEN 'SHORTLISTED' THEN 1 ELSE 2 END,
             u.trust_score DESC, t.created_at ASC
  `).bind(challengeId).all();
  return json({ teasers: result.results.map(publicTeaser) });
}

async function shortlistTeaser(challengeId, request, env) {
  const owner = await requireAuth(request, env);
  if (owner instanceof Response) return owner;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.owner_id !== owner.id) return problem(403, 'OWNER_REQUIRED', '챌린지 개설자만 후보를 선택할 수 있습니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const teaserId = String(body.teaserId || '');
  const mode = body.mode === 'select' ? 'select' : 'shortlist';
  const teaser = await env.DB.prepare('SELECT * FROM teasers WHERE id = ? AND challenge_id = ?')
    .bind(teaserId, challengeId).first();
  if (!teaser) return problem(404, 'TEASER_NOT_FOUND', 'TEASER를 찾을 수 없습니다.');
  if (!['OPEN', 'REVIEW', 'SHORTLISTED', 'FUNDING_REQUIRED'].includes(challenge.status) || ['FUNDED', 'PAID'].includes(challenge.funding_status)) {
    return problem(409, 'SELECTION_CLOSED', '현재 후보선정을 변경할 수 없는 상태입니다.');
  }

  if (mode === 'select') {
    const moneyError = moneyFlowGuard(env, 'PG·지급대행 연결 전에는 FINALIST를 확정할 수 없습니다. SHORTLIST까지만 진행해주세요.');
    if (moneyError) return moneyError;
    const paymentDueAt = new Date(Date.now() + 72 * 3600_000).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE teasers SET status = CASE WHEN id = ? THEN 'SELECTED' WHEN status = 'SELECTED' THEN 'SHORTLISTED' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE challenge_id = ?")
        .bind(teaserId, challengeId),
      env.DB.prepare(`
        UPDATE challenges SET selected_solver_id = ?, status = 'FUNDING_REQUIRED',
          funding_status = 'PAYMENT_REQUIRED', payment_due_at = ?,
          shortlisted_count = shortlisted_count + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(teaser.solver_id, paymentDueAt, ['SHORTLISTED','SELECTED'].includes(teaser.status) ? 0 : 1, challengeId),
      env.DB.prepare(`
        INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
        VALUES (?, ?, ?, 'FINALIST_SELECTED', ?, 'FUNDING_REQUIRED', ?)
      `).bind(makeId('evt'), challengeId, owner.id, challenge.status, JSON.stringify({ teaserId, solverId: teaser.solver_id, paymentDueAt })),
      auditStatement(env, owner.id, 'FINALIST_SELECT', 'challenge', challengeId, { status: challenge.status }, { status: 'FUNDING_REQUIRED', solverId: teaser.solver_id }),
    ]);
    return json({ ok: true, status: 'FUNDING_REQUIRED', fundingStatus: 'PAYMENT_REQUIRED', paymentDueAt });
  }

  if (teaser.status === 'SHORTLISTED') return json({ ok: true, status: 'SHORTLISTED', idempotent: true });
  if (teaser.status === 'SELECTED') return problem(409, 'FINALIST_ALREADY_SELECTED', '이미 FINALIST로 선택된 후보입니다.');

  await env.DB.batch([
    env.DB.prepare("UPDATE teasers SET status = 'SHORTLISTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(teaserId),
    env.DB.prepare(`
      UPDATE challenges SET shortlisted_count = shortlisted_count + 1,
        status = CASE WHEN status IN ('OPEN','REVIEW') THEN 'SHORTLISTED' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(challengeId),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, metadata_json)
      VALUES (?, ?, ?, 'TEASER_SHORTLISTED', ?)
    `).bind(makeId('evt'), challengeId, owner.id, JSON.stringify({ teaserId, solverId: teaser.solver_id })),
  ]);
  return json({ ok: true, status: 'SHORTLISTED' });
}

async function requestFunding(challengeId, request, env) {
  const moneyError = moneyFlowGuard(env, 'PG·지급대행 연결 전에는 보상금 Funding을 시작할 수 없습니다.');
  if (moneyError) return moneyError;
  const owner = await requireAuth(request, env);
  if (owner instanceof Response) return owner;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.owner_id !== owner.id) return problem(403, 'OWNER_REQUIRED', '챌린지 개설자만 Funding을 진행할 수 있습니다.');
  if (!challenge.selected_solver_id) return problem(409, 'FINALIST_REQUIRED', '먼저 최종 후보를 선택해주세요.');
  if (!['FUNDING_REQUIRED', 'SHORTLISTED', 'REVIEW'].includes(challenge.status) || ['FUNDED', 'PAID'].includes(challenge.funding_status)) {
    return problem(409, 'INVALID_FUNDING_STATE', '현재 Funding을 요청할 수 없는 상태입니다.');
  }

  const due = new Date(Date.now() + 72 * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE challenges SET status = 'FUNDING_REQUIRED', funding_status = 'PAYMENT_REQUIRED', payment_due_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(due, challengeId),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, to_status, metadata_json)
      VALUES (?, ?, ?, 'FUNDING_REQUESTED', 'FUNDING_REQUIRED', ?)
    `).bind(makeId('evt'), challengeId, owner.id, JSON.stringify({ due })),
  ]);
  return json({ ok: true, paymentDueAt: due });
}

async function confirmFunding(challengeId, request, env) {
  const moneyError = moneyFlowGuard(env, 'PG·지급대행 연결 전에는 Funding을 확정할 수 없습니다.');
  if (moneyError) return moneyError;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');

  const webhookSecret = String(env.PAYMENT_WEBHOOK_SECRET || '');
  const providedSecret = String(request.headers.get('X-Payment-Webhook-Secret') || '');
  const providerVerified = Boolean(webhookSecret) && constantTimeEqual(providedSecret, webhookSecret);
  let actorId = null;
  if (!providerVerified) {
    const owner = await requireAuth(request, env);
    if (owner instanceof Response) return owner;
    if (challenge.owner_id !== owner.id && !owner.is_admin) return problem(403, 'OWNER_REQUIRED', 'Funding 확인 권한이 없습니다.');
    actorId = owner.id;
    if (!isLocalMoneySimulation(env)) {
      return problem(503, 'PAYMENT_PROVIDER_REQUIRED', '공개환경에서는 검증된 PG Webhook으로만 Funding을 확정할 수 있습니다.');
    }
  }
  if (!challenge.selected_solver_id) return problem(409, 'FINALIST_REQUIRED', '최종 후보가 선택되지 않았습니다.');
  if (!['PAYMENT_REQUIRED', 'POSTED'].includes(challenge.funding_status)) {
    return problem(409, 'INVALID_FUNDING_STATE', '현재 Funding을 확인할 수 없는 상태입니다.');
  }

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const provider = cleanText(body.provider, 2, 40) || 'manual-preview';
  const providerReference = cleanText(body.providerReference, 3, 120) || makeId('pay');
  if (providerVerified && (provider === 'manual-preview' || !body.providerReference)) {
    return problem(400, 'INVALID_PROVIDER_REFERENCE', '검증된 결제 제공사와 거래번호가 필요합니다.');
  }
  const feeRate = Number(challenge.fee_rate || env.PLATFORM_FEE_RATE || 0.1);
  const { platformFee, solverPayout } = calculateSettlement(Number(challenge.reward_amount), feeRate);
  const settlementId = makeId('set');

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO settlements (
        id, challenge_id, owner_id, solver_id, gross_reward, fee_rate,
        platform_fee, solver_payout, provider, provider_reference, status, funded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FUNDED', CURRENT_TIMESTAMP)
      ON CONFLICT(challenge_id) DO UPDATE SET
        provider = excluded.provider, provider_reference = excluded.provider_reference,
        status = 'FUNDED', funded_at = CURRENT_TIMESTAMP
    `).bind(settlementId, challengeId, challenge.owner_id, challenge.selected_solver_id,
      challenge.reward_amount, feeRate, platformFee, solverPayout, provider, providerReference),
    env.DB.prepare("UPDATE challenges SET status = 'EXECUTING', funding_status = 'FUNDED', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(challengeId),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, 'FUNDING_CONFIRMED', ?, 'EXECUTING', ?)
    `).bind(makeId('evt'), challengeId, actorId, challenge.status, JSON.stringify({ provider, providerReference })),
    auditStatement(env, actorId, 'FUNDING_CONFIRM', 'challenge', challengeId,
      { fundingStatus: challenge.funding_status }, { fundingStatus: 'FUNDED', providerReference }),
  ]);
  return json({ ok: true, status: 'EXECUTING', fundingStatus: 'FUNDED' });
}

async function submitProof(challengeId, request, env) {
  const solver = await requireAuth(request, env);
  if (solver instanceof Response) return solver;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.selected_solver_id !== solver.id) return problem(403, 'SELECTED_SOLVER_REQUIRED', '선정된 참가자만 결과를 제출할 수 있습니다.');
  if (challenge.status !== 'EXECUTING' || challenge.funding_status !== 'FUNDED') {
    return problem(409, 'NOT_READY_FOR_PROOF', 'Funding 완료 후 선정된 수행 단계에서만 결과를 제출할 수 있습니다.');
  }

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const description = cleanText(body.description, 20, 3000);
  const evidenceUrl = safeUrl(body.evidenceUrl);
  if (!description) return problem(400, 'INVALID_PROOF', '수행 결과와 증빙 내용을 입력해주세요.');

  const proofId = makeId('prf');
  const evidenceHash = await sha256(`${description}|${evidenceUrl || ''}`);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO proofs (id, challenge_id, solver_id, description, evidence_url, evidence_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(proofId, challengeId, solver.id, description, evidenceUrl || null, evidenceHash),
    env.DB.prepare("UPDATE challenges SET status = 'PROOF_SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(challengeId),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, 'PROOF_SUBMITTED', ?, 'PROOF_SUBMITTED', ?)
    `).bind(makeId('evt'), challengeId, solver.id, challenge.status, JSON.stringify({ proofId, evidenceHash })),
    auditStatement(env, solver.id, 'PROOF_SUBMIT', 'proof', proofId, null, { challengeId, evidenceHash }),
  ]);
  return json({ proof: { id: proofId, status: 'SUBMITTED', evidenceHash } }, 201);
}

async function confirmSuccess(challengeId, request, env) {
  const moneyError = moneyFlowGuard(env, 'PG·지급대행 연결 전에는 성공 확정과 정산을 진행할 수 없습니다.');
  if (moneyError) return moneyError;
  const owner = await requireAuth(request, env);
  if (owner instanceof Response) return owner;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.owner_id !== owner.id && !owner.is_admin) return problem(403, 'OWNER_REQUIRED', '성공을 확정할 권한이 없습니다.');
  if (challenge.status !== 'PROOF_SUBMITTED' || challenge.funding_status !== 'FUNDED') {
    return problem(409, 'INVALID_SUCCESS_STATE', 'Funding과 결과 제출이 완료된 후 성공 확정이 가능합니다.');
  }

  const proof = await env.DB.prepare("SELECT * FROM proofs WHERE challenge_id = ? AND status = 'SUBMITTED' ORDER BY submitted_at DESC LIMIT 1")
    .bind(challengeId).first();
  if (!proof) return problem(409, 'PROOF_REQUIRED', '확인할 결과 증빙이 없습니다.');

  const settlement = await env.DB.prepare('SELECT * FROM settlements WHERE challenge_id = ?').bind(challengeId).first();
  if (!settlement) return problem(409, 'SETTLEMENT_REQUIRED', '정산정보를 찾을 수 없습니다.');

  await env.DB.batch([
    env.DB.prepare("UPDATE proofs SET status = 'ACCEPTED', decided_at = CURRENT_TIMESTAMP WHERE id = ?").bind(proof.id),
    env.DB.prepare("UPDATE settlements SET status = 'PROCESSING' WHERE challenge_id = ? AND status = 'FUNDED'").bind(challengeId),
    env.DB.prepare("UPDATE challenges SET status = 'SUCCESS', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challengeId),
    env.DB.prepare('UPDATE users SET trust_score = MIN(100, trust_score + 2), bounty_limit = MAX(bounty_limit, ?) WHERE id = ?')
      .bind(Math.max(Number(challenge.reward_amount) * 2, Number(owner.bounty_limit)), challenge.owner_id),
    env.DB.prepare('UPDATE users SET trust_score = MIN(100, trust_score + 3) WHERE id = ?').bind(challenge.selected_solver_id),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, 'CHALLENGE_SUCCESS', 'PROOF_SUBMITTED', 'SUCCESS', ?)
    `).bind(makeId('evt'), challengeId, owner.id, JSON.stringify({
      grossReward: settlement.gross_reward,
      platformFee: settlement.platform_fee,
      solverPayout: settlement.solver_payout,
    })),
    auditStatement(env, owner.id, 'CHALLENGE_SUCCESS', 'challenge', challengeId,
      { status: challenge.status }, { status: 'SUCCESS', settlementId: settlement.id }),
  ]);

  return json({
    ok: true,
    status: 'SUCCESS',
    settlement: {
      grossReward: settlement.gross_reward,
      platformFee: settlement.platform_fee,
      solverPayout: settlement.solver_payout,
      status: 'PROCESSING',
    },
  });
}

async function confirmPayoutWebhook(request, env) {
  const moneyError = moneyFlowGuard(env, '지급대행 연결 전에는 지급 결과를 반영할 수 없습니다.');
  if (moneyError) return moneyError;
  const expected = String(env.PAYOUT_WEBHOOK_SECRET || '');
  const provided = String(request.headers.get('X-Payout-Webhook-Secret') || '');
  if (!expected || !constantTimeEqual(provided, expected)) {
    return problem(403, 'PAYOUT_WEBHOOK_DENIED', '지급 결과 확인 권한이 없습니다.');
  }

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const challengeId = String(body.challengeId || '');
  const payoutProvider = cleanText(body.provider, 2, 40) || 'payout-provider';
  const payoutReference = cleanText(body.payoutReference || body.providerReference, 3, 120);
  const payoutStatus = String(body.status || '').toUpperCase();
  if (!challengeId || !payoutReference || !['PAID', 'FAILED'].includes(payoutStatus)) {
    return problem(400, 'INVALID_PAYOUT_RESULT', '챌린지 ID, 지급 거래번호와 지급 결과가 필요합니다.');
  }

  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  const settlement = await env.DB.prepare('SELECT * FROM settlements WHERE challenge_id = ?').bind(challengeId).first();
  if (!settlement) return problem(404, 'SETTLEMENT_NOT_FOUND', '정산정보를 찾을 수 없습니다.');
  if (settlement.payout_reference && settlement.payout_reference !== payoutReference) {
    return problem(409, 'PAYOUT_REFERENCE_MISMATCH', '이미 등록된 지급 거래번호와 일치하지 않습니다.');
  }
  if (settlement.status === payoutStatus) return json({ ok: true, idempotent: true, status: payoutStatus });
  if (!['PROCESSING', 'FUNDED', 'FAILED'].includes(settlement.status)) {
    return problem(409, 'INVALID_PAYOUT_STATE', '현재 지급 결과를 반영할 수 없는 상태입니다.');
  }

  if (payoutStatus === 'PAID') {
    await env.DB.batch([
      env.DB.prepare("UPDATE settlements SET status = 'PAID', payout_provider = ?, payout_reference = ?, paid_at = CURRENT_TIMESTAMP WHERE challenge_id = ?")
        .bind(payoutProvider, payoutReference, challengeId),
      env.DB.prepare("UPDATE challenges SET funding_status = 'PAID', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(challengeId),
      env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
        VALUES (?, ?, NULL, 'PAYOUT_CONFIRMED', 'SUCCESS', 'SUCCESS', ?)`)
        .bind(makeId('evt'), challengeId, JSON.stringify({ payoutProvider, payoutReference, solverPayout: settlement.solver_payout })),
      env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
        VALUES (?, ?, 'PAYOUT_PAID', '챌린지 보상금 지급이 완료되었습니다', ?, 'challenge', ?)`)
        .bind(makeId('not'), settlement.solver_id, `${challenge.title} 보상금 ${Number(settlement.solver_payout).toLocaleString('ko-KR')}원이 지급되었습니다.`, challengeId),
      auditStatement(env, null, 'PAYOUT_CONFIRM', 'settlement', settlement.id,
        { status: settlement.status }, { status: 'PAID', payoutProvider, payoutReference }),
    ]);
    return json({ ok: true, status: 'PAID', solverPayout: Number(settlement.solver_payout) });
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE settlements SET status = 'FAILED', payout_provider = ?, payout_reference = ? WHERE challenge_id = ?").bind(payoutProvider, payoutReference, challengeId),
    env.DB.prepare("UPDATE challenges SET funding_status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, NULL, 'PAYOUT_FAILED', 'SUCCESS', 'SUCCESS', ?)`)
      .bind(makeId('evt'), challengeId, JSON.stringify({ payoutProvider, payoutReference })),
    env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
      VALUES (?, ?, 'PAYOUT_FAILED', '보상금 지급 처리가 지연되고 있습니다', ?, 'challenge', ?)`)
      .bind(makeId('not'), settlement.solver_id, `${challenge.title} 지급 실패가 확인되어 운영 검토가 시작됩니다.`, challengeId),
    auditStatement(env, null, 'PAYOUT_FAIL', 'settlement', settlement.id,
      { status: settlement.status }, { status: 'FAILED', payoutProvider, payoutReference }),
  ]);
  return json({ ok: true, status: 'FAILED' });
}

async function createReview(challengeId, request, env) {
  const reviewer = await requireAuth(request, env);
  if (reviewer instanceof Response) return reviewer;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '챌린지를 찾을 수 없습니다.');
  if (challenge.status !== 'SUCCESS') return problem(409, 'REVIEW_NOT_READY', '성공 완료된 챌린지만 평가할 수 있습니다.');

  let revieweeId;
  let reviewerRole;
  if (reviewer.id === challenge.owner_id) {
    revieweeId = challenge.selected_solver_id;
    reviewerRole = 'OWNER';
  } else if (reviewer.id === challenge.selected_solver_id) {
    revieweeId = challenge.owner_id;
    reviewerRole = 'SOLVER';
  } else {
    return problem(403, 'PARTY_REQUIRED', '챌린지 당사자만 리뷰를 작성할 수 있습니다.');
  }

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const rating = clampInt(body.rating, 1, 5);
  const accuracy = clampInt(body.accuracy, 1, 5);
  const responsiveness = clampInt(body.responsiveness, 1, 5);
  const reliability = clampInt(body.reliability, 1, 5);
  const wouldWorkAgain = body.wouldWorkAgain === false ? 0 : 1;
  const comment = cleanText(body.comment, 0, 500);
  if (!rating) return problem(400, 'INVALID_RATING', '1점부터 5점 사이로 평가해주세요.');

  const reviewId = makeId('rev');
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO reviews (
          id, challenge_id, reviewer_id, reviewee_id, reviewer_role,
          rating, accuracy, responsiveness, reliability, would_work_again, comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(reviewId, challengeId, reviewer.id, revieweeId, reviewerRole,
        rating, accuracy || null, responsiveness || null, reliability || null, wouldWorkAgain, comment || null),
      env.DB.prepare(`
        UPDATE users SET trust_score = MAX(0, MIN(100,
          trust_score + CASE WHEN ? >= 5 THEN 2 WHEN ? >= 4 THEN 1 WHEN ? <= 2 THEN -2 ELSE 0 END
        )) WHERE id = ?
      `).bind(rating, rating, rating, revieweeId),
      auditStatement(env, reviewer.id, 'REVIEW_CREATE', 'review', reviewId, null, { challengeId, revieweeId, rating }),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return problem(409, 'REVIEW_EXISTS', '이미 이 상대방을 평가했습니다.');
    throw error;
  }
  return json({ review: { id: reviewId, rating } }, 201);
}

/* -------------------------------------------------------------------------- */
/* Trust and admin                                                            */
/* -------------------------------------------------------------------------- */

async function getTrustProfile(userId, env) {
  const user = await env.DB.prepare(`
    SELECT id, display_name, account_type, status, identity_verified,
      business_verified, professional_verified, trust_score, strike_count,
      bounty_limit, created_at
    FROM users WHERE id = ?
  `).bind(userId).first();
  if (!user) return problem(404, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');

  const ownerStats = await env.DB.prepare(`
    SELECT COUNT(*) AS opened,
      SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS completed,
      COALESCE(SUM(CASE WHEN status = 'SUCCESS' THEN reward_amount ELSE 0 END), 0) AS total_paid,
      SUM(CASE WHEN funding_status = 'FAILED' THEN 1 ELSE 0 END) AS funding_failures
    FROM challenges WHERE owner_id = ?
  `).bind(userId).first();
  const solverStats = await env.DB.prepare(`
    SELECT COUNT(*) AS teasers,
      SUM(CASE WHEN t.status IN ('SHORTLISTED','SELECTED') THEN 1 ELSE 0 END) AS shortlisted,
      SUM(CASE WHEN c.status = 'SUCCESS' AND c.selected_solver_id = ? THEN 1 ELSE 0 END) AS successes,
      COALESCE(SUM(CASE WHEN c.status = 'SUCCESS' AND c.selected_solver_id = ? THEN s.solver_payout ELSE 0 END), 0) AS earned
    FROM teasers t
    JOIN challenges c ON c.id = t.challenge_id
    LEFT JOIN settlements s ON s.challenge_id = c.id
    WHERE t.solver_id = ?
  `).bind(userId, userId, userId).first();
  const reviewStats = await env.DB.prepare(`
    SELECT ROUND(AVG(rating), 2) AS average_rating,
      COUNT(*) AS review_count,
      ROUND(AVG(would_work_again) * 100, 0) AS work_again_rate
    FROM reviews WHERE reviewee_id = ?
  `).bind(userId).first();
  const recentReviews = await env.DB.prepare(`
    SELECT rating, comment, created_at FROM reviews
    WHERE reviewee_id = ? ORDER BY created_at DESC LIMIT 10
  `).bind(userId).all();
  const recentStrikes = await env.DB.prepare(`
    SELECT strike_level, reason_code, status, issued_at, expires_at
    FROM strikes WHERE user_id = ? ORDER BY issued_at DESC LIMIT 10
  `).bind(userId).all();
  const recentSuccesses = await env.DB.prepare(`
    SELECT title, owner_id, selected_solver_id, updated_at
    FROM challenges
    WHERE status = 'SUCCESS' AND (owner_id = ? OR selected_solver_id = ?)
    ORDER BY updated_at DESC LIMIT 10
  `).bind(userId, userId).all();
  const trustHistory = [
    ...recentReviews.results.map((review) => ({
      type: 'REVIEW',
      title: `${review.rating}점 상호 리뷰`,
      description: review.comment || '챌린지 상호평가가 반영되었습니다.',
      delta: review.rating >= 5 ? 2 : review.rating >= 4 ? 1 : review.rating <= 2 ? -2 : 0,
      date: review.created_at,
    })),
    ...recentSuccesses.results.map((challenge) => ({
      type: 'SUCCESS',
      title: challenge.owner_id === userId ? '챌린지 성공 확정' : '챌린지 수행 성공',
      description: challenge.title,
      delta: challenge.owner_id === userId ? 2 : 3,
      date: challenge.updated_at,
    })),
    ...recentStrikes.results.map((strike) => ({
      type: 'STRIKE',
      title: `운영 신뢰 조치 · ${strike.reason_code}`,
      description: `Strike ${strike.strike_level}단계 · ${strike.status}`,
      delta: null,
      date: strike.issued_at,
    })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 15);

  return json({
    profile: {
      ...publicUser(user),
      ownerStats,
      solverStats,
      reviewStats,
      recentReviews: recentReviews.results,
      trustHistory,
    },
  });
}

async function adminOverview(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const role = adminRole(admin);

  const [users, challenges, money, disputes, recent, recentUsers, openDisputes, pendingSettlements, staffCandidates, staffMembers, draftChallenges, moderationChallenges] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status = 'suspended') suspended, SUM(strike_count > 0) with_strikes FROM users`),
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status = 'DRAFT') draft, SUM(status = 'OPEN') open, SUM(status = 'SUCCESS') success, SUM(status = 'DISPUTED') disputed FROM challenges`),
    env.DB.prepare(`SELECT COALESCE(SUM(platform_fee), 0) platform_revenue, COALESCE(SUM(solver_payout), 0) solver_payouts FROM settlements WHERE status = 'PAID'`),
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status NOT IN ('DECIDED','CLOSED')) open FROM disputes`),
    env.DB.prepare(`SELECT id, action, resource_type, resource_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 20`),
    env.DB.prepare(`SELECT id, display_name, account_type, status, trust_score, strike_count, created_at FROM users ORDER BY created_at DESC LIMIT 12`),
    env.DB.prepare(`SELECT d.id, d.challenge_id, d.reason_code, d.status, d.created_at, c.title
      FROM disputes d JOIN challenges c ON c.id = d.challenge_id
      WHERE d.status NOT IN ('DECIDED','CLOSED') ORDER BY d.created_at DESC LIMIT 12`),
    env.DB.prepare(`SELECT s.id, s.challenge_id, s.status, s.gross_reward, s.solver_payout, s.created_at, c.title
      FROM settlements s JOIN challenges c ON c.id = s.challenge_id
      WHERE s.status NOT IN ('PAID','REFUNDED') ORDER BY s.created_at DESC LIMIT 12`),
    env.DB.prepare(`SELECT id, display_name, account_type, status, trust_score, created_at
      FROM users WHERE id <> ? AND is_admin = 0 AND status IN ('active','limited')
      ORDER BY created_at DESC LIMIT 40`).bind(admin.id),
    env.DB.prepare(`SELECT u.id, u.display_name, u.email, u.account_type, COALESCE(ar.role, 'deputy') AS admin_role, u.status, u.created_at
      FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id
      WHERE u.is_admin = 1 ORDER BY CASE COALESCE(ar.role, 'deputy') WHEN 'primary' THEN 0 ELSE 1 END, u.created_at ASC`),
    env.DB.prepare(`SELECT id, title, reward_amount, deadline, created_at
      FROM challenges WHERE status = 'DRAFT' AND visibility = 'private'
      ORDER BY created_at DESC LIMIT 20`),
    env.DB.prepare(`SELECT id, title, reward_amount, deadline, created_at, moderation_reasons_json
      FROM challenges WHERE status = 'REVIEW'
      ORDER BY created_at ASC LIMIT 30`),
  ]);

  const isPrimary = role === 'primary';

  return json({
    overview: {
      role,
      users: users.results?.[0] || {},
      challenges: challenges.results?.[0] || {},
      money: isPrimary ? (money.results?.[0] || {}) : null,
      disputes: disputes.results?.[0] || {},
      recentAudit: isPrimary ? (recent.results || []) : [],
      recentUsers: isPrimary ? (recentUsers.results || []) : [],
      openDisputes: isPrimary ? (openDisputes.results || []) : [],
      pendingSettlements: isPrimary ? (pendingSettlements.results || []) : [],
      draftChallenges: isPrimary ? (draftChallenges.results || []) : [],
      moderationChallenges: isPrimary ? (moderationChallenges.results || []).map((item) => ({
        ...item, moderationReasons: safeJsonParse(item.moderation_reasons_json, []),
      })) : [],
      staffCandidates: isPrimary ? (staffCandidates.results || []) : [],
      staffMembers: isPrimary ? (staffMembers.results || []) : [],
    },
  });
}

async function getAdminMemberDetail(userId, request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;

  const member = await env.DB.prepare(`
    SELECT u.id, u.email, u.display_name, u.account_type, u.status,
      u.identity_verified, u.business_verified, u.professional_verified, u.email_verified,
      u.terms_version, u.terms_accepted_at, u.privacy_version, u.privacy_accepted_at,
      u.phone, u.region, u.challenge_intent, u.birth_year, u.gender, u.interests, u.organization_name,
      u.marketing_consent, u.marketing_consent_at, u.signup_source, u.last_login_at,
      u.trust_score, u.strike_count, u.bounty_limit, u.created_at, u.updated_at,
      COALESCE(ar.role, 'member') AS admin_role
    FROM users u
    LEFT JOIN admin_roles ar ON ar.user_id = u.id
    WHERE u.id = ?
  `).bind(userId).first();
  if (!member) return problem(404, 'USER_NOT_FOUND', '가입회원을 찾을 수 없습니다.');

  await audit(env, primary.id, 'ADMIN_MEMBER_DETAIL_VIEW', 'user', member.id, null, {
    access: 'primary-only',
  });

  return json({
    member: {
      id: member.id,
      displayName: member.display_name,
      email: member.email,
      accountType: member.account_type,
      status: member.status,
      adminRole: member.admin_role,
      verification: {
        identity: Boolean(member.identity_verified),
        business: Boolean(member.business_verified),
        professional: Boolean(member.professional_verified),
        email: Boolean(member.email_verified),
      },
      consent: {
        termsVersion: member.terms_version,
        termsAcceptedAt: member.terms_accepted_at,
        privacyVersion: member.privacy_version,
        privacyAcceptedAt: member.privacy_accepted_at,
      },
      registration: {
        phone: member.phone,
        region: member.region,
        challengeIntent: member.challenge_intent,
        birthYear: member.birth_year,
        gender: member.gender,
        interests: member.interests,
        organizationName: member.organization_name,
        marketingAccepted: Boolean(member.marketing_consent),
        marketingAcceptedAt: member.marketing_consent_at,
        source: member.signup_source,
        lastLoginAt: member.last_login_at,
      },
      trustScore: member.trust_score,
      strikeCount: member.strike_count,
      bountyLimit: member.bounty_limit,
      createdAt: member.created_at,
      updatedAt: member.updated_at,
    },
  });
}

async function appointDeputy(request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const userId = String(body.userId || '');
  const target = await env.DB.prepare(`SELECT u.*, COALESCE(ar.role, 'member') AS admin_role
    FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.id = ?`).bind(userId).first();
  if (!target) return problem(404, 'USER_NOT_FOUND', '지정할 가입회원을 찾을 수 없습니다.');
  if (target.status === 'closed' || target.status === 'suspended') return problem(409, 'USER_INELIGIBLE', '정지 또는 탈퇴 계정은 부관리자로 지정할 수 없습니다.');
  if (normalizeEmail(target.email) === configuredPrimaryEmail(env)) return problem(409, 'PRIMARY_PROTECTED', '최고관리자 계정은 부관리자로 변경할 수 없습니다.');
  if (adminRole(target) === 'deputy') return json({ ok: true, idempotent: true, user: publicUser(target) });

  await env.DB.batch([
    env.DB.prepare('UPDATE users SET is_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(target.id),
    env.DB.prepare("INSERT INTO admin_roles (user_id, role, appointed_by) VALUES (?, 'deputy', ?) ON CONFLICT(user_id) DO UPDATE SET role = 'deputy', appointed_by = excluded.appointed_by, appointed_at = CURRENT_TIMESTAMP").bind(target.id, primary.id),
    auditStatement(env, primary.id, 'DEPUTY_ADMIN_APPOINT', 'user', target.id, { adminRole: adminRole(target) }, { adminRole: 'deputy' }),
  ]);
  return json({ ok: true, user: publicUser({ ...target, is_admin: 1, admin_role: 'deputy' }) });
}

async function revokeDeputy(userId, request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;
  const target = await env.DB.prepare(`SELECT u.*, COALESCE(ar.role, 'member') AS admin_role
    FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.id = ?`).bind(userId).first();
  if (!target) return problem(404, 'USER_NOT_FOUND', '부관리자 계정을 찾을 수 없습니다.');
  if (adminRole(target) !== 'deputy') return problem(409, 'DEPUTY_REQUIRED', '부관리자 계정만 권한을 회수할 수 있습니다.');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET is_admin = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(target.id),
    env.DB.prepare('DELETE FROM admin_roles WHERE user_id = ?').bind(target.id),
    auditStatement(env, primary.id, 'DEPUTY_ADMIN_REVOKE', 'user', target.id, { adminRole: 'deputy' }, { adminRole: 'member' }),
  ]);
  return json({ ok: true, userId: target.id });
}

async function issueStrike(request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const userId = String(body.userId || '');
  const challengeId = body.challengeId ? String(body.challengeId) : null;
  const reasonCode = cleanText(body.reasonCode, 3, 50);
  const reasonDetail = cleanText(body.reasonDetail, 10, 1000);
  if (!userId || !reasonCode || !reasonDetail) return problem(400, 'INVALID_STRIKE', '제재 대상과 사유를 입력해주세요.');

  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!target) return problem(404, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
  const outcome = calculateStrikeOutcome({
    strikeCount: Number(target.strike_count || 0),
    trustScore: Number(target.trust_score || 0),
    severeFraud: Boolean(body.severeFraud),
  });
  const nextLevel = outcome.strikeCount;
  const nextStatus = outcome.accountStatus;
  const strikeId = makeId('stk');

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO strikes (id, user_id, challenge_id, strike_level, reason_code, reason_detail, issued_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(strikeId, userId, challengeId, nextLevel, reasonCode, reasonDetail, admin.id),
    env.DB.prepare('UPDATE users SET strike_count = ?, status = ?, trust_score = ? WHERE id = ?')
      .bind(nextLevel, nextStatus, outcome.trustScore, userId),
    auditStatement(env, admin.id, 'STRIKE_ISSUE', 'user', userId,
      { strikeCount: target.strike_count, status: target.status }, { strikeCount: nextLevel, status: nextStatus, reasonCode }),
  ]);
  return json({ strike: { id: strikeId, level: nextLevel, accountStatus: nextStatus } }, 201);
}

async function revokeStrike(strikeId, request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  const strike = await env.DB.prepare('SELECT * FROM strikes WHERE id = ?').bind(strikeId).first();
  if (!strike) return problem(404, 'STRIKE_NOT_FOUND', 'Strike 기록을 찾을 수 없습니다.');
  if (strike.status === 'REVOKED') return json({ ok: true, idempotent: true });
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const reason = cleanText(body.reason, 10, 1000);
  if (!reason) return problem(400, 'REVOKE_REASON_REQUIRED', '철회 사유를 입력해주세요.');
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM strikes WHERE user_id = ? AND status = 'ACTIVE' AND id <> ?")
    .bind(strike.user_id, strikeId).first();
  const count = Math.min(3, Number(active?.count || 0));
  const status = count >= 3 ? 'suspended' : count >= 2 ? 'limited' : 'active';
  await env.DB.batch([
    env.DB.prepare("UPDATE strikes SET status = 'REVOKED' WHERE id = ?").bind(strikeId),
    env.DB.prepare('UPDATE users SET strike_count = ?, status = ? WHERE id = ?').bind(count, status, strike.user_id),
    auditStatement(env, admin.id, 'STRIKE_REVOKE', 'strike', strikeId, { status: strike.status }, { status: 'REVOKED', reason }),
  ]);
  return json({ ok: true, strikeCount: count, accountStatus: status });
}

async function processOverdueFunding(env) {
  await env.DB.prepare("DELETE FROM auth_attempts WHERE datetime(created_at) < datetime('now', '-30 days')")
    .run().catch(() => undefined);
  const overdue = await env.DB.prepare(`
    SELECT c.id, c.owner_id, c.selected_solver_id, c.title,
           u.strike_count, u.trust_score, u.status
    FROM challenges c JOIN users u ON u.id = c.owner_id
    WHERE c.funding_status = 'PAYMENT_REQUIRED'
      AND c.payment_due_at IS NOT NULL
      AND datetime(c.payment_due_at) < datetime('now')
    LIMIT 100
  `).all();

  for (const item of overdue.results || []) {
    const outcome = calculateStrikeOutcome({ strikeCount: item.strike_count, trustScore: item.trust_score });
    const strikeId = makeId('stk');
    const operations = [
      env.DB.prepare("UPDATE challenges SET status = 'CANCELLED', funding_status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND funding_status = 'PAYMENT_REQUIRED'").bind(item.id),
      env.DB.prepare(`INSERT INTO strikes (id, user_id, challenge_id, strike_level, reason_code, reason_detail, issued_by)
        VALUES (?, ?, ?, ?, 'FUNDING_FAILURE', 'Funding 기한 내 보상금 미확보', NULL)`)
        .bind(strikeId, item.owner_id, item.id, outcome.strikeCount),
      env.DB.prepare('UPDATE users SET strike_count = ?, trust_score = ?, status = ? WHERE id = ?')
        .bind(outcome.strikeCount, outcome.trustScore, outcome.accountStatus, item.owner_id),
      env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
        VALUES (?, ?, NULL, 'FUNDING_DEADLINE_MISSED', 'FUNDING_REQUIRED', 'CANCELLED', ?)`)
        .bind(makeId('evt'), item.id, JSON.stringify({ strikeId })),
      auditStatement(env, null, 'FUNDING_DEADLINE_MISSED', 'challenge', item.id,
        { fundingStatus: 'PAYMENT_REQUIRED' }, { fundingStatus: 'FAILED', strikeId }),
      env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
        VALUES (?, ?, 'FUNDING_FAILED', 'Funding 기한을 지키지 못했습니다', ?, 'challenge', ?)`)
        .bind(makeId('not'), item.owner_id, `${item.title} 챌린지가 중지되고 Strike가 반영되었습니다.`, item.id),
    ];
    if (item.selected_solver_id) {
      operations.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
        VALUES (?, ?, 'FUNDING_FAILED', '보상금 Funding이 완료되지 않았습니다', ?, 'challenge', ?)`)
        .bind(makeId('not'), item.selected_solver_id, `${item.title} 챌린지가 중지되었습니다.`, item.id));
    }
    try {
      await env.DB.batch(operations);
    } catch (error) {
      if (String(error).includes('UNIQUE')) continue;
      throw error;
    }
  }
  return { processed: overdue.results?.length || 0 };
}

async function checkAuthRateLimit(request, env, action, email) {
  const ipHash = await sha256(request.headers.get('CF-Connecting-IP') || 'unknown');
  const emailHash = await sha256(normalizeEmail(email));
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM auth_attempts
    WHERE action = ? AND success = 0
      AND (ip_hash = ? OR email_hash = ?)
      AND datetime(created_at) > datetime('now', '-15 minutes')
  `).bind(action, ipHash, emailHash).first();
  if (Number(row?.count || 0) >= 10) {
    return problem(429, 'TOO_MANY_ATTEMPTS', '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.');
  }
  return { ipHash, emailHash };
}

async function recordAuthAttempt(env, action, identifiers, success) {
  if (!identifiers || identifiers instanceof Response) return;
  await env.DB.prepare(`
    INSERT INTO auth_attempts (id, action, ip_hash, email_hash, success)
    VALUES (?, ?, ?, ?, ?)
  `).bind(makeId('att'), action, identifiers.ipHash, identifiers.emailHash, success ? 1 : 0).run();
}

/* -------------------------------------------------------------------------- */
/* Data helpers                                                               */
/* -------------------------------------------------------------------------- */

async function fetchChallenge(id, env) {
  return env.DB.prepare(`
    SELECT c.*, u.display_name AS owner_name, u.trust_score AS owner_trust,
      u.identity_verified, u.business_verified, u.professional_verified,
      u.strike_count AS owner_strikes
    FROM challenges c JOIN users u ON u.id = c.owner_id
    WHERE c.id = ?
  `).bind(id).first();
}

async function optionalAuth(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (!token) return null;
  return requireAuth(request, env);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    accountType: user.account_type,
    status: user.status,
    isAdmin: Boolean(user.is_admin),
    adminRole: adminRole(user),
    emailVerified: Boolean(user.email_verified),
    verification: {
      identity: Boolean(user.identity_verified),
      business: Boolean(user.business_verified),
      professional: Boolean(user.professional_verified),
    },
    trustScore: Number(user.trust_score || 0),
    strikeCount: Number(user.strike_count || 0),
    bountyLimit: Number(user.bounty_limit || 0),
    createdAt: user.created_at,
  };
}

function publicChallenge(c) {
  return {
    id: c.id,
    ownerId: c.owner_id,
    owner: {
      displayName: c.owner_name,
      trustScore: Number(c.owner_trust || 0),
      identityVerified: Boolean(c.identity_verified),
      businessVerified: Boolean(c.business_verified),
      professionalVerified: Boolean(c.professional_verified),
      strikes: Number(c.owner_strikes || 0),
    },
    title: c.title,
    summary: c.summary,
    description: c.description,
    category: c.category,
    region: c.region,
    rewardAmount: Number(c.reward_amount),
    feeRate: Number(c.fee_rate),
    successCriteria: c.success_criteria,
    paymentTrigger: c.payment_trigger,
    evidenceRequirements: c.evidence_requirements,
    deadline: c.deadline,
    status: c.status,
    fundingStatus: c.funding_status,
    selectedSolverId: c.selected_solver_id,
    paymentDueAt: c.payment_due_at,
    moderationReasons: safeJsonParse(c.moderation_reasons_json, []),
    moderationPending: c.status === 'REVIEW' && safeJsonParse(c.moderation_reasons_json, []).length > 0,
    moderationReviewedAt: c.moderation_reviewed_at || null,
    participantCount: Number(c.participant_count || 0),
    teaserCount: Number(c.teaser_count || 0),
    shortlistedCount: Number(c.shortlisted_count || 0),
    viewCount: Number(c.view_count || 0),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function publicTeaser(t) {
  return {
    id: t.id,
    challengeId: t.challenge_id,
    solverId: t.solver_id,
    solver: {
      displayName: t.solver_name,
      trustScore: Number(t.solver_trust || 0),
      identityVerified: Boolean(t.identity_verified),
      businessVerified: Boolean(t.business_verified),
      professionalVerified: Boolean(t.professional_verified),
      strikes: Number(t.strike_count || 0),
    },
    headline: t.headline,
    capability: t.capability,
    approach: t.approach,
    expectedDays: Number(t.expected_days),
    maskedEvidence: t.masked_evidence,
    qualificationType: t.qualification_type,
    qualificationRef: t.qualification_ref,
    status: t.status,
    createdAt: t.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_JSON_BYTES) return problem(413, 'PAYLOAD_TOO_LARGE', '입력 내용이 너무 큽니다.');
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) return problem(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해주세요.');
  try {
    const text = await request.text();
    if (encoder.encode(text).byteLength > MAX_JSON_BYTES) return problem(413, 'PAYLOAD_TOO_LARGE', '입력 내용이 너무 큽니다.');
    return text ? JSON.parse(text) : {};
  } catch {
    return problem(400, 'INVALID_JSON', '요청 형식이 올바르지 않습니다.');
  }
}

function safeJsonParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function cleanText(value, min = 0, max = 500) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (text.length < min || text.length > max) return '';
  return text;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function maskEmail(value) {
  const [local, domain] = normalizeEmail(value).split('@');
  if (!local || !domain) return '';
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, Math.min(3, local.length - 1));
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`;
}

function escapeHtmlAttribute(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^\d{9,15}$/.test(digits) ? digits : '';
}

function optionalBirthYear(value) {
  if (value === '' || value === undefined || value === null) return 0;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= new Date().getUTCFullYear() ? year : 0;
}

function escapeEmailHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
}

function normalizeFutureDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 3600_000) return '';
  return date.toISOString();
}

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    return url.toString().slice(0, 1000);
  } catch {
    return '';
  }
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return 0;
  return n;
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function formatWon(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function canonicalPasswordMaterial(value, expectedBytes) {
  if (typeof value !== 'string' || value.length > 128) return '';
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length !== expectedBytes || bytesToBase64(bytes) !== value) return '';
    return value;
  } catch {
    return '';
  }
}

async function hashPasswordVerifier(passwordVerifier) {
  const verifier = base64ToBytes(passwordVerifier);
  const digest = await crypto.subtle.digest('SHA-256', verifier);
  return `${PASSWORD_HASH_PREFIX}${bytesToBase64(new Uint8Array(digest))}`;
}

async function fallbackPasswordSalt(email) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`modu-challenge-login-options-v1:${email}`),
  );
  return bytesToBase64(new Uint8Array(digest).slice(0, PASSWORD_SALT_BYTES));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function cookieValue(header, name) {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function enforceSameOrigin(request, url) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return null;
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  try {
    if (new URL(origin).origin !== url.origin) return problem(403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  } catch {
    return problem(403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
  }
  return null;
}

function cookieSecureAttribute(request) {
  try { return new URL(request.url).protocol === 'https:' ? '; Secure' : ''; }
  catch { return '; Secure'; }
}

function apiHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: apiHeaders(extraHeaders) });
}

function problem(status, code, message, details) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

async function audit(env, actorId, action, resourceType, resourceId, before, after) {
  return env.DB.prepare(`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(makeId('aud'), actorId, action, resourceType, resourceId,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
}

function auditStatement(env, actorId, action, resourceType, resourceId, before, after) {
  return env.DB.prepare(`
    INSERT INTO audit_logs (id, actor_id, action, resource_type, resource_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(makeId('aud'), actorId, action, resourceType, resourceId,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
