import { entityApi, entityConfigured, purgeEntityEvidence } from './entity-verification.mjs';
import { createTestOrder, transitionTestOrder } from './transactions.mjs';
import { executeProviderOperation, reconcileProviderOperation, reconcileWebhook, reconcilePendingOperations } from './provider-operations.mjs';
import { LIVE_FINANCIAL_ADAPTERS_RELEASED, identityConfigured, launchReadiness } from './launch-readiness.mjs';
import { identityApi, IDENTITY_CONSENT_VERSION } from './identity.mjs';
import { simulationApi } from './simulation.mjs';
import { legacyNotificationText } from '../public/assets/brand.js';
import { calculateSettlement, calculateStrikeOutcome } from '../public/assets/business-rules.js';

/**
 * 모두의클리어 API Worker
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
const HIGH_REWARD_REVIEW_AMOUNT = 500_000;
const MODERATION_POLICY_VERSION = '2026-09-22-v2';
const ACTOR_TYPES = new Set(['individual', 'business', 'corporation', 'organization']);
const REGIONS = new Set(['전국', '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주', '해외']);
const CHALLENGE_INTENTS = new Set(['owner', 'solver', 'both']);
const GENDERS = new Set(['female', 'male']);


function environmentName(env) {
  return String(env.APP_ENV || 'unknown').trim().toLowerCase();
}

function isLocalMoneySimulation(env) {
  return ['development', 'test'].includes(environmentName(env)) && env.LOCAL_MONEY_SIMULATION !== 'false';
}

function isPublicMoneyEnabled(env) {
  return LIVE_FINANCIAL_ADAPTERS_RELEASED && String(env.PUBLIC_MONEY_ENABLED || 'false').trim().toLowerCase() === 'true';
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
      if (String(error).includes('MODU_PHONE_EXISTS')) return problem(409, 'PHONE_EXISTS', '이미 가입에 사용된 휴대전화 번호입니다.');
      if (String(error).includes('MODU_DISPLAY_NAME_EXISTS')) return problem(409, 'DISPLAY_NAME_EXISTS', '이미 사용 중인 활동명입니다.');
      if (String(error).includes('UNIQUE constraint failed: users.email')) return problem(409, 'EMAIL_EXISTS', '이미 가입된 이메일입니다. 로그인 또는 인증메일 재발송을 이용해주세요.');
      if(error?.code && Number.isInteger(error.status)) return problem(error.status,error.code,({ENTITY_REVIEW_NOT_READY:'자격 심사 보안 설정·정책 승인 전입니다.',IDENTITY_REQUIRED:'기관 본인확인이 먼저 필요합니다.',SELF_REVIEW_DENIED:'본인 신청은 직접 승인할 수 없습니다.',REGISTRY_CHECK_REQUIRED:'최근 사업자 진위 확인이 필요합니다.',STALE_REVISION:'정보가 변경되었습니다. 새로고침 후 다시 확인해주세요.',EVIDENCE_REQUIRED:'필수 증빙을 첨부해주세요.',NTS_PROVIDER_REQUIRED:'국세청 진위확인 API 연결이 필요합니다.',ENTITY_ALREADY_REPRESENTED:'이미 다른 계정에서 확인한 등록 주체입니다. 대표·위임 권한 변경 심사가 필요합니다.',CASE_ALREADY_EXISTS:'진행 중인 신청을 먼저 확인해주세요.',EVIDENCE_SIZE_LIMIT:'증빙 이미지를 512KB 이하로 줄여주세요.',EVIDENCE_EXPIRED:'증빙 보유기간이 끝나 파기되었습니다.',CASE_NOT_REVIEWABLE:'현재 상태에서는 심사를 진행할 수 없습니다.',REGISTRY_UNAVAILABLE:'국세청 조회에 실패했습니다. 잠시 후 다시 확인해주세요.',PROVIDER_SANDBOX_NOT_CONFIGURED:'업체 테스트 환경이 연결되지 않았습니다.',OPERATION_ALREADY_RESERVED:'이미 접수된 거래입니다. 재요청하지 말고 대사 결과를 확인해주세요.'})[error.code] || '요청 조건을 확인하지 못했습니다. 상태를 새로 확인해주세요.');
      console.error('Unhandled API error', error?.name || 'Error');
      return problem(500, 'INTERNAL_ERROR', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      processOverdueFunding(env),
      purgeEntityEvidence(env),
      reconcilePendingOperations(env),
      autoReviewPendingChallenges(env),
    ]));
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

  if (path === '/api/simulations' || path.startsWith('/api/simulations/')) {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user.is_admin) return problem(403, 'ADMIN_REQUIRED', '가상 결제·지급 테스트는 운영 관리자만 이용할 수 있습니다.');
    const body = method === 'POST' ? await readJson(request) : {};
    if (body instanceof Response) return body;
    const result = await simulationApi({ method, path, body, user, env });
    return json(result.data, result.status, { 'Cache-Control': 'private, no-store' });
  }

  if (path.startsWith('/api/me/entity-cases') || path.startsWith('/api/admin/entity-cases')) {
    const admin=path.startsWith('/api/admin/');
    const user=admin?await requirePrimaryAdmin(request,env):await requireAuth(request,env);
    if(user instanceof Response)return user;
    return entityApi({request,env,user,admin,path,method,json});
  }
  if(path==='/api/provider-webhooks/toss'){
    if(env.APP_ENV!=='test'||env.PROVIDER_SANDBOX_ENABLED!=='true')return problem(503,'MONEY_FLOW_DISABLED','실거래 웹훅은 아직 개방되지 않았습니다.');
    if(method!=='POST')return problem(405,'METHOD_NOT_ALLOWED','POST 요청만 지원합니다.');
    const body=await readJson(request);if(body instanceof Response)return body;
    return json(await reconcileWebhook(env,body));
  }
  if(path.startsWith('/api/transactions/test/')&&env.APP_ENV==='test'&&env.PROVIDER_SANDBOX_ENABLED==='true'){
    const user=await requireAuth(request,env);if(user instanceof Response)return user;
    if(method!=='POST')return problem(405,'METHOD_NOT_ALLOWED','POST 요청만 지원합니다.');
    const body=await readJson(request);if(body instanceof Response)return body;
    const key=request.headers.get('Idempotency-Key');
    if(path==='/api/transactions/test/orders'){
      const mission=await fetchChallenge(body.challengeId,env);
      if(!mission||mission.owner_id!==user.id)return problem(403,'OWNER_ONLY','의뢰자만 요청할 수 있습니다.');
      const gate=await verifiedPartiesGate(mission,null,{...env,VERIFICATION_ENFORCEMENT:"required"});if(gate)return gate;
      return json(await createTestOrder(env,{challengeId:mission.id,ownerId:user.id,solverId:mission.selected_solver_id,amount:mission.reward_amount,requestKey:key}),201);
    }
    const match=path.match(/^\/api\/transactions\/test\/orders\/([^/]+)\/(action|provider|reconcile)$/);
    if(!match)return problem(404,'NOT_FOUND','거래 경로가 없습니다.');
    const order=await env.DB.prepare("SELECT * FROM transaction_orders WHERE id=? AND mode='TEST'").bind(match[1]).first();
    if(!order)return problem(404,'ORDER_NOT_FOUND','거래가 없습니다.');
    const admin=await requirePrimaryAdmin(request,env),primary=!(admin instanceof Response);
    if(![order.owner_id,order.solver_id].includes(user.id)&&!primary)return problem(403,'PARTY_REQUIRED','당사자만 확인할 수 있습니다.');
    if(match[2]==='action'){
      if(!['REQUEST_PAYMENT','REQUEST_REFUND','SUBMIT_PROOF','REJECT_PROOF','ACCEPT_PROOF','CANCEL','OPEN_DISPUTE','RESOLVE_REFUND','RESOLVE_PAYOUT','QUEUE_PAYOUT'].includes(body.action))return problem(403,'PROVIDER_ONLY','기관 결과는 직접 입력할 수 없습니다.');
      const operator=['RESOLVE_REFUND','RESOLVE_PAYOUT','QUEUE_PAYOUT'].includes(body.action);
      if(operator&&!primary)return problem(403,'PRIMARY_ADMIN_REQUIRED','최고관리자 확인이 필요합니다.');
      const mission=await fetchChallenge(order.challenge_id,env);const gate=await verifiedPartiesGate(mission,null,{...env,VERIFICATION_ENFORCEMENT:"required"});if(gate)return gate;
      return json(await transitionTestOrder(env,{orderId:order.id,requestKey:key,action:body.action,actorId:operator?'TEST_OPERATOR':user.id,revision:body.revision,reason:body.reason||''}));
    }
    if(match[2]==='provider'){
      if(body.kind==='PAYOUT'&&!primary)return problem(403,'PRIMARY_ADMIN_REQUIRED','최고관리자 확인이 필요합니다.');
      const mission=await fetchChallenge(order.challenge_id,env);const gate=await verifiedPartiesGate(mission,null,{...env,VERIFICATION_ENFORCEMENT:"required"});if(gate)return gate;
      return json(await executeProviderOperation(env,{orderId:order.id,kind:body.kind,actorId:body.kind==='PAYOUT'?'TEST_OPERATOR':user.id,requestKey:key,paymentKey:body.paymentKey,reason:body.reason||''}));
    }
    const op=await env.DB.prepare('SELECT id FROM provider_operations WHERE id=? AND order_id=?').bind(body.operationId,order.id).first();
    if(!op)return problem(404,'OPERATION_NOT_FOUND','처리 요청이 없습니다.');
    return json(await reconcileProviderOperation(env,op.id,primary?body.providerReference:null));
  }
  if (method === 'GET' && path === '/api/launch-readiness') return json(launchReadiness(env));
  if (path.startsWith('/api/transactions') && method !== 'GET') return problem(503, 'MONEY_FLOW_DISABLED', '실제 결제·환불·지급은 업체 연동과 검증 완료 전까지 차단됩니다.');
  if (method === 'GET' && path === '/api/me/transactions') {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    const rows = await env.DB.prepare("SELECT id,challenge_id,amount,fee,net,currency,state,created_at,updated_at FROM transaction_orders WHERE mode='LIVE' AND (owner_id=? OR solver_id=?) ORDER BY created_at DESC LIMIT 100").bind(user.id,user.id).all();
    return json({transactions: rows.results, moneyMode: moneyFlowMode(env)});
  }
  if (method === 'POST' && ['/api/me/identity/start','/api/me/identity/complete'].includes(path)) {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    return identityApi({action:path.endsWith('/start')?'start':'complete',user,body,env,json,problem,auditStatement});
  }
  if (method === 'GET' && path === '/api/admin/verification-reviews') {
    const admin = await requirePrimaryAdmin(request, env);
    if (admin instanceof Response) return admin;
    const rows = await env.DB.prepare("SELECT id,user_id,verification_type,subject_type,status,status_reason,verified_at,expires_at,created_at FROM member_verifications ORDER BY updated_at DESC LIMIT 100").all();
    await audit(env,admin.id,'VERIFICATION_REVIEW_LIST','verification',null,null,{count:rows.results.length});
    return json({verifications:rows.results,readiness:launchReadiness(env)});
  }
  if (method === 'POST' && path === '/api/admin/verification-reviews') return reviewMemberVerification(request,env);

  if (method === 'GET' && path === '/api/bootstrap') return publicBootstrap(url, env);
  if (method === 'POST' && path === '/api/admin/home-theme') return updateHomeTheme(request, env);

  if (method === 'POST' && path === '/api/internal/bootstrap-admin') return bootstrapAdmin(request, env);
  if (method === 'POST' && path === '/api/internal/payout/confirm') return confirmPayoutWebhook(request, env);

  if (method === 'POST' && path === '/api/auth/signup') return signup(request, env);
  if (method === 'GET' && path === '/api/auth/oauth-signup') return oauthSignupInfo(request, env);
  if (method === 'POST' && path === '/api/auth/oauth-signup') {
    const pending = await pendingOAuthSignup(request, env);
    if (!pending) return problem(401, 'OAUTH_SIGNUP_EXPIRED', '소셜 가입 확인이 만료되었습니다. 소셜 로그인부터 다시 진행해주세요.');
    return signup(request, env, pending);
  }
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
  if (method === 'GET' && path === '/api/me/verifications') return getMyVerifications(request, env);
  if (method === 'POST' && path === '/api/me/verifications/requests') return requestMemberVerification(request, env);
  if (method === 'POST' && path === '/api/me/actor-profiles') return saveActorProfile(request, env);
  if (method === 'GET' && path === '/api/me/push-settings') return getPushSettings(request, env);
  if (method === 'POST' && path === '/api/me/push-subscriptions') return savePushSubscription(request, env);
  if (method === 'POST' && path === '/api/me/push-subscriptions/remove') return removePushSubscription(request, env);

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
  if (match && method === 'PUT') return updateChallenge(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/cancel$/);
  if (match && method === 'POST') return cancelChallenge(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/disputes$/);
  if (match && method === 'POST') return openDispute(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/moderation\/appeals$/);
  if (match && method === 'POST') return createModerationAppeal(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/my-teaser$/);
  if (match && method === 'GET') return getMyTeaser(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/teasers$/);
  if (match && method === 'POST') return submitTeaser(match[1], request, env);
  if (match && method === 'GET') return listTeasers(match[1], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/teasers\/([^/]+)$/);
  if (match && method === 'PUT') return updateTeaser(match[1], match[2], request, env);

  match = path.match(/^\/api\/challenges\/([^/]+)\/teasers\/([^/]+)\/withdraw$/);
  if (match && method === 'POST') return withdrawTeaser(match[1], match[2], request, env);

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
  if (method === 'GET' && path === '/api/admin/moderation-queue') return moderationQueue(request, env);
  if (method === 'POST' && path === '/api/admin/moderation/auto-review') return autoReviewModerationQueue(request, env);
  if (method === 'POST' && path === '/api/admin/push-announcements') return sendAdminPushAnnouncement(request, env);

  match = path.match(/^\/api\/admin\/challenges\/([^/]+)\/moderation\/approve$/);
  if (match && method === 'POST') return approveModerationChallenge(match[1], request, env);

  match = path.match(/^\/api\/admin\/challenges\/([^/]+)\/moderation\/archive$/);
  if (match && method === 'POST') return archiveModerationChallenge(match[1], request, env);

  match = path.match(/^\/api\/admin\/challenges\/([^/]+)\/moderation\/notes$/);
  if (match && method === 'POST') return addModerationNote(match[1], request, env);

  match = path.match(/^\/api\/admin\/members\/([^/]+)$/);
  if (match && method === 'GET') return getAdminMemberDetail(match[1], request, env);

  match = path.match(/^\/api\/admin\/members\/([^/]+)\/status$/);
  if (match && method === 'POST') return updateAdminMemberStatus(match[1], request, env);

  match = path.match(/^\/api\/admin\/disputes\/([^/]+)$/);
  if (match && method === 'GET') return getAdminDisputeDetail(match[1], request, env);

  match = path.match(/^\/api\/admin\/disputes\/([^/]+)\/status$/);
  if (match && method === 'POST') return updateAdminDisputeStatus(match[1], request, env);

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
  const displayName = cleanText(body.displayName, 2, 40) || '클리어 회원';
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

async function signup(request, env, oauth = null) {
  const body = await readJson(request);
  if (body instanceof Response) return body;

  const email = normalizeEmail(oauth?.email || body.email);
  const displayName = cleanText(body.displayName, 2, 40);
  const realName = cleanText(body.realName, 2, 40);
  if (body.realName !== undefined && !realName) return problem(400, 'INVALID_REAL_NAME', '이름을 2자 이상 입력해주세요.');
  const passwordSalt = oauth ? bytesToBase64(crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES))) : canonicalPasswordMaterial(body.passwordSalt, PASSWORD_SALT_BYTES);
  const passwordVerifier = oauth ? bytesToBase64(crypto.getRandomValues(new Uint8Array(PASSWORD_VERIFIER_BYTES))) : canonicalPasswordMaterial(body.passwordVerifier, PASSWORD_VERIFIER_BYTES);
  // Account type and owner/solver are legacy compatibility fields only. A
  // member chooses an activity subject type when creating or joining a mission.
  const accountType = 'individual';
  const phone = normalizePhone(body.phone);
  const region = cleanText(body.region, 2, 20);
  const challengeIntent = 'both';
  const birthYear = optionalBirthYear(body.birthYear);
  const gender = GENDERS.has(body.gender) ? body.gender : '';
  const interests = cleanText(body.interests, 0, 300);
  const organizationName = cleanText(body.organizationName, 0, 100);
  const marketingAccepted = body.marketingAccepted === true;

  if (!EMAIL_RE.test(email)) return problem(400, 'INVALID_EMAIL', '올바른 이메일을 입력해주세요.');
  if (!displayName) return problem(400, 'INVALID_NAME', '활동명을 2자 이상 입력해주세요.');
  if (!phone) return problem(400, 'INVALID_PHONE', '연락 가능한 휴대전화 번호를 입력해주세요.');
  if (!REGIONS.has(region)) return problem(400, 'INVALID_REGION', '활동 지역을 선택해주세요.');
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
  const [emailExists, phoneExists, displayNameExists] = await Promise.all([
    env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email).first(),
    env.DB.prepare("SELECT id FROM users WHERE CASE WHEN replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') LIKE '82%' THEN '0' || substr(replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', ''), 3) ELSE replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') END = ? LIMIT 1").bind(phone).first(),
    env.DB.prepare('SELECT id FROM users WHERE lower(trim(display_name)) = lower(?) LIMIT 1').bind(displayName).first(),
  ]);
  if (emailExists) {
    await recordAuthAttempt(env, 'SIGNUP', rate, false);
    return problem(409, 'EMAIL_EXISTS', '이미 가입된 이메일입니다. 로그인 또는 이메일 찾기를 이용해주세요.');
  }
  if (phoneExists) {
    await recordAuthAttempt(env, 'SIGNUP', rate, false);
    return problem(409, 'PHONE_EXISTS', '이미 가입에 사용된 휴대전화 번호입니다. 이메일 찾기를 이용해주세요.');
  }
  if (displayNameExists) {
    await recordAuthAttempt(env, 'SIGNUP', rate, false);
    return problem(409, 'DISPLAY_NAME_EXISTS', '이미 사용 중인 활동명입니다. 다른 활동명을 입력해주세요.');
  }

  const id = makeId('usr');
  const passwordHash = await hashPasswordVerifier(passwordVerifier);
  const defaultLimit = parsePositiveInt(env.OWNER_DEFAULT_BOUNTY_LIMIT, 100_000_000);

  const verificationRequired = oauth?.provider === 'google' ? false : emailVerificationEnabled(env);
  if (oauth?.provider === 'naver' && !verificationRequired) return problem(503, 'EMAIL_VERIFICATION_UNAVAILABLE', 'NAVER 신규 가입은 이메일 인증 설정 후 이용할 수 있습니다.');
  const createUser = env.DB.prepare(`
    INSERT INTO users (
      id, email, password_hash, password_salt, display_name, account_type,
      identity_verified, trust_score, bounty_limit,
      terms_version, terms_accepted_at, privacy_version, privacy_accepted_at,
      real_name, phone, region, challenge_intent, birth_year, gender, interests, organization_name,
      marketing_consent, marketing_consent_at, signup_source, email_verification_requested_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 50, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, email, passwordHash, passwordSalt, displayName, accountType, defaultLimit,
    env.TERMS_VERSION || '2026-08-28-v1', env.PRIVACY_VERSION || '2026-08-31-v2',
    realName || null, phone, region, challengeIntent, birthYear, gender, interests || null, organizationName || null,
    marketingAccepted ? 1 : 0, marketingAccepted ? new Date().toISOString() : null, oauth?.provider || 'password',
    verificationRequired ? new Date().toISOString() : null);
  if (oauth) {
    await env.DB.batch([
      createUser,
      env.DB.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email) VALUES (?, ?, ?, ?, ?)').bind(makeId('oid'), id, oauth.provider, oauth.subject, email),
      env.DB.prepare('UPDATE oauth_signup_pending SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND used_at IS NULL').bind(oauth.token_hash),
      env.DB.prepare('UPDATE users SET email_verified = ?, email_verified_at = ? WHERE id = ?').bind(oauth.provider === 'google' ? 1 : 0, oauth.provider === 'google' ? new Date().toISOString() : null, id),
    ]);
  } else await createUser.run();

  await recordAuthAttempt(env, 'SIGNUP', rate, true);
  await audit(env, id, 'USER_SIGNUP', 'user', id, null, { email, accountType, region, challengeIntent, verificationRequired });

  if (verificationRequired) {
    const sent = await issueEmailVerification(env, request, { id, email, displayName });
    return json({ ok: true, pendingVerification: true, email, loginProvider: oauth?.provider || 'password', deliveryPending: !sent.ok }, sent.ok ? 201 : 202);
  }

  const session = await createSession(id, request, env);

  return json({ user: publicUser({
    id, email, display_name: displayName, account_type: accountType,
    status: 'active', is_admin: 0, identity_verified: 0,
    business_verified: 0, professional_verified: 0, trust_score: 50,
    strike_count: 0, bounty_limit: defaultLimit, email_verified: oauth?.provider === 'google' ? 1 : 0,
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
  const user = await env.DB.prepare('SELECT signup_source FROM users WHERE id = ?').bind(verification.user_id).first();
  return json({ ok: true, loginProvider: ['google', 'naver'].includes(user?.signup_source) ? user.signup_source : 'password' });
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
    WHERE (lower(trim(display_name)) = lower(?) OR lower(trim(real_name)) = lower(?))
      AND CASE WHEN replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') LIKE '82%' THEN '0' || substr(replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', ''), 3) ELSE replace(replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '+', '') END = ?
    LIMIT 1
  `).bind(displayName, displayName, phone).first();
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
      sender: { name: '모두의클리어', email: String(env.BREVO_SENDER_EMAIL) },
      to: [{ email: user.email, name: user.display_name }],
      subject: '[모두의클리어] 이메일 인증을 완료해주세요',
      htmlContent: `<p>${escapeEmailHtml(user.display_name)}님, 모두의클리어 가입을 완료하려면 아래 버튼을 눌러주세요.</p><p><a href="${verificationUrl}">이메일 인증 완료</a></p><p>이 링크는 24시간 동안 유효합니다.</p>`,
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
      sender: { name: '모두의클리어', email: String(env.BREVO_SENDER_EMAIL) },
      to: [{ email: user.email, name: user.display_name }],
      subject: '[모두의클리어] 비밀번호 재설정',
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
  const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(12000), method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(tokenBody) }).catch(() => null);
  const token = tokenResponse?.ok ? await tokenResponse.json().catch(() => null) : null;
  if (!token?.access_token) return null;
  if (provider === 'google') {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token.access_token}` } }).catch(() => null);
    const data = response?.ok ? await response.json().catch(() => null) : null;
    if (!data?.sub || !data?.email || data.email_verified !== true) return null;
    return { subject: String(data.sub), email: normalizeEmail(data.email), emailVerified: true, displayName: cleanText(data.name || data.given_name, 2, 40) || 'Google 회원' };
  }
  const response = await fetch('https://openapi.naver.com/v1/nid/me', { signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token.access_token}` } }).catch(() => null);
  const data = response?.ok ? await response.json().catch(() => null) : null;
  const profile = data?.response;
  if (!profile?.id || !profile?.email) return null;
  return { subject: String(profile.id), email: normalizeEmail(profile.email), emailVerified: false, displayName: cleanText(profile.name || profile.nickname, 2, 40) || 'NAVER 회원' };
}

async function findOrCreateOAuthUser(env, provider, profile) {
  let identity = await env.DB.prepare('SELECT user_id FROM auth_identities WHERE provider = ? AND provider_subject = ?').bind(provider, profile.subject).first();
  if (identity?.user_id) {
    const linkedUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(identity.user_id).first();
    return verifyOAuthEmailForExistingUser(env, linkedUser, provider, profile);
  }
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(profile.email).first();
  if (!user || ['closed', 'suspended'].includes(user.status)) return user || null;
  user = await verifyOAuthEmailForExistingUser(env, user, provider, profile);
  if (!user?.email_verified) return user || null;
  await env.DB.prepare(`INSERT INTO auth_identities (id, user_id, provider, provider_subject, provider_email, last_login_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, provider_subject) DO NOTHING`)
    .bind(makeId('oid'), user.id, provider, profile.subject, profile.email).run();
  return user;
}

async function verifyOAuthEmailForExistingUser(env, user, provider, profile) {
  if (!user || user.email_verified || !profile.emailVerified || provider !== 'google' || ['closed', 'suspended'].includes(user.status)) return user;
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET email_verified = 1, email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id),
    env.DB.prepare('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').bind(user.id),
    auditStatement(env, user.id, 'OAUTH_VERIFIED_EMAIL_LINK', 'user', user.id, { emailVerified: false }, { emailVerified: true, provider }),
  ]);
  return { ...user, email_verified: 1, email_verified_at: new Date().toISOString() };
}


function safeOAuthReturn(value) {
  const route = String(value || '');
  return /^#\/(home|explore|dashboard|profile|create|how|trust)(\?[a-zA-Z0-9_%=&.-]*)?$/.test(route) ? route : '#/home';
}
async function pendingOAuthSignup(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), 'mc_oauth_signup');
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM oauth_signup_pending WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP').bind(await sha256(token)).first();
}
async function oauthSignupInfo(request, env) {
  const pending = await pendingOAuthSignup(request, env);
  if (!pending) return problem(401, 'OAUTH_SIGNUP_EXPIRED', '소셜 가입 확인이 만료되었습니다. 소셜 로그인부터 다시 진행해주세요.');
  return json({ provider: pending.provider, email: pending.email, displayName: pending.display_name });
}

function oauthCompletionPage(request, { target, cookie = '' }) {
  // Safari can reject a redirect response from an OAuth callback when a PWA
  // service worker is active. Return a short no-store document instead, then
  // continue on the same origin without losing the newly issued session.
  const destination = new URL(target, new URL(request.url).origin).href;
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>모두의클리어</title></head><body><p>모두의클리어로 돌아가는 중입니다…</p><script>setTimeout(function(){window.location.replace(${JSON.stringify(destination)});},80);</script></body></html>`, {
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
  await env.DB.prepare(`INSERT INTO oauth_authorizations (id, provider, state_hash, expires_at, return_route)
    VALUES (?, ?, ?, datetime('now', '+10 minutes'), ?)`).bind(makeId('oas'), provider, await sha256(state), safeOAuthReturn(url.searchParams.get('returnTo'))).run();
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
  if (!config || !state || !constantTimeEqual(state, cookieState)) return oauthFailure(request, '소셜 로그인 확인이 만료되었습니다. 다시 시도해주세요.');
  const authorization = await env.DB.prepare(`SELECT id, return_route FROM oauth_authorizations
    WHERE provider = ? AND state_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).bind(provider, await sha256(state)).first();
  if (!authorization) return oauthFailure(request, '소셜 로그인 확인이 만료되었습니다. 다시 시도해주세요.');
  await env.DB.prepare('UPDATE oauth_authorizations SET used_at = CURRENT_TIMESTAMP WHERE id = ?').bind(authorization.id).run();
  const providerError = url.searchParams.get('error');
  if (providerError) {
    const message = providerError === 'access_denied'
      ? '소셜 로그인이 승인되지 않았습니다. 계정의 정보 제공 동의와 서비스 이용 가능 여부를 확인한 뒤 다시 시도해주세요.'
      : '소셜 로그인 제공자에서 요청을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.';
    return oauthFailure(request, message);
  }
  if (!code) return oauthFailure(request, '소셜 로그인 응답을 확인하지 못했습니다. 다시 시도해주세요.');
  const profile = await fetchOAuthProfile(provider, config, code, `${url.origin}/api/auth/oauth/${provider}/callback`, state);
  if (!profile) return oauthFailure(request, '소셜 계정의 이메일 정보를 확인하지 못했습니다. 로그인 제공 화면에서 이메일 정보 제공에 동의했는지 확인해주세요.');
  const user = await findOrCreateOAuthUser(env, provider, profile);
  if (!user) {
    const signupToken = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare(`INSERT INTO oauth_signup_pending (token_hash, provider, subject, email, display_name, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+10 minutes'))`).bind(await sha256(signupToken), provider, profile.subject, profile.email, profile.displayName).run();
    return oauthCompletionPage(request, { target: `${url.origin}/#/social-signup`, cookie: `mc_oauth_signup=${signupToken}; Path=/api/auth/; HttpOnly${cookieSecureAttribute(request)}; SameSite=Lax; Max-Age=600` });
  }
  if (['closed', 'suspended'].includes(user.status)) return oauthFailure(request, '현재 이용할 수 없는 계정입니다.');
  if (!user.email_verified) return oauthFailure(request, '가입 이메일 인증을 완료한 뒤 소셜 로그인을 사용할 수 있습니다.');
  const session = await createSession(user.id, request, env);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id),
    auditStatement(env, user.id, 'OAUTH_LOGIN', 'user', user.id, null, { provider }),
  ]);
  return oauthCompletionPage(request, {
    target: `${url.origin}/${safeOAuthReturn(authorization.return_route)}${safeOAuthReturn(authorization.return_route).includes('?') ? '&' : '?'}oauth=success`,
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
    const session = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
    const body = await readJson(request);
    if (session && !(body instanceof Response) && typeof body.endpoint === 'string' && body.endpoint) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(session.user_id, body.endpoint).run();
    }
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
    notifications: (notifications.results || []).map((item) => ({ ...item, title: legacyNotificationText(item.title), body: legacyNotificationText(item.body) })),
  });
}

function verificationRequirements(subjectType) {
  return ({
    individual: ['IDENTITY'],
    business: ['IDENTITY', 'BUSINESS'],
    corporation: ['IDENTITY', 'CORPORATION'],
    organization: ['IDENTITY', 'ORGANIZATION'],
  })[subjectType] || ['IDENTITY'];
}

function verificationProviderConfigured(type, env) {
  return type === 'IDENTITY' ? identityConfigured(env) : entityConfigured(env);
}

function verificationEnforcement(env) {
  if (!['test','development'].includes(environmentName(env))) return 'required';
  return env.VERIFICATION_ENFORCEMENT === 'advisory' ? 'advisory' : 'required';
}

function verificationIsReusable(row) {
  if (!row || row.status !== 'VERIFIED' || row.revoked_at || !((row.verification_type==='IDENTITY'&&row.provider==='portone-v2')||(row.verification_type!=='IDENTITY'&&row.provider==='entity-review-v1')) || !row.provider_reference_hash || !row.verified_at || !row.expires_at) return false;
  return Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.now();
}

function publicVerification(row) {
  return {
    id: row.id,
    type: row.verification_type,
    subjectType: row.subject_type,
    status: verificationIsReusable(row) ? 'VERIFIED' : (row.status === 'VERIFIED' ? 'EXPIRED' : row.status),
    provider: row.provider ? (row.provider === 'legacy' ? '기존 인증 이관' : row.provider === 'entity-review-v1' ? '사업자·단체 자격 심사' : '외부 인증기관') : null,
    subjectName: row.subject_name ? `${String(row.subject_name).slice(0, 1)}***` : null,
    verifiedAt: row.verified_at || null,
    expiresAt: row.expires_at || null,
    reason: row.status_reason || null,
  };
}

async function ensureActorProfile(user, subjectType, env) {
  let profile = await env.DB.prepare('SELECT * FROM member_actor_profiles WHERE user_id = ? AND subject_type = ?')
    .bind(user.id, subjectType).first();
  if (profile) return profile;
  const id = makeId('act');
  await env.DB.prepare(`INSERT INTO member_actor_profiles
    (id, user_id, subject_type, activity_name, organization_name, public_fields_json)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, user.id, subjectType, user.display_name, user.organization_name || null,
      JSON.stringify({ activityName: true, verificationBadges: true, activityHistory: true, ratings: true })).run();
  profile = await env.DB.prepare('SELECT * FROM member_actor_profiles WHERE id = ?').bind(id).first();
  return profile;
}

async function memberVerificationContext(user, subjectType, env) {
  const profile = await ensureActorProfile(user, subjectType, env);
  const rows = await env.DB.prepare('SELECT * FROM member_verifications WHERE user_id = ? ORDER BY created_at DESC')
    .bind(user.id).all();
  const requirements = verificationRequirements(subjectType).map((type) => {
    // IDENTITY is member-scoped and is reusable across every activity subject type.
    const candidates = (rows.results || []).filter((item) => item.verification_type === type && (type === 'IDENTITY' || item.subject_type === subjectType));
    const row = candidates.find(verificationIsReusable) || candidates[0];
    return { type, satisfied: verificationProviderConfigured(type, env) && verificationIsReusable(row), providerConfigured: verificationProviderConfigured(type, env), verification: row ? publicVerification(row) : null };
  });
  return {
    profile,
    requirements,
    eligible: requirements.every((item) => item.satisfied),
    enforcement: verificationEnforcement(env),
    snapshot: {
      subjectType,
      capturedAt: new Date().toISOString(),
      requirements: requirements.map(({ type, satisfied, verification }) => ({ type, satisfied, verificationId: verification?.id || null, status: verification?.status || 'UNVERIFIED' })),
    },
  };
}

function verificationGate(context) {
  if (context.eligible || context.enforcement === 'advisory') return null;
  return problem(409, 'VERIFICATION_REQUIRED', '이 활동에 필요한 인증이 없거나 만료되었습니다. 인증 관리에서 부족한 인증만 진행해주세요.', {
    requirements: context.requirements,
  });
}

async function getMyVerifications(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const [verifications, profiles] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM member_verifications WHERE user_id = ? ORDER BY created_at DESC').bind(user.id),
    env.DB.prepare('SELECT * FROM member_actor_profiles WHERE user_id = ? ORDER BY created_at ASC').bind(user.id),
  ]);
  return json({
    identityConsentVersion: IDENTITY_CONSENT_VERSION,
    identityAvailable: identityConfigured(env),
    enforcement: verificationEnforcement(env),
    providerConnectionRequired: !['IDENTITY', 'BUSINESS', 'CORPORATION', 'ORGANIZATION'].some((type) => verificationProviderConfigured(type, env)),
    verifications: (verifications.results || []).map(publicVerification),
    actorProfiles: (profiles.results || []).map((profile) => ({
      id: profile.id, subjectType: profile.subject_type, activityName: profile.activity_name,
      organizationName: profile.organization_name, industry: profile.industry, companyIntro: profile.company_intro,
      publicFields: safeJsonParse(profile.public_fields_json, {}),
    })),
    requirementsBySubjectType: Object.fromEntries([...ACTOR_TYPES].map((type) => [type, verificationRequirements(type)])),
  }, 200, { 'Cache-Control': 'private, no-store' });
}

async function requestMemberVerification(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const subjectType = ACTOR_TYPES.has(body.subjectType) ? body.subjectType : '';
  const type = String(body.type || '').toUpperCase();
  if (!subjectType || !verificationRequirements(subjectType).includes(type)) {
    return problem(400, 'INVALID_VERIFICATION_REQUEST', '활동 주체와 필요한 인증 유형을 확인해주세요.');
  }
  const providerConfigured = verificationProviderConfigured(type, env);
  const status = providerConfigured ? 'REQUESTED' : 'PROVIDER_REQUIRED';
  const existing = await env.DB.prepare(`SELECT * FROM member_verifications
    WHERE user_id = ? AND verification_type = ? AND (subject_type = ? OR verification_type = 'IDENTITY') LIMIT 1`)
    .bind(user.id, type, subjectType).first();
  if (providerConfigured && existing && verificationIsReusable(existing)) return json({ verification: publicVerification(existing), reused: true });
  const id = existing?.id || makeId('ver');
  await env.DB.prepare(`INSERT INTO member_verifications
    (id, user_id, verification_type, subject_type, status, status_reason)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, verification_type, subject_type) DO UPDATE SET
      status = excluded.status, status_reason = excluded.status_reason, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, user.id, type, type === 'IDENTITY' && existing ? existing.subject_type : subjectType, status,
      providerConfigured ? '외부 인증기관 확인 요청' : '외부 인증기관 계약·API 연결 필요').run();
  await audit(env, user.id, 'MEMBER_VERIFICATION_REQUEST', 'member_verification', id, null, { type, subjectType, status });
  const row = await env.DB.prepare('SELECT * FROM member_verifications WHERE id = ?').bind(id).first();
  return json({ verification: publicVerification(row), providerConnectionRequired: !providerConfigured }, 202);
}

async function saveActorProfile(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const subjectType = ACTOR_TYPES.has(body.subjectType) ? body.subjectType : '';
  if (!subjectType) return problem(400, 'INVALID_SUBJECT_TYPE', '활동 주체 유형을 선택해주세요.');
  const profile = await ensureActorProfile(user, subjectType, env);
  const publicFields = ['activityName', 'organizationName', 'industry', 'companyIntro', 'verificationBadges', 'activityHistory', 'ratings']
    .reduce((result, key) => ({ ...result, [key]: body.publicFields?.[key] === true }), {});
  await env.DB.prepare(`UPDATE member_actor_profiles SET activity_name = ?, organization_name = ?, industry = ?, company_intro = ?, public_fields_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`)
    .bind(cleanText(body.activityName, 0, 80) || user.display_name, cleanText(body.organizationName, 0, 120) || null,
      cleanText(body.industry, 0, 120) || null, cleanText(body.companyIntro, 0, 1000) || null,
      JSON.stringify(publicFields), profile.id, user.id).run();
  await audit(env, user.id, 'ACTOR_PROFILE_UPDATE', 'member_actor_profile', profile.id, null, { subjectType, publicFields });
  return json({ ok: true, id: profile.id, subjectType });
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

function pushConfigured(env) {
  return Boolean(String(env.VAPID_PUBLIC_KEY || '').trim() && String(env.VAPID_PRIVATE_KEY || '').trim());
}

async function getPushSettings(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  await ensurePushStorage(env);
  const row = await env.DB.prepare('SELECT id FROM push_subscriptions WHERE user_id = ? LIMIT 1').bind(user.id).first();
  return json({ configured: pushConfigured(env), publicKey: String(env.VAPID_PUBLIC_KEY || ''), subscribed: Boolean(row) });
}

async function savePushSubscription(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  if (!pushConfigured(env)) return problem(503, 'PUSH_NOT_CONFIGURED', '푸시알림은 현재 준비 중입니다.');
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const endpoint = cleanText(body?.endpoint, 10, 2048);
  const p256dh = cleanText(body?.keys?.p256dh, 10, 1024);
  const auth = cleanText(body?.keys?.auth, 10, 1024);
  if (!endpoint?.startsWith('https://') || !p256dh || !auth) return problem(400, 'INVALID_PUSH_SUBSCRIPTION', '푸시 구독 정보를 확인하지 못했습니다.');
  await ensurePushStorage(env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = CURRENT_TIMESTAMP`)
      .bind(makeId('psh'), user.id, endpoint, p256dh, auth),
    auditStatement(env, user.id, 'PUSH_SUBSCRIBE', 'push_subscription', null, null, { enabled: true }),
  ]);
  const delivered = await sendPushNotification(env, user.id, {
    title: '푸시알림이 켜졌습니다',
    body: '내 미션 관련 알림을 이 기기에서 받습니다.',
    route: 'notifications',
  });
  return json({ ok: true, subscribed: true, delivered });
}

async function removePushSubscription(request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const endpoint = cleanText(body?.endpoint, 0, 2048);
  await ensurePushStorage(env);
  await env.DB.batch([
    endpoint ? env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').bind(user.id, endpoint) : env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(user.id),
    auditStatement(env, user.id, 'PUSH_UNSUBSCRIBE', 'push_subscription', null, null, { enabled: false }),
  ]);
  return json({ ok: true, subscribed: false });
}

async function ensurePushStorage(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id, updated_at DESC)').run();
}

async function ensurePushDeliveryStorage(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_delivery_logs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, reason_code TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_push_delivery_logs_created ON push_delivery_logs(created_at DESC)').run();
}

async function ensurePushAnnouncementStorage(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_announcement_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    eligible_count INTEGER NOT NULL DEFAULT 0,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_push_announcement_logs_created ON push_announcement_logs(created_at DESC)').run();
}

// Manual announcements are intentionally restricted to the highest administrator.
// They only target accounts that previously chose to enable push notifications.
async function sendAdminPushAnnouncement(request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;
  if (!pushConfigured(env)) return problem(503, 'PUSH_NOT_CONFIGURED', '푸시 발송 설정이 아직 준비되지 않았습니다.');
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (body.confirmSend !== true) return problem(400, 'PUSH_CONFIRMATION_REQUIRED', '발송 내용을 확인한 뒤 발송 확인을 선택해주세요.');

  const title = cleanText(body.title, 2, 60);
  const message = cleanText(body.body, 2, 120);
  if (!title || !message) return problem(400, 'INVALID_PUSH_ANNOUNCEMENT', '제목은 2~60자, 내용은 2~120자로 입력해주세요.');

  await ensurePushStorage(env);
  await ensurePushAnnouncementStorage(env);
  const administratorSubscription = await env.DB.prepare(
    'SELECT id FROM push_subscriptions WHERE user_id = ? LIMIT 1',
  ).bind(primary.id).first();
  if (!administratorSubscription) {
    return problem(409, 'ADMIN_PUSH_NOT_SUBSCRIBED', '관리자 기기의 푸시알림이 아직 켜지지 않았습니다. 내 계정에서 푸시알림을 켠 뒤 확인 알림을 받은 다음 공지를 발송해주세요.');
  }
  const targetRows = await env.DB.prepare(`
    SELECT DISTINCT ps.user_id
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id
    -- The sending primary administrator is always included when they opted in,
    -- even if their account is temporarily outside the ordinary member status.
    WHERE u.status IN ('active', 'limited') OR ps.user_id = ?
    ORDER BY ps.updated_at DESC
    LIMIT 201
  `).bind(primary.id).all();
  const recipients = targetRows.results || [];
  const maximum = Math.min(parsePositiveInt(env.PUSH_ANNOUNCEMENT_MAX_RECIPIENTS, 200), 200);
  if (recipients.length > maximum) {
    return problem(409, 'PUSH_BATCH_LIMIT', '현재 발송 대상이 안전 발송 한도를 초과했습니다. 운영팀에 분할 발송을 요청해주세요.', { limit: maximum, minimumEligible: recipients.length });
  }
  if (!recipients.length) return problem(409, 'NO_PUSH_RECIPIENTS', '푸시알림을 켠 활성 회원이 아직 없습니다.');

  let delivered = 0;
  for (const recipient of recipients) {
    if (await sendPushNotification(env, recipient.user_id, { title, body: message, route: 'notifications' })) delivered += 1;
  }
  const announcementId = makeId('pann');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO push_announcement_logs (id, actor_id, title, body, eligible_count, delivered_count, failed_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(announcementId, primary.id, title, message, recipients.length, delivered, recipients.length - delivered),
    auditStatement(env, primary.id, 'PUSH_ANNOUNCEMENT_SEND', 'push_announcement', announcementId, null, {
      eligibleCount: recipients.length, deliveredCount: delivered, failedCount: recipients.length - delivered,
    }),
  ]);
  const administratorIncluded = recipients.some((recipient) => recipient.user_id === primary.id);
  return json({ ok: true, announcement: { id: announcementId, eligibleCount: recipients.length, deliveredCount: delivered, failedCount: recipients.length - delivered, administratorIncluded } });
}

// RFC 8291 / RFC 8292 Web Push.  The payload intentionally excludes profile,
// contact, and challenge-detail data; recipients open the authenticated app.
async function sendPushNotification(env, userId, { title, body, route = 'notifications', challengeId = null }) {
  if (!userId || !pushConfigured(env)) return false;
  const eligible = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status IN ('active','limited') AND EXISTS (SELECT 1 FROM sessions WHERE user_id = users.id AND expires_at > CURRENT_TIMESTAMP)").bind(userId).first();
  if (!eligible) return false;
  await ensurePushStorage(env);
  await ensurePushDeliveryStorage(env);
  const subscriptions = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5',
  ).bind(userId).all();
  if (!subscriptions.results?.length) return false;

  const payload = JSON.stringify({
    title: cleanText(legacyNotificationText(title), 1, 80),
    body: cleanText(legacyNotificationText(body), 1, 140),
    // The service worker opens this safe in-app route after a tap. Never put
    // a challenge title, reward, profile, or contact detail in the payload.
    url: challengeId ? `/#/explore?challenge=${encodeURIComponent(challengeId)}` : '/#/dashboard',
    challengeId: challengeId || undefined,
  });
  let delivered = false;
  for (const subscription of subscriptions.results) {
    try {
      const response = await deliverWebPush(subscription, payload, env);
      if (response.ok || response.status === 201 || response.status === 202) {
        delivered = true;
        await env.DB.prepare('INSERT INTO push_delivery_logs (id, user_id, status) VALUES (?, ?, ?)').bind(makeId('pdl'), userId, 'accepted').run();
      } else if (response.status === 404 || response.status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(subscription.endpoint).run();
        await env.DB.prepare('INSERT INTO push_delivery_logs (id, user_id, status, reason_code) VALUES (?, ?, ?, ?)').bind(makeId('pdl'), userId, 'expired', `HTTP_${response.status}`).run();
      } else {
        await env.DB.prepare('INSERT INTO push_delivery_logs (id, user_id, status, reason_code) VALUES (?, ?, ?, ?)').bind(makeId('pdl'), userId, 'failed', `HTTP_${response.status}`).run();
      }
    } catch (error) {
      console.warn('Push delivery failed', String(error).slice(0, 160));
      await env.DB.prepare('INSERT INTO push_delivery_logs (id, user_id, status, reason_code) VALUES (?, ?, ?, ?)').bind(makeId('pdl'), userId, 'failed', 'NETWORK_ERROR').run();
    }
  }
  return delivered;
}

async function deliverWebPush(subscription, payload, env) {
  const endpoint = new URL(subscription.endpoint);
  const clientPublicKey = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await crypto.subtle.importKey('raw', clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []) },
    serverKeys.privateKey,
    256,
  );
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const ikm = await hkdf(new Uint8Array(sharedSecret), authSecret, concatBytes(encoder.encode('WebPush: info\0'), clientPublicKey, serverPublicKey), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const plain = concatBytes(encoder.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']), plain));
  const recordSize = new Uint8Array([0, 0, 16, 0]);
  const body = concatBytes(salt, recordSize, new Uint8Array([serverPublicKey.length]), serverPublicKey, ciphertext);
  const jwt = await createVapidJwt(endpoint.origin, env);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${String(env.VAPID_PUBLIC_KEY).trim()}`,
      'Content-Encoding': 'aes128gcm',
      TTL: '3600',
      Urgency: 'normal',
    },
    body,
  });
}

async function createVapidJwt(audience, env) {
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 43_200, sub: 'https://modu-challenge.yeit.workers.dev' })));
  const publicBytes = base64UrlToBytes(String(env.VAPID_PUBLIC_KEY).trim());
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) throw new Error('Invalid VAPID public key');
  const privateKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: String(env.VAPID_PRIVATE_KEY).trim(),
    x: bytesToBase64Url(publicBytes.slice(1, 33)), y: bytesToBase64Url(publicBytes.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

function concatBytes(...items) {
  const size = items.reduce((total, item) => total + item.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const item of items) { out.set(item, offset); offset += item.length; }
  return out;
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
  const verifiedIdentity = await env.DB.prepare('SELECT expires_at,revoked_at FROM verified_identities WHERE user_id=?').bind(user.id).first();
  user.verified_identity_current = identityConfigured(env) && verifiedIdentity && !verifiedIdentity.revoked_at && Date.parse(verifiedIdentity.expires_at)>Date.now();
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

  const where = ["c.visibility = 'public'", "c.status NOT IN ('DRAFT', 'CANCELLED', 'REJECTED')"];
  const binds = [];
  if (CATEGORIES.has(category)) { where.push('c.category = ?'); binds.push(category); }
  if (status) { where.push('c.status = ?'); binds.push(status); }
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

function rewardBounds(env) {
  const min = parsePositiveInt(env.REWARD_MIN_AMOUNT, 10_000);
  const max = Math.max(min, parsePositiveInt(env.REWARD_MAX_AMOUNT, 100_000_000));
  return { min, max };
}

function validateReward(amount, user, env) {
  const { min, max } = rewardBounds(env);
  const accountMax = Math.min(max, Number(user.bounty_limit || 0));
  if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
    return problem(400, 'INVALID_REWARD', `보상금은 ${formatWon(min)} 이상 ${formatWon(max)} 이하의 정수로 입력해주세요.`);
  }
  if (amount > accountMax) return problem(403, 'BOUNTY_LIMIT_EXCEEDED', `현재 계정의 보상금 표시 한도는 ${formatWon(accountMax)}입니다.`);
  return null;
}

function publicConfig(env) {
  return {
    homeTheme: 'original',
    rewardBounds: rewardBounds(env),
    moderationRewardThreshold: HIGH_REWARD_REVIEW_AMOUNT,
    serviceName: '모두의클리어',
    internalCode: 'MODU_CHALLENGE',
    environment: env.APP_ENV || 'unknown',
    feeRate: Number(env.PLATFORM_FEE_RATE || 0.1),
    verificationEnforcement: verificationEnforcement(env),
    liveTransactionsAvailable: false,
    moneyEnabled: isPublicMoneyEnabled(env),
    moneyMode: moneyFlowMode(env),
    termsVersion: env.TERMS_VERSION || '2026-08-28-v1',
    privacyVersion: env.PRIVACY_VERSION || '2026-08-31-v2',
    emailVerificationRequired: emailVerificationEnabled(env),
    socialLogin: {
      google: Boolean(String(env.GOOGLE_OAUTH_CLIENT_ID || '') && String(env.GOOGLE_OAUTH_CLIENT_SECRET || '')),
      naver: Boolean(String(env.NAVER_OAUTH_CLIENT_ID || '') && String(env.NAVER_OAUTH_CLIENT_SECRET || '')),
    },
    push: { configured: pushConfigured(env), publicKey: String(env.VAPID_PUBLIC_KEY || '') },
  };
}

function publicHealth(env) {
  return {
    ok: true,
    service: 'modu-challenge',
    environment: env.APP_ENV || 'unknown',
    version: env.APP_VERSION || 'unknown',
    pwaVersion: env.PWA_VERSION || 'unknown',
    commit: env.CF_VERSION_METADATA?.tag || env.COMMIT_SHA || 'unknown',
    deployedAt: env.DEPLOYED_AT || 'runtime',
    verificationEnforcement: verificationEnforcement(env),
    liveTransactionsAvailable: false,
    moneyEnabled: isPublicMoneyEnabled(env),
    moneyMode: moneyFlowMode(env),
    feeRate: Number(env.PLATFORM_FEE_RATE || 0.1),
    time: new Date().toISOString(),
  };
}

async function publicBootstrap(url, env) {
  const query = new URL(url);
  query.searchParams.set('limit', '50');
  query.searchParams.set('sort', 'new');
  const [challengeData, homeTheme] = await Promise.all([queryChallenges(query, env), getHomeTheme(env)]);
  return json({
    config: { ...publicConfig(env), homeTheme: homeTheme.theme },
    health: publicHealth(env),
    ...challengeData,
  }, 200, {
    'Cache-Control': 'public, max-age=10, stale-while-revalidate=30',
  });
}

const HOME_THEMES = new Set(['original', 'emerald', 'editorial', 'sunset', 'cobalt']);

async function getHomeTheme(env) {
  const row = await env.DB.prepare('SELECT theme, revision FROM home_theme_settings WHERE id = 1').first();
  return { theme: HOME_THEMES.has(row?.theme) ? row.theme : 'original', revision: Number(row?.revision || 1) };
}

async function updateHomeTheme(request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (!HOME_THEMES.has(body.theme)) return problem(400, 'INVALID_HOME_THEME', '선택할 수 없는 메인페이지 디자인입니다.');
  const current = await getHomeTheme(env);
  if (body.revision !== current.revision) return problem(409, 'STALE_REVISION', '다른 관리자가 디자인을 변경했습니다. 새로고침 후 다시 선택해주세요.');
  if (current.theme === body.theme) return json({ homeTheme: current });
  const result = await env.DB.prepare(`UPDATE home_theme_settings SET theme = ?, revision = revision + 1,
    updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1 AND revision = ?`)
    .bind(body.theme, admin.id, current.revision).run();
  if (!result.meta?.changes) return problem(409, 'STALE_REVISION', '다른 관리자가 디자인을 변경했습니다. 새로고침 후 다시 선택해주세요.');
  await audit(env, admin.id, 'HOME_THEME_CHANGED', 'home_theme_settings', '1', { theme: current.theme }, { theme: body.theme });
  return json({ homeTheme: { theme: body.theme, revision: current.revision + 1 } });
}

async function getChallenge(challengeId, request, env) {
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  const auth = await optionalAuth(request, env);
  const viewerAuth = !(auth instanceof Response) ? auth : null;
  if (challenge.visibility !== 'public' && (!viewerAuth || (viewerAuth.id !== challenge.owner_id && !viewerAuth.is_admin))) {
    return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
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
    const viewerTeaser = await env.DB.prepare(`SELECT id, status, headline, capability, approach, expected_days,
      masked_evidence, qualification_type, qualification_ref, created_at
      FROM teasers WHERE challenge_id = ? AND solver_id = ?`)
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
      canEdit: isOwner && ['OPEN', 'REVIEW', 'DRAFT'].includes(challenge.status) && Number(challenge.teaser_count || 0) === 0 && challenge.funding_status === 'POSTED',
      editBlockedReason: isOwner && !(['OPEN', 'REVIEW'].includes(challenge.status) && Number(challenge.teaser_count || 0) === 0 && challenge.funding_status === 'POSTED')
        ? 'TEASER 접수 또는 진행 단계가 시작된 미션은 기존 약속 보호를 위해 수정할 수 없습니다.' : '',
      canApply: !isOwner && (!viewerTeaser || viewerTeaser.status === 'WITHDRAWN') && !safeJsonParse(challenge.moderation_reasons_json, []).length && ['OPEN', 'REVIEW'].includes(challenge.status),
      viewerTeaser: viewerTeaser ? {
        id: viewerTeaser.id, status: viewerTeaser.status, headline: viewerTeaser.headline,
        capability: viewerTeaser.capability, approach: viewerTeaser.approach,
        expectedDays: viewerTeaser.expected_days, maskedEvidence: viewerTeaser.masked_evidence,
        qualificationType: viewerTeaser.qualification_type, qualificationRef: viewerTeaser.qualification_ref,
        canEdit: ['SUBMITTED', 'VIEWED'].includes(viewerTeaser.status) && ['OPEN', 'REVIEW', 'SHORTLISTED'].includes(challenge.status),
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
  if (user.status === 'limited') return problem(403, 'OWNER_LIMITED', '현재 미션 등록이 제한되어 있습니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const idempotencyKey = String(request.headers.get('Idempotency-Key') || '').trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
    return problem(400, 'IDEMPOTENCY_KEY_REQUIRED', '중복 등록 방지 정보를 확인하지 못했습니다. 화면을 새로고침한 뒤 다시 시도해주세요.');
  }
  const existingRequest = await env.DB.prepare(
    'SELECT challenge_id FROM challenge_create_requests WHERE owner_id = ? AND idempotency_key = ?'
  ).bind(user.id, idempotencyKey).first();
  if (existingRequest?.challenge_id) {
    const existingChallenge = await fetchChallenge(existingRequest.challenge_id, env);
    if (existingChallenge) return json({ challenge: publicChallenge(existingChallenge), duplicatePrevented: true }, 200);
  }

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
  const subjectType = ACTOR_TYPES.has(body.subjectType) ? body.subjectType : 'individual';

  if (!title || !summary || !description) return problem(400, 'INVALID_CONTENT', '제목과 설명을 충분히 입력해주세요.');
  if (!CATEGORIES.has(category)) return problem(400, 'INVALID_CATEGORY', '올바른 카테고리를 선택해주세요.');
  const rewardError = validateReward(rewardAmount, user, env);
  if (rewardError) return rewardError;
  if (!successCriteria || !paymentTrigger || !evidenceRequirements || !deadline) {
    return problem(400, 'MISSING_RULES', '성공조건, Funding 시점, 증빙기준과 마감일을 입력해주세요.');
  }

  const verification = await memberVerificationContext(user, subjectType, env);
  const gate = verificationGate(verification);
  if (gate) return gate;
  const id = makeId('chl');
  const requestHash = await sha256(JSON.stringify(body));
  const feeRate = Number(env.PLATFORM_FEE_RATE || 0.1);
  let moderation = assessChallengeModeration({ title, summary, description, successCriteria, rewardAmount });
  const duplicate = await findSimilarChallenge(user.id, title, null, env);
  if (duplicate) moderation = addModerationFinding(moderation, { code: 'POSSIBLE_DUPLICATE', label: '동일·유사 미션 중복 등록 가능성', score: 30, prohibited: false });
  const moderationReasons = moderation.reasons;
  const outcome = moderationOutcome(moderation, visibility);
  const moderationPending = false;
  const initialStatus = outcome.status;
  const initialVisibility = outcome.visibility;
  const autoReviewedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO challenges (
        id, owner_id, title, summary, description, category, region,
        reward_amount, fee_rate, success_criteria, payment_trigger,
        evidence_requirements, deadline, status, funding_status, visibility,
        submitted_visibility, moderation_reasons_json, moderation_decision,
        moderation_risk_score, moderation_auto_reviewed_at, moderation_action,
        moderation_policy_version, moderation_guidance_json, owner_subject_type,
        owner_actor_profile_id, owner_verification_snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, user.id, title, summary, description, category, region,
      rewardAmount, feeRate, successCriteria, paymentTrigger, evidenceRequirements, deadline, initialStatus,
      initialVisibility, visibility, JSON.stringify(moderationReasons), outcome.legacyDecision,
      moderation.riskScore, autoReviewedAt, moderation.action, MODERATION_POLICY_VERSION,
      JSON.stringify(moderation.guidance), subjectType, verification.profile.id, JSON.stringify(verification.snapshot)),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, to_status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(makeId('evt'), id, user.id, `CHALLENGE_MODERATION_${moderation.action}`, initialStatus,
      JSON.stringify({ rewardAmount, fundingStatus: 'POSTED', moderationAction: moderation.action, moderationRiskScore: moderation.riskScore, moderationReasons, policyVersion: MODERATION_POLICY_VERSION })),
    auditStatement(env, user.id, `CHALLENGE_MODERATION_${moderation.action}`, 'challenge', id, null,
      { title, category, rewardAmount, moderationAction: moderation.action, moderationRiskScore: moderation.riskScore, moderationReasons, policyVersion: MODERATION_POLICY_VERSION }),
    env.DB.prepare(`INSERT INTO challenge_create_requests (owner_id, idempotency_key, challenge_id, request_hash)
      VALUES (?, ?, ?, ?)`).bind(user.id, idempotencyKey, id, requestHash),
    env.DB.prepare(`INSERT INTO activity_qualifications
      (id, user_id, activity_role, subject_type, actor_profile_id, challenge_id, verification_snapshot_json)
      VALUES (?, ?, 'OWNER', ?, ?, ?, ?)`)
      .bind(makeId('aqf'), user.id, subjectType, verification.profile.id, id, JSON.stringify(verification.snapshot)),
  ]);

  return json({ challenge: publicChallenge(await fetchChallenge(id, env)), moderationPending, moderationAction: moderation.action, moderationDecision: outcome.legacyDecision, moderationRiskScore: moderation.riskScore, moderationReasons, moderationGuidance: moderation.guidance, policyVersion: MODERATION_POLICY_VERSION, verificationAdvisory: !verification.eligible }, 201);
}

async function updateChallenge(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const current = await fetchChallenge(challengeId, env);
  if (!current) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (current.owner_id !== user.id) return problem(403, 'OWNER_REQUIRED', '미션 등록자만 수정할 수 있습니다.');
  if (!['OPEN', 'REVIEW', 'DRAFT'].includes(current.status) || Number(current.teaser_count || 0) > 0 || current.funding_status !== 'POSTED') {
    return problem(409, 'CHALLENGE_EDIT_LOCKED', 'TEASER 접수 또는 진행 단계가 시작되어 수정할 수 없습니다.');
  }
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
  const submittedVisibility = ['public', 'unlisted', 'private'].includes(body.visibility) ? body.visibility : 'public';
  const subjectType = ACTOR_TYPES.has(body.subjectType) ? body.subjectType : (current.owner_subject_type || 'individual');
  if (!title || !summary || !description) return problem(400, 'INVALID_CONTENT', '제목과 설명을 충분히 입력해주세요.');
  if (!CATEGORIES.has(category)) return problem(400, 'INVALID_CATEGORY', '올바른 카테고리를 선택해주세요.');
  const rewardError = validateReward(rewardAmount, user, env);
  if (rewardError) return rewardError;
  if (!successCriteria || !paymentTrigger || !evidenceRequirements || !deadline) return problem(400, 'MISSING_RULES', '성공조건, 보상금 준비 시점, 증빙기준과 마감일을 입력해주세요.');
  const verification = await memberVerificationContext(user, subjectType, env);
  const gate = verificationGate(verification);
  if (gate) return gate;
  let moderation = assessChallengeModeration({ title, summary, description, successCriteria, rewardAmount });
  const duplicate = await findSimilarChallenge(user.id, title, challengeId, env);
  if (duplicate) moderation = addModerationFinding(moderation, { code: 'POSSIBLE_DUPLICATE', label: '동일·유사 미션 중복 등록 가능성', score: 30, prohibited: false });
  const moderationReasons = moderation.reasons;
  const outcome = moderationOutcome(moderation, submittedVisibility);
  const status = outcome.status;
  const visibility = outcome.visibility;
  const autoReviewedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE challenges SET title = ?, summary = ?, description = ?, category = ?, region = ?, reward_amount = ?, success_criteria = ?, payment_trigger = ?, evidence_requirements = ?, deadline = ?, status = ?, visibility = ?, submitted_visibility = ?, moderation_reasons_json = ?, moderation_decision = ?, moderation_risk_score = ?, moderation_auto_reviewed_at = ?, moderation_action = ?, moderation_policy_version = ?, moderation_guidance_json = ?, owner_subject_type = ?, owner_actor_profile_id = ?, owner_verification_snapshot_json = ?, moderation_reviewed_by = NULL, moderation_reviewed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(title, summary, description, category, region, rewardAmount, successCriteria, paymentTrigger, evidenceRequirements, deadline, status, visibility, submittedVisibility, JSON.stringify(moderationReasons), outcome.legacyDecision, moderation.riskScore, autoReviewedAt, moderation.action, MODERATION_POLICY_VERSION, JSON.stringify(moderation.guidance), subjectType, verification.profile.id, JSON.stringify(verification.snapshot), challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json) VALUES (?, ?, ?, 'CHALLENGE_UPDATED', ?, ?, ?)`)
      .bind(makeId('evt'), challengeId, user.id, current.status, status, JSON.stringify({ moderationAction: moderation.action, moderationRiskScore: moderation.riskScore, moderationReasons, policyVersion: MODERATION_POLICY_VERSION })),
    auditStatement(env, user.id, 'CHALLENGE_UPDATE', 'challenge', challengeId, { status: current.status }, { status, moderationAction: moderation.action, moderationRiskScore: moderation.riskScore, moderationReasons, policyVersion: MODERATION_POLICY_VERSION }),
  ]);
  return json({ challenge: publicChallenge(await fetchChallenge(challengeId, env)), moderationPending: false, moderationAction: moderation.action, moderationDecision: outcome.legacyDecision, moderationRiskScore: moderation.riskScore, moderationReasons, moderationGuidance: moderation.guidance, policyVersion: MODERATION_POLICY_VERSION, verificationAdvisory: !verification.eligible });
}

function assessChallengeModeration({ title, summary, description, successCriteria, rewardAmount }) {
  const combined = `${title}\n${summary}\n${description}\n${successCriteria}`.toLowerCase();
  const rules = [
    ['HIGH_REWARD', rewardAmount >= HIGH_REWARD_REVIEW_AMOUNT, '고액 보상금(50만원 이상)', 25],
    ['PERSONAL_INFORMATION', /(주민등록|주민번호|전화번호|연락처|카카오톡|텔레그램|계좌번호|sns.?아이디|인스타.?아이디)/i.test(combined), '개인정보·직접 연락처 관련 표현', 40],
    ['PERSONAL_DATA_TRADE', /(개인정보|고객명단|디비|db).{0,12}(판매|구매|제공|수집)/i.test(combined), '개인정보 불법 수집·판매 가능성', 100, true],
    ['DATING_RELATIONSHIP', /(소개팅|연애|이성.?만남|데이트|결혼.?상대|배우자)/i.test(combined), '연애·만남 관련 표현', 35],
    ['MEDICAL_GUARANTEE', /(의료|진단|처방|치료|수술|약물).{0,20}(보장|완치|확실|무조건)/i.test(combined), '의료 결과 허위 보장 가능성', 70],
    ['LEGAL_INVESTMENT_GUARANTEE', /(법률|소송|투자|수익|주식|코인).{0,20}(보장|확실|무조건|원금)/i.test(combined), '법률·투자 결과 허위 보장 가능성', 70],
    ['ADULT_GAMBLING_PYRAMID', /(성인물|음란|도박|카지노|사행성|다단계|불법.?금융)/i.test(combined), '성인·도박·다단계·불법 금융', 100, true],
    ['MINOR_EXPLOITATION', /(미성년|아동|청소년).{0,18}(노출|만남|숙박|위험|촬영|개인정보)/i.test(combined), '미성년자 위험·착취 가능성', 100, true],
    ['DECEPTION_PHISHING', /(사칭|피싱|대포통장|명의.?도용|허위.?리뷰|가짜.?계정)/i.test(combined), '허위·사칭·피싱 가능성', 100, true],
    ['DANGEROUS_ACTIVITY', /(폭력|살해|위협|무기|총기|마약|자해|불법|무단.?침입|해킹|스토킹|추적)/i.test(combined), '범죄·위험·불법 가능성 표현', 100, true],
    ['AMBIGUOUS_SUCCESS', /(알아서|무조건.?성공|완벽하게|좋은.?결과|만족.?할.?때|적당히)/i.test(successCriteria), '성공조건이 모호할 수 있는 표현', 30],
  ];
  const matched = rules.filter(([, isMatch]) => isMatch);
  const reasons = matched.map(([code, , label, score, prohibited = false]) => ({ code, label, score, prohibited }));
  const riskScore = Math.min(100, matched.reduce((sum, [, , , score]) => sum + score, 0));
  const prohibited = reasons.some((reason) => reason.prohibited);
  const action = prohibited || riskScore >= 60 ? 'AUTO_REJECTED' : riskScore >= 30 ? 'CHANGES_REQUIRED' : 'AUTO_APPROVED';
  const guidance = action === 'CHANGES_REQUIRED'
    ? reasons.map((reason) => ({ code: reason.code, message: `${reason.label}이 감지되었습니다. 해당 문장을 삭제하거나 합법적인 목적·수집범위·성공조건을 구체적으로 고쳐주세요.` }))
    : action === 'AUTO_REJECTED'
      ? reasons.map((reason) => ({ code: reason.code, message: `${reason.label}으로 자동 차단되었습니다. 오탐이라면 이의신청에서 합법성과 안전 근거를 제출해주세요.` }))
      : [];
  return { action, decision: action === 'AUTO_APPROVED' ? 'AUTO_APPROVED' : action === 'AUTO_REJECTED' ? 'ARCHIVED' : 'ADMIN_REVIEW', riskScore, reasons, guidance, prohibited };
}

async function findSimilarChallenge(ownerId, title, excludeId, env) {
  const normalized = String(title || '').replace(/\s+/g, '').toLowerCase();
  if (normalized.length < 5) return null;
  const candidates = await env.DB.prepare(`SELECT id, title FROM challenges WHERE owner_id = ? AND id <> COALESCE(?, '') AND status NOT IN ('CANCELLED','FAILED') ORDER BY created_at DESC LIMIT 50`)
    .bind(ownerId, excludeId).all();
  return (candidates.results || []).find((item) => {
    const candidate = String(item.title || '').replace(/\s+/g, '').toLowerCase();
    return candidate === normalized || (candidate.length >= 8 && (candidate.includes(normalized) || normalized.includes(candidate)));
  }) || null;
}

function addModerationFinding(moderation, finding) {
  if (moderation.reasons.some((reason) => reason.code === finding.code)) return moderation;
  const reasons = [...moderation.reasons, finding];
  const riskScore = Math.min(100, moderation.riskScore + finding.score);
  const prohibited = moderation.prohibited || finding.prohibited;
  const action = prohibited || riskScore >= 60 ? 'AUTO_REJECTED' : riskScore >= 30 ? 'CHANGES_REQUIRED' : 'AUTO_APPROVED';
  const guidance = action === 'AUTO_APPROVED' ? [] : reasons.map((reason) => ({
    code: reason.code,
    message: action === 'AUTO_REJECTED'
      ? `${reason.label}으로 자동 차단되었습니다. 오탐이라면 이의신청에서 합법성과 안전 근거를 제출해주세요.`
      : `${reason.label}이 감지되었습니다. 중복 내용을 정리하거나 목적·조건을 구체적으로 고쳐주세요.`,
  }));
  return { action, decision: action === 'AUTO_APPROVED' ? 'AUTO_APPROVED' : action === 'AUTO_REJECTED' ? 'ARCHIVED' : 'ADMIN_REVIEW', riskScore, reasons, guidance, prohibited };
}

function moderationOutcome(moderation, submittedVisibility) {
  if (moderation.action === 'AUTO_APPROVED') return { status: 'OPEN', visibility: submittedVisibility, legacyDecision: 'AUTO_APPROVED' };
  if (moderation.action === 'CHANGES_REQUIRED') return { status: 'DRAFT', visibility: 'private', legacyDecision: 'ADMIN_REVIEW' };
  return { status: 'DRAFT', visibility: 'private', legacyDecision: 'ARCHIVED' };
}

function analyzeChallengeForModeration(input) {
  return assessChallengeModeration(input).reasons;
}

async function approveModerationChallenge(challengeId, request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.status === 'OPEN' && challenge.moderation_reviewed_at) {
    return json({ challenge: publicChallenge(challenge), idempotent: true });
  }
  if (challenge.status !== 'REVIEW') return problem(409, 'MODERATION_NOT_PENDING', '관리자 검토 대기 상태의 미션만 승인할 수 있습니다.');
  const visibility = ['public', 'unlisted', 'private'].includes(challenge.submitted_visibility) ? challenge.submitted_visibility : 'public';
  const updated = await env.DB.prepare(`UPDATE challenges SET status = 'OPEN', visibility = ?, moderation_decision = 'ADMIN_APPROVED', moderation_reviewed_by = ?, moderation_reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'REVIEW'`)
    .bind(visibility, admin.id, challengeId).run();
  if (Number(updated.meta?.changes) !== 1) {
    const current = await fetchChallenge(challengeId, env);
    if (current?.status === 'OPEN' && current.moderation_reviewed_at) {
      return json({ challenge: publicChallenge(current), idempotent: true });
    }
    return problem(409, 'MODERATION_CHANGED', '다른 관리자가 먼저 검토 상태를 변경했습니다. 목록을 새로고침해주세요.');
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json) VALUES (?, ?, ?, 'CHALLENGE_MODERATION_APPROVED', 'REVIEW', 'OPEN', ?)`)
      .bind(makeId('evt'), challengeId, admin.id, JSON.stringify({ visibility, moderationReasons: safeJsonParse(challenge.moderation_reasons_json, []) })),
    auditStatement(env, admin.id, 'CHALLENGE_MODERATION_APPROVE', 'challenge', challengeId, { status: 'REVIEW' }, { status: 'OPEN', visibility }),
  ]);
  await sendPushNotification(env, challenge.owner_id, {
    title: '미션 검토가 완료되었습니다',
    body: '관리자 검토 결과가 등록되었습니다. 앱에서 상태를 확인하세요.',
    route: 'challenge',
    challengeId,
  });
  return json({ challenge: publicChallenge(await fetchChallenge(challengeId, env)) });
}

async function archiveModerationChallenge(challengeId, request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.status === 'DRAFT' && challenge.visibility === 'private' && challenge.moderation_reviewed_at) {
    return json({ challenge: publicChallenge(challenge), idempotent: true });
  }
  if (challenge.status !== 'REVIEW') return problem(409, 'MODERATION_NOT_PENDING', '관리자 검토 대기 상태의 미션만 비공개 보관할 수 있습니다.');
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const reason = cleanText(body.reason, 5, 500);
  if (!reason) return problem(400, 'MODERATION_ARCHIVE_REASON_REQUIRED', '비공개 보관 사유를 5자 이상 입력해주세요.');
  const updated = await env.DB.prepare(`UPDATE challenges SET status = 'DRAFT', visibility = 'private', submitted_visibility = 'private', moderation_decision = 'ARCHIVED', moderation_reviewed_by = ?, moderation_reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'REVIEW'`)
    .bind(admin.id, challengeId).run();
  if (Number(updated.meta?.changes) !== 1) {
    const current = await fetchChallenge(challengeId, env);
    if (current?.status === 'DRAFT' && current.visibility === 'private' && current.moderation_reviewed_at) {
      return json({ challenge: publicChallenge(current), idempotent: true });
    }
    return problem(409, 'MODERATION_CHANGED', '다른 관리자가 먼저 검토 상태를 변경했습니다. 목록을 새로고침해주세요.');
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json) VALUES (?, ?, ?, 'CHALLENGE_MODERATION_ARCHIVED', 'REVIEW', 'DRAFT', ?)`)
      .bind(makeId('evt'), challengeId, admin.id, JSON.stringify({ reason, preserved: true })),
    auditStatement(env, admin.id, 'CHALLENGE_MODERATION_ARCHIVE', 'challenge', challengeId, { status: 'REVIEW' }, { status: 'DRAFT', visibility: 'private', reason, preserved: true }),
  ]);
  await sendPushNotification(env, challenge.owner_id, {
    title: '미션 검토 결과를 확인해주세요',
    body: '등록 내용은 삭제되지 않았으며 비공개 상태로 보관됩니다. 앱에서 검토 결과를 확인하세요.',
    route: 'challenge',
    challengeId,
  });
  return json({ challenge: publicChallenge(await fetchChallenge(challengeId, env)), preserved: true });
}

async function moderationQueue(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  await ensureModerationNoteStorage(env);
  const result = await env.DB.prepare(`SELECT c.id, c.title, c.reward_amount, c.deadline, c.created_at, c.moderation_reasons_json, c.moderation_decision, c.moderation_risk_score, c.moderation_action, c.moderation_policy_version,
    (SELECT note FROM moderation_review_notes n WHERE n.challenge_id = c.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
    (SELECT requested_approval_at FROM moderation_review_notes n WHERE n.challenge_id = c.id AND n.requested_approval_at IS NOT NULL ORDER BY n.created_at DESC LIMIT 1) AS requested_approval_at
    FROM challenges c WHERE EXISTS (SELECT 1 FROM moderation_appeals a WHERE a.challenge_id = c.id AND a.status IN ('OPEN','REVIEWING')) ORDER BY c.created_at ASC LIMIT 30`).all();
  return json({ challenges: (result.results || []).map((item) => ({ ...item, moderationReasons: safeJsonParse(item.moderation_reasons_json, []) })) });
}

async function autoReviewModerationQueue(request, env) {
  const admin = await requirePrimaryAdmin(request, env);
  if (admin instanceof Response) return admin;
  return json(await autoReviewPendingChallenges(env, admin.id));
}

async function autoReviewPendingChallenges(env, actorId = null) {
  const pending = await env.DB.prepare(`SELECT id, owner_id, title, summary, description, success_criteria, reward_amount, submitted_visibility
    FROM challenges WHERE status = 'REVIEW' AND moderation_decision = 'ADMIN_REVIEW'
    ORDER BY created_at ASC LIMIT 100`).all();
  let autoApproved = 0;
  let changesRequired = 0;
  let autoRejected = 0;
  for (const challenge of pending.results || []) {
    const moderation = assessChallengeModeration({
      title: challenge.title,
      summary: challenge.summary,
      description: challenge.description,
      successCriteria: challenge.success_criteria,
      rewardAmount: Number(challenge.reward_amount),
    });
    const visibility = ['public', 'unlisted', 'private'].includes(challenge.submitted_visibility) ? challenge.submitted_visibility : 'public';
    const outcome = moderationOutcome(moderation, visibility);
    const updated = await env.DB.prepare(`UPDATE challenges SET status = ?, visibility = ?, moderation_reasons_json = ?, moderation_decision = ?, moderation_risk_score = ?, moderation_auto_reviewed_at = CURRENT_TIMESTAMP, moderation_action = ?, moderation_policy_version = ?, moderation_guidance_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'REVIEW' AND moderation_decision = 'ADMIN_REVIEW'`)
      .bind(outcome.status, outcome.visibility, JSON.stringify(moderation.reasons), outcome.legacyDecision, moderation.riskScore, moderation.action, MODERATION_POLICY_VERSION, JSON.stringify(moderation.guidance), challenge.id).run();
    if (Number(updated.meta?.changes) !== 1) continue;
    if (moderation.action === 'AUTO_APPROVED') autoApproved += 1;
    else if (moderation.action === 'CHANGES_REQUIRED') changesRequired += 1;
    else autoRejected += 1;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json) VALUES (?, ?, ?, ?, 'REVIEW', ?, ?)`)
        .bind(makeId('evt'), challenge.id, actorId, `CHALLENGE_MODERATION_${moderation.action}`, outcome.status, JSON.stringify({ visibility: outcome.visibility, recheck: true, moderationRiskScore: moderation.riskScore, policyVersion: MODERATION_POLICY_VERSION })),
      auditStatement(env, actorId, `CHALLENGE_MODERATION_${moderation.action}`, 'challenge', challenge.id, { status: 'REVIEW' }, { status: outcome.status, visibility: outcome.visibility, recheck: true }),
    ]);
    await sendPushNotification(env, challenge.owner_id, {
      title: moderation.action === 'AUTO_APPROVED' ? '미션 자동 검수가 완료되었습니다' : moderation.action === 'CHANGES_REQUIRED' ? '미션 내용을 수정해주세요' : '미션 자동 검수 결과를 확인해주세요',
      body: moderation.action === 'AUTO_APPROVED' ? '안전 기준을 통과해 등록한 공개범위로 공개되었습니다.' : moderation.action === 'CHANGES_REQUIRED' ? '구체적인 수정 사유를 확인한 뒤 고치면 즉시 자동 재검수됩니다.' : '금지 또는 고위험 항목으로 비공개 보관되었습니다. 오탐이면 이의신청할 수 있습니다.',
      route: 'challenge',
      challengeId: challenge.id,
    });
  }
  return { checked: (pending.results || []).length, autoApproved, changesRequired, autoRejected, adminReview: 0 };
}

async function createModerationAppeal(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.owner_id !== user.id) return problem(403, 'OWNER_REQUIRED', '미션 등록자만 이의신청할 수 있습니다.');
  if (!['CHANGES_REQUIRED', 'AUTO_REJECTED'].includes(challenge.moderation_action)) return problem(409, 'APPEAL_NOT_AVAILABLE', '자동 수정요청 또는 자동거절된 미션만 이의신청할 수 있습니다.');
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const reason = cleanText(body.reason, 20, 2000);
  if (!reason) return problem(400, 'APPEAL_REASON_REQUIRED', '오탐 근거와 안전·합법성을 20자 이상 작성해주세요.');
  const existing = await env.DB.prepare(`SELECT id, status FROM moderation_appeals WHERE challenge_id = ? AND user_id = ? AND status IN ('OPEN','REVIEWING')`).bind(challengeId, user.id).first();
  if (existing) return json({ appeal: existing, idempotent: true });
  const id = makeId('apl');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO moderation_appeals (id, challenge_id, user_id, reason) VALUES (?, ?, ?, ?)`).bind(id, challengeId, user.id, reason),
    auditStatement(env, user.id, 'MODERATION_APPEAL_CREATE', 'moderation_appeal', id, null, { challengeId, moderationAction: challenge.moderation_action }),
  ]);
  return json({ appeal: { id, status: 'OPEN' } }, 201);
}

async function addModerationNote(challengeId, request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge || challenge.status !== 'REVIEW') return problem(409, 'MODERATION_NOT_PENDING', '관리자 검토 대기 상태의 미션만 처리할 수 있습니다.');
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const note = cleanText(body.note, 5, 1000);
  const requestApproval = Boolean(body.requestApproval);
  if (!note) return problem(400, 'MODERATION_NOTE_REQUIRED', '검토 의견을 5자 이상 입력해주세요.');
  await ensureModerationNoteStorage(env);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO moderation_review_notes (id, challenge_id, author_id, note, requested_approval_at) VALUES (?, ?, ?, ?, ?)')
      .bind(makeId('mrn'), challengeId, admin.id, note, requestApproval ? new Date().toISOString() : null),
    auditStatement(env, admin.id, requestApproval ? 'DEPUTY_MODERATION_APPROVAL_REQUEST' : 'MODERATION_NOTE_ADDED', 'challenge', challengeId, null, { requestApproval }),
  ]);
  if (requestApproval) {
    const primary = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1')
      .bind(String(env.PRIMARY_ADMIN_EMAIL || '')).first();
    if (primary?.id) await sendPushNotification(env, primary.id, {
      title: '검토 승인 요청이 도착했습니다',
      body: '관리자 검토 대기 미션에 승인 요청이 등록되었습니다.',
      route: 'admin',
      challengeId,
    });
  }
  return json({ ok: true, requestApproval });
}

async function ensureModerationNoteStorage(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS moderation_review_notes (id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, author_id TEXT NOT NULL, note TEXT NOT NULL, requested_approval_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_moderation_review_notes_challenge ON moderation_review_notes(challenge_id, created_at DESC)').run();
}

async function cancelChallenge(challengeId, request, env) {
  const actor = await requireAuth(request, env);
  if (actor instanceof Response) return actor;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.owner_id !== actor.id && !actor.is_admin) return problem(403, 'OWNER_REQUIRED', '미션을 취소할 권한이 없습니다.');
  if (['FUNDED', 'PAID'].includes(challenge.funding_status) || ['EXECUTING', 'PROOF_SUBMITTED', 'SUCCESS', 'DISPUTED'].includes(challenge.status)) {
    return problem(409, 'CANCELLATION_REQUIRES_REVIEW', 'Funding 또는 수행이 시작된 미션은 일반 취소가 불가능합니다. 분쟁·환불 절차를 이용해주세요.');
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const reason = cleanText(body.reason, 5, 500);
  if (!reason) return problem(400, 'CANCELLATION_REASON_REQUIRED', '취소 사유를 5자 이상 500자 이하로 입력해주세요.');
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
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  const isParty = actor.id === challenge.owner_id || actor.id === challenge.selected_solver_id || actor.is_admin;
  if (!isParty) return problem(403, 'PARTY_REQUIRED', '미션 당사자만 분쟁을 신청할 수 있습니다.');
  const existing = await env.DB.prepare("SELECT id, status FROM disputes WHERE challenge_id = ? AND status NOT IN ('DECIDED','CLOSED') ORDER BY created_at DESC LIMIT 1")
    .bind(challengeId).first();
  if (existing) return json({ dispute: existing, idempotent: true });
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
  const settlement = await env.DB.prepare('SELECT status FROM settlements WHERE challenge_id = ?').bind(challengeId).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO disputes (id, challenge_id, opened_by, respondent_id, reason_code, description)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(disputeId, challengeId, actor.id, respondentId || null, reasonCode, description),
    env.DB.prepare("UPDATE challenges SET status = 'DISPUTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(challengeId),
    env.DB.prepare("UPDATE settlements SET status = 'DISPUTED' WHERE challenge_id = ? AND status NOT IN ('PAID','REFUNDED')").bind(challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, 'DISPUTE_OPENED', ?, 'DISPUTED', ?)`)
      .bind(makeId('evt'), challengeId, actor.id, challenge.status, JSON.stringify({ disputeId, reasonCode, settlementStatus: settlement?.status || null })),
    auditStatement(env, actor.id, 'DISPUTE_OPEN', 'dispute', disputeId, null, { challengeId, reasonCode }),
  ]);
  return json({ dispute: { id: disputeId, status: 'OPEN' } }, 201);
}

async function submitTeaser(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.owner_id === user.id) return problem(409, 'OWNER_CANNOT_APPLY', '자신이 등록한 미션에는 참가할 수 없습니다.');
  if (!['OPEN', 'REVIEW'].includes(challenge.status)) return problem(409, 'APPLICATION_CLOSED', '현재 참가 신청을 받지 않는 미션입니다.');

  const body = await readJson(request);
  if (body instanceof Response) return body;
  const headline = cleanText(body.headline, 5, 100);
  const capability = cleanText(body.capability, 20, 1200);
  const approach = cleanText(body.approach, 20, 1600);
  const expectedDays = Number(body.expectedDays);
  const maskedEvidence = cleanText(body.maskedEvidence, 0, 1000);
  const qualificationType = cleanText(body.qualificationType, 0, 80);
  const qualificationRef = cleanText(body.qualificationRef, 0, 160);
  const subjectType = ACTOR_TYPES.has(body.subjectType) ? body.subjectType : 'individual';

  if (!headline || !capability || !approach || !Number.isSafeInteger(expectedDays) || expectedDays < 1 || expectedDays > 365) {
    return problem(400, 'INVALID_TEASER', '해결 가능성, 접근방법과 예상기간을 정확히 입력해주세요.');
  }
  const verification = await memberVerificationContext(user, subjectType, env);
  const gate = verificationGate(verification);
  if (gate) return gate;

  const prior = await env.DB.prepare('SELECT * FROM teasers WHERE challenge_id = ? AND solver_id = ?').bind(challengeId, user.id).first();
  if (prior?.status === 'WITHDRAWN') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE teasers SET headline = ?, capability = ?, approach = ?, expected_days = ?, masked_evidence = ?, qualification_type = ?, qualification_ref = ?, solver_subject_type = ?, solver_actor_profile_id = ?, solver_verification_snapshot_json = ?, status = 'SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'WITHDRAWN'`).bind(headline, capability, approach, expectedDays, maskedEvidence || null, qualificationType || null, qualificationRef || null, subjectType, verification.profile.id, JSON.stringify(verification.snapshot), prior.id),
      env.DB.prepare(`UPDATE challenges SET teaser_count = (SELECT count(*) FROM teasers WHERE challenge_id = challenges.id AND status != 'WITHDRAWN'), participant_count = (SELECT count(*) FROM teasers WHERE challenge_id = challenges.id AND status != 'WITHDRAWN'), status = CASE WHEN status = 'OPEN' THEN 'REVIEW' ELSE status END WHERE id = ?`).bind(challengeId),
      auditStatement(env, user.id, 'TEASER_RESUBMIT', 'teaser', prior.id, { headline: prior.headline, capability: prior.capability, approach: prior.approach, status: prior.status }, { status: 'SUBMITTED' }),
    ]);
    return json({ teaser: { id: prior.id, status: 'SUBMITTED' } }, 201);
  }
  const teaserId = makeId('tsr');
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO teasers (
          id, challenge_id, solver_id, headline, capability, approach,
          expected_days, masked_evidence, qualification_type, qualification_ref,
          solver_subject_type, solver_actor_profile_id, solver_verification_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(teaserId, challengeId, user.id, headline, capability, approach,
        expectedDays, maskedEvidence || null, qualificationType || null, qualificationRef || null,
        subjectType, verification.profile.id, JSON.stringify(verification.snapshot)),
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
      env.DB.prepare(`INSERT INTO activity_qualifications
        (id, user_id, activity_role, subject_type, actor_profile_id, challenge_id, teaser_id, verification_snapshot_json)
        VALUES (?, ?, 'SOLVER', ?, ?, ?, ?, ?)`)
        .bind(makeId('aqf'), user.id, subjectType, verification.profile.id, challengeId, teaserId, JSON.stringify(verification.snapshot)),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return problem(409, 'TEASER_EXISTS', '이미 이 미션에 TEASER를 제출했습니다.');
    throw error;
  }

  await sendPushNotification(env, challenge.owner_id, {
    title: '새 TEASER가 도착했습니다',
    body: '내 미션에 새 제안이 등록되었습니다. 앱에서 확인하세요.',
    route: 'challenge',
    challengeId,
  });

  return json({ teaser: { id: teaserId, status: 'SUBMITTED' } }, 201);
}

async function getMyTeaser(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const teaser = await env.DB.prepare('SELECT * FROM teasers WHERE challenge_id = ? AND solver_id = ?').bind(challengeId, user.id).first();
  if (!teaser) return problem(404, 'TEASER_NOT_FOUND', '이 미션에 제출한 TEASER가 없습니다.');
  const challenge = await fetchChallenge(challengeId, env);
  return json({
    challengeId, challengeTitle: challenge?.title || '미션',
    teaser: { ...publicTeaser(teaser), canEdit: Boolean(challenge && ['SUBMITTED', 'VIEWED'].includes(teaser.status) && ['OPEN', 'REVIEW', 'SHORTLISTED'].includes(challenge.status)) },
  });
}

async function listTeasers(challengeId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.owner_id !== user.id && !user.is_admin) return problem(403, 'OWNER_REQUIRED', '의뢰자만 후보를 심사할 수 있습니다.');

  const result = await env.DB.prepare(`
    SELECT t.*, u.display_name AS solver_name, u.trust_score AS solver_trust,
           u.identity_verified, u.business_verified, u.professional_verified,
           u.strike_count
    FROM teasers t JOIN users u ON u.id = t.solver_id
    WHERE t.challenge_id = ? AND t.status NOT IN ('WITHDRAWN', 'REJECTED')
    ORDER BY CASE t.status WHEN 'SELECTED' THEN 0 WHEN 'SHORTLISTED' THEN 1 ELSE 2 END,
             u.trust_score DESC, t.created_at ASC
  `).bind(challengeId).all();
  return json({ teasers: result.results.map(publicTeaser) });
}

async function updateTeaser(challengeId, teaserId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge || !['OPEN', 'REVIEW', 'SHORTLISTED'].includes(challenge.status)) return problem(409, 'CHALLENGE_CLOSED', '현재 미션에서는 TEASER를 변경할 수 없습니다.');
  const teaser = await env.DB.prepare('SELECT * FROM teasers WHERE id = ? AND challenge_id = ?').bind(teaserId, challengeId).first();
  if (!teaser) return problem(404, 'TEASER_NOT_FOUND', 'TEASER를 찾을 수 없습니다.');
  if (teaser.solver_id !== user.id) return problem(403, 'TEASER_OWNER_REQUIRED', '본인이 제출한 TEASER만 수정할 수 있습니다.');
  if (!['SUBMITTED', 'VIEWED'].includes(teaser.status)) return problem(409, 'TEASER_EDIT_LOCKED', '후보 선정이 시작된 TEASER는 수정할 수 없습니다.');
  const gate = verificationGate(await memberVerificationContext(user, teaser.solver_subject_type || 'individual', env));
  if (gate) return gate;
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
  await env.DB.batch([
    env.DB.prepare(`UPDATE teasers SET headline = ?, capability = ?, approach = ?, expected_days = ?,
      masked_evidence = ?, qualification_type = ?, qualification_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('SUBMITTED','VIEWED')`)
      .bind(headline, capability, approach, expectedDays, maskedEvidence || null, qualificationType || null, qualificationRef || null, teaserId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, metadata_json)
      VALUES (?, ?, ?, 'TEASER_UPDATED', ?)`).bind(makeId('evt'), challengeId, user.id, JSON.stringify({ teaserId })),
    auditStatement(env, user.id, 'TEASER_UPDATE', 'teaser', teaserId, { headline: teaser.headline, capability: teaser.capability, approach: teaser.approach, expectedDays: teaser.expected_days }, { challengeId, headline, capability, approach, expectedDays }),
  ]);
  return json({ teaser: { id: teaserId, status: teaser.status } });
}

async function withdrawTeaser(challengeId, teaserId, request, env) {
  const user = await requireAuth(request, env);
  if (user instanceof Response) return user;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge || !['OPEN', 'REVIEW', 'SHORTLISTED'].includes(challenge.status)) return problem(409, 'CHALLENGE_CLOSED', '현재 미션에서는 TEASER를 변경할 수 없습니다.');
  const teaser = await env.DB.prepare('SELECT * FROM teasers WHERE id = ? AND challenge_id = ?').bind(teaserId, challengeId).first();
  if (!teaser) return problem(404, 'TEASER_NOT_FOUND', 'TEASER를 찾을 수 없습니다.');
  if (teaser.solver_id !== user.id) return problem(403, 'TEASER_OWNER_REQUIRED', '본인이 제출한 TEASER만 철회할 수 있습니다.');
  if (teaser.status === 'WITHDRAWN') return json({ ok: true, status: 'WITHDRAWN', idempotent: true });
  if (!['SUBMITTED', 'VIEWED'].includes(teaser.status)) return problem(409, 'TEASER_WITHDRAW_LOCKED', '후보 선정이 시작된 TEASER는 철회할 수 없습니다.');
  await env.DB.batch([
    env.DB.prepare("UPDATE teasers SET status = 'WITHDRAWN', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('SUBMITTED', 'VIEWED')").bind(teaserId),
    env.DB.prepare(`UPDATE challenges SET teaser_count = (SELECT count(*) FROM teasers WHERE challenge_id = challenges.id AND status != 'WITHDRAWN'), participant_count = (SELECT count(*) FROM teasers WHERE challenge_id = challenges.id AND status != 'WITHDRAWN'),
      status = CASE WHEN NOT EXISTS (SELECT 1 FROM teasers WHERE challenge_id = challenges.id AND status != 'WITHDRAWN') AND status = 'REVIEW' THEN 'OPEN' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(challengeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, metadata_json)
      VALUES (?, ?, ?, 'TEASER_WITHDRAWN', ?)`).bind(makeId('evt'), challengeId, user.id, JSON.stringify({ teaserId })),
    auditStatement(env, user.id, 'TEASER_WITHDRAW', 'teaser', teaserId, { status: teaser.status }, { status: 'WITHDRAWN', challengeId }),
  ]);
  return json({ ok: true, status: 'WITHDRAWN' });
}

async function shortlistTeaser(challengeId, request, env) {
  const owner = await requireAuth(request, env);
  if (owner instanceof Response) return owner;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.owner_id !== owner.id) return problem(403, 'OWNER_REQUIRED', '미션 등록자만 후보를 선택할 수 있습니다.');

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

  if (['WITHDRAWN', 'REJECTED'].includes(teaser.status)) return problem(409, 'TEASER_INACTIVE', '철회되거나 거절된 TEASER는 후보로 선정할 수 없습니다.');

  const partyGate = await verifiedPartiesGate(challenge, teaser, env);
  if (partyGate) return partyGate;

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
    await sendPushNotification(env, teaser.solver_id, {
      title: '미션 후보 선정 결과가 있습니다',
      body: '내 TEASER의 검토 결과가 등록되었습니다. 앱에서 확인하세요.',
      route: 'challenge',
      challengeId,
    });
    return json({ ok: true, status: 'FUNDING_REQUIRED', fundingStatus: 'PAYMENT_REQUIRED', paymentDueAt });
  }

  if (teaser.status === 'SELECTED') return problem(409, 'FINALIST_ALREADY_SELECTED', '이미 FINALIST로 선택된 후보입니다.');

  const anotherShortlisted = await env.DB.prepare("SELECT id FROM teasers WHERE challenge_id = ? AND status = 'SHORTLISTED' AND id != ? LIMIT 1")
    .bind(challengeId, teaserId).first();
  if (teaser.status === 'SHORTLISTED' && !anotherShortlisted) {
    return json({ ok: true, status: 'SHORTLISTED', idempotent: true });
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE teasers SET status = CASE WHEN id = ? THEN 'SHORTLISTED' WHEN status = 'SHORTLISTED' THEN 'VIEWED' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE challenge_id = ? AND (id = ? OR status = 'SHORTLISTED')")
      .bind(teaserId, challengeId, teaserId),
    env.DB.prepare(`
      UPDATE challenges SET shortlisted_count = (SELECT count(*) FROM teasers WHERE challenge_id = challenges.id AND status IN ('SHORTLISTED','SELECTED')),
        status = CASE WHEN status IN ('OPEN','REVIEW') THEN 'SHORTLISTED' ELSE status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(challengeId),
    env.DB.prepare(`
      INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, metadata_json)
      VALUES (?, ?, ?, 'TEASER_SHORTLISTED', ?)
    `).bind(makeId('evt'), challengeId, owner.id, JSON.stringify({ teaserId, solverId: teaser.solver_id, replacedPreviousCandidate: Boolean(anotherShortlisted) })),
    auditStatement(env, owner.id, 'TEASER_SHORTLIST', 'challenge', challengeId, { previousCandidateId: anotherShortlisted?.id || null }, { candidateId: teaserId, singleCandidate: true }),
  ]);
  if (teaser.status !== 'SHORTLISTED') {
    await sendPushNotification(env, teaser.solver_id, {
      title: 'TEASER 검토 결과가 있습니다',
      body: '내 제안이 수행자 후보로 선택되었습니다. 앱에서 확인하세요.',
      route: 'challenge',
      challengeId,
    });
  }
  return json({ ok: true, status: 'SHORTLISTED' });
}

async function requestFunding(challengeId, request, env) {
  const moneyError = moneyFlowGuard(env, 'PG·지급대행 연결 전에는 보상금 Funding을 시작할 수 없습니다.');
  if (moneyError) return moneyError;
  const owner = await requireAuth(request, env);
  if (owner instanceof Response) return owner;
  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.owner_id !== owner.id) return problem(403, 'OWNER_REQUIRED', '미션 등록자만 Funding을 진행할 수 있습니다.');
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
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');

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
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.selected_solver_id !== solver.id) return problem(403, 'SELECTED_SOLVER_REQUIRED', '선정된 참가자만 결과를 제출할 수 있습니다.');
  if (challenge.status !== 'EXECUTING' || challenge.funding_status !== 'FUNDED') {
    return problem(409, 'NOT_READY_FOR_PROOF', 'Funding 완료 후 선정된 수행 단계에서만 결과를 제출할 수 있습니다.');
  }

  const moneyError = moneyFlowGuard(env, '실제 결제 검증 전에는 수행 결과를 제출할 수 없습니다.');
  if (moneyError) return moneyError;
  const gate = await verifiedPartiesGate(challenge, null, env);
  if (gate) return gate;
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
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
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
    return problem(400, 'INVALID_PAYOUT_RESULT', '미션 ID, 지급 거래번호와 지급 결과가 필요합니다.');
  }

  const challenge = await fetchChallenge(challengeId, env);
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  const settlement = await env.DB.prepare('SELECT * FROM settlements WHERE challenge_id = ?').bind(challengeId).first();
  if (!settlement) return problem(404, 'SETTLEMENT_NOT_FOUND', '정산정보를 찾을 수 없습니다.');
  if (settlement.payout_reference && settlement.payout_reference !== payoutReference) {
    return problem(409, 'PAYOUT_REFERENCE_MISMATCH', '이미 등록된 지급 거래번호와 일치하지 않습니다.');
  }
  if (settlement.status === payoutStatus) return json({ ok: true, idempotent: true, status: payoutStatus });
  if (challenge.status !== 'SUCCESS' || !['PROCESSING', 'FAILED'].includes(settlement.status)) {
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
        VALUES (?, ?, 'PAYOUT_PAID', '미션 보상금 지급이 완료되었습니다', ?, 'challenge', ?)`)
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
  if (!challenge) return problem(404, 'CHALLENGE_NOT_FOUND', '미션을 찾을 수 없습니다.');
  if (challenge.status !== 'SUCCESS') return problem(409, 'REVIEW_NOT_READY', '클리어 완료된 미션만 평가할 수 있습니다.');

  let revieweeId;
  let reviewerRole;
  if (reviewer.id === challenge.owner_id) {
    revieweeId = challenge.selected_solver_id;
    reviewerRole = 'OWNER';
  } else if (reviewer.id === challenge.selected_solver_id) {
    revieweeId = challenge.owner_id;
    reviewerRole = 'SOLVER';
  } else {
    return problem(403, 'PARTY_REQUIRED', '미션 당사자만 리뷰를 작성할 수 있습니다.');
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
  const actorProfiles = await env.DB.prepare(`SELECT subject_type, activity_name, organization_name, industry, company_intro, public_fields_json
    FROM member_actor_profiles WHERE user_id = ? ORDER BY created_at ASC`).bind(userId).all();
  const verifiedTypes = await env.DB.prepare(`SELECT verification_type, subject_type, verified_at, expires_at
    FROM member_verifications WHERE user_id = ? AND status = 'VERIFIED' AND ((verification_type='IDENTITY' AND provider='portone-v2') OR (verification_type IN ('BUSINESS','CORPORATION','ORGANIZATION') AND provider='entity-review-v1')) AND provider_reference_hash IS NOT NULL AND revoked_at IS NULL
      AND expires_at IS NOT NULL AND julianday(expires_at) > julianday('now')`).bind(userId).all();
  const trustPolicy = await env.DB.prepare(`SELECT p.version, p.status, i.item_key, i.label, i.enabled, i.weight
    FROM trust_policy_versions p JOIN trust_policy_items i ON i.policy_id = p.id
    WHERE p.status IN ('DRAFT','ACTIVE') ORDER BY CASE p.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, i.item_key`).all();
  const trustHistory = [
    ...recentReviews.results.map((review) => ({
      type: 'REVIEW',
      title: `${review.rating}점 상호 리뷰`,
      description: review.comment || '미션 상호평가가 반영되었습니다.',
      delta: review.rating >= 5 ? 2 : review.rating >= 4 ? 1 : review.rating <= 2 ? -2 : 0,
      date: review.created_at,
    })),
    ...recentSuccesses.results.map((challenge) => ({
      type: 'SUCCESS',
      title: challenge.owner_id === userId ? '클리어 성공 확정' : '미션 수행 성공',
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
      verifiedTypes: (verifiedTypes.results || []).map((item) => ({ type: item.verification_type, subjectType: item.subject_type, verifiedAt: item.verified_at, expiresAt: item.expires_at })),
      actorProfiles: (actorProfiles.results || []).map((item) => {
        const fields = safeJsonParse(item.public_fields_json, {});
        return {
          subjectType: item.subject_type,
          activityName: fields.activityName ? item.activity_name : null,
          organizationName: fields.organizationName ? item.organization_name : null,
          industry: fields.industry ? item.industry : null,
          companyIntro: fields.companyIntro ? item.company_intro : null,
          publicFields: fields,
        };
      }),
      trustBasis: {
        scoreFormulaStatus: 'UNSET',
        existingScorePreserved: true,
        policyVersion: trustPolicy.results?.[0]?.version || '2026-09-22-draft',
        items: (trustPolicy.results || []).map((item) => ({ key: item.item_key, label: item.label, enabled: Boolean(item.enabled), weight: item.weight ?? null })),
      },
    },
  });
}

async function adminOverview(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const role = adminRole(admin);

  await ensureModerationNoteStorage(env);
  await ensurePushStorage(env);
  await ensurePushDeliveryStorage(env);
  const [users, challenges, money, disputes, recent, recentUsers, openDisputes, pendingSettlements, staffCandidates, staffMembers, draftChallenges, moderationChallenges, pushSummary, pushDelivery, moderationStats, moderationAppeals, verificationStats, homeTheme] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status = 'suspended') suspended, SUM(strike_count > 0) with_strikes FROM users`),
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status = 'DRAFT') draft, SUM(status = 'OPEN') open, SUM(status = 'SUCCESS') success, SUM(status = 'DISPUTED') disputed FROM challenges`),
    env.DB.prepare(`SELECT COALESCE(SUM(platform_fee), 0) platform_revenue, COALESCE(SUM(solver_payout), 0) solver_payouts FROM settlements WHERE status = 'PAID'`),
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status NOT IN ('DECIDED','CLOSED')) open FROM disputes`),
    env.DB.prepare(`SELECT id, action, resource_type, resource_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 20`),
    env.DB.prepare(`SELECT id, display_name, account_type, status, trust_score, strike_count, created_at FROM users ORDER BY created_at DESC LIMIT 12`),
    env.DB.prepare(`SELECT d.id, d.challenge_id, d.reason_code, d.description, d.status, d.created_at, c.title,
      opener.display_name AS opened_by_name, respondent.display_name AS respondent_name
      FROM disputes d JOIN challenges c ON c.id = d.challenge_id
      JOIN users opener ON opener.id = d.opened_by
      LEFT JOIN users respondent ON respondent.id = d.respondent_id
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
    env.DB.prepare(`SELECT id, title, reward_amount, deadline, created_at, moderation_reasons_json, moderation_decision, moderation_risk_score,
      (SELECT note FROM moderation_review_notes n WHERE n.challenge_id = challenges.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note,
      (SELECT requested_approval_at FROM moderation_review_notes n WHERE n.challenge_id = challenges.id AND n.requested_approval_at IS NOT NULL ORDER BY n.created_at DESC LIMIT 1) AS requested_approval_at
      FROM challenges WHERE status = 'REVIEW'
      ORDER BY created_at ASC LIMIT 30`),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM push_subscriptions) subscribed,
      (SELECT COUNT(*) FROM push_delivery_logs WHERE status = 'accepted' AND created_at >= datetime('now', '-7 days')) accepted,
      (SELECT COUNT(*) FROM push_delivery_logs WHERE status IN ('failed','expired') AND created_at >= datetime('now', '-7 days')) failed`),
    env.DB.prepare(`SELECT substr(user_id, 1, 8) user_ref, status, COALESCE(reason_code, '') reason_code, created_at
      FROM push_delivery_logs ORDER BY created_at DESC LIMIT 12`),
    env.DB.prepare(`SELECT COUNT(*) total,
      SUM(moderation_action = 'AUTO_APPROVED') auto_approved,
      SUM(moderation_action = 'CHANGES_REQUIRED') changes_required,
      SUM(moderation_action = 'AUTO_REJECTED') auto_rejected,
      SUM(moderation_action = 'ADMIN_OVERRIDE') admin_overrides
      FROM challenges`),
    env.DB.prepare(`SELECT a.id, a.challenge_id, a.status, a.reason, a.created_at, c.title, c.moderation_action, c.moderation_risk_score, u.display_name
      FROM moderation_appeals a JOIN challenges c ON c.id = a.challenge_id JOIN users u ON u.id = a.user_id
      WHERE a.status IN ('OPEN','REVIEWING') ORDER BY a.created_at ASC LIMIT 30`),
    env.DB.prepare(`SELECT status, verification_type, COUNT(*) count FROM member_verifications GROUP BY status, verification_type`),
    env.DB.prepare('SELECT theme, revision FROM home_theme_settings WHERE id = 1'),
  ]);

  const isPrimary = role === 'primary';

  return json({
    overview: {
      role,
      homeTheme: isPrimary ? (homeTheme.results?.[0] || { theme: 'original', revision: 1 }) : null,
      launchReadiness: launchReadiness(env),
      users: users.results?.[0] || {},
      challenges: challenges.results?.[0] || {},
      money: isPrimary ? (money.results?.[0] || {}) : null,
      disputes: disputes.results?.[0] || {},
      recentAudit: isPrimary ? (recent.results || []) : [],
      recentUsers: isPrimary ? (recentUsers.results || []) : [],
      openDisputes: isPrimary ? (openDisputes.results || []) : [],
      pendingSettlements: isPrimary ? (pendingSettlements.results || []) : [],
      draftChallenges: isPrimary ? (draftChallenges.results || []) : [],
      moderationChallenges: (moderationChallenges.results || []).map((item) => ({
        ...item, moderationReasons: safeJsonParse(item.moderation_reasons_json, []),
      })),
      staffCandidates: isPrimary ? (staffCandidates.results || []) : [],
      staffMembers: isPrimary ? (staffMembers.results || []) : [],
      pushAudit: isPrimary ? { summary: pushSummary.results?.[0] || {}, recent: pushDelivery.results || [] } : null,
      moderationStats: moderationStats.results?.[0] || {},
      moderationAppeals: moderationAppeals.results || [],
      verificationStats: isPrimary ? (verificationStats.results || []) : [],
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
  const memberVerifications = await env.DB.prepare(`SELECT id, verification_type, subject_type, status, provider, subject_name, verified_at, expires_at, revoked_at, status_reason
    FROM member_verifications WHERE user_id = ? ORDER BY created_at DESC`).bind(userId).all();

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
      memberVerifications: (memberVerifications.results || []).map(publicVerification),
    },
  });
}

async function updateAdminMemberStatus(userId, request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const status = String(body.status || '').trim().toLowerCase();
  const reason = cleanText(body.reason, 10, 1000);
  if (!['active', 'limited', 'suspended'].includes(status) || !reason) {
    return problem(400, 'INVALID_MEMBER_STATUS', '계정 상태와 10자 이상의 운영 사유를 입력해주세요.');
  }
  const target = await env.DB.prepare(`SELECT u.*, COALESCE(ar.role, 'member') AS admin_role
    FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.id = ?`).bind(userId).first();
  if (!target) return problem(404, 'USER_NOT_FOUND', '가입회원을 찾을 수 없습니다.');
  if (target.admin_role !== 'member' || target.is_admin) return problem(409, 'ADMIN_ACCOUNT_PROTECTED', '관리자 계정은 권한을 회수한 뒤 상태를 변경해주세요.');
  if (target.status === 'closed') return problem(409, 'CLOSED_ACCOUNT_PROTECTED', '탈퇴 계정의 상태는 운영 화면에서 변경할 수 없습니다.');
  if (target.status === status) return json({ ok: true, idempotent: true, userId, status });

  const statements = [
    env.DB.prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(status, userId),
    auditStatement(env, primary.id, 'ADMIN_MEMBER_STATUS_CHANGE', 'user', userId,
      { status: target.status }, { status, reason }),
    env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
      VALUES (?, ?, 'ACCOUNT_STATUS', ?, ?, 'user', ?)`)
      .bind(makeId('not'), userId, status === 'active' ? '계정 이용 상태가 복구되었습니다' : status === 'limited' ? '계정 이용이 일부 제한되었습니다' : '계정 이용이 정지되었습니다', reason, userId),
  ];
  if (status === 'suspended') statements.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));
  await env.DB.batch(statements);
  return json({ ok: true, userId, status });
}

async function getAdminDisputeDetail(disputeId, request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;
  const dispute = await env.DB.prepare(`SELECT d.*, c.title, c.status AS challenge_status,
      opener.display_name AS opened_by_name, respondent.display_name AS respondent_name
    FROM disputes d JOIN challenges c ON c.id = d.challenge_id
    JOIN users opener ON opener.id = d.opened_by
    LEFT JOIN users respondent ON respondent.id = d.respondent_id
    WHERE d.id = ?`).bind(disputeId).first();
  if (!dispute) return problem(404, 'DISPUTE_NOT_FOUND', '분쟁 기록을 찾을 수 없습니다.');
  await audit(env, primary.id, 'ADMIN_DISPUTE_DETAIL_VIEW', 'dispute', dispute.id, null, { access: 'primary-only' });
  return json({ dispute: {
    id: dispute.id, challengeId: dispute.challenge_id, title: dispute.title,
    reasonCode: dispute.reason_code, description: dispute.description, status: dispute.status,
    resolution: dispute.resolution, challengeStatus: dispute.challenge_status,
    openedByName: dispute.opened_by_name, respondentName: dispute.respondent_name,
    createdAt: dispute.created_at, decidedAt: dispute.decided_at,
  } });
}

async function updateAdminDisputeStatus(disputeId, request, env) {
  const primary = await requirePrimaryAdmin(request, env);
  if (primary instanceof Response) return primary;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const status = String(body.status || '').trim().toUpperCase();
  const outcome = String(body.outcome || '').trim().toUpperCase();
  const resolution = cleanText(body.resolution, 10, 2000);
  if (!['EVIDENCE', 'MEDIATION', 'DECIDED', 'CLOSED'].includes(status) || !resolution) {
    return problem(400, 'INVALID_DISPUTE_STATUS', '처리 단계와 10자 이상의 처리 내용을 입력해주세요.');
  }
  const dispute = await env.DB.prepare(`SELECT d.*, c.status AS challenge_status
    FROM disputes d JOIN challenges c ON c.id = d.challenge_id WHERE d.id = ?`).bind(disputeId).first();
  if (!dispute) return problem(404, 'DISPUTE_NOT_FOUND', '분쟁 기록을 찾을 수 없습니다.');
  if (['DECIDED', 'CLOSED'].includes(dispute.status)) {
    return json({ ok: true, idempotent: true, disputeId, status: dispute.status });
  }
  const finalizing = ['DECIDED', 'CLOSED'].includes(status);
  if (finalizing && !['RESTORE', 'CANCELLED', 'FAILED', 'SUCCESS'].includes(outcome)) {
    return problem(400, 'DISPUTE_OUTCOME_REQUIRED', '종결할 때는 미션 처리 결과를 선택해주세요.');
  }

  const openingEvent = await env.DB.prepare(`SELECT from_status, metadata_json FROM challenge_events
    WHERE challenge_id = ? AND event_type = 'DISPUTE_OPENED' ORDER BY created_at DESC LIMIT 1`)
    .bind(dispute.challenge_id).first();
  const allowedRestore = new Set(['FUNDING_REQUIRED', 'EXECUTING', 'PROOF_SUBMITTED', 'SUCCESS', 'FAILED']);
  const restoredStatus = allowedRestore.has(openingEvent?.from_status) ? openingEvent.from_status : 'EXECUTING';
  const challengeStatus = outcome === 'RESTORE' ? restoredStatus : outcome;
  const eventType = finalizing ? 'DISPUTE_RESOLVED' : 'DISPUTE_STATUS_UPDATED';
  const statements = [
    env.DB.prepare(`UPDATE disputes SET status = ?, resolution = ?, decided_at = CASE WHEN ? IN ('DECIDED','CLOSED') THEN CURRENT_TIMESTAMP ELSE decided_at END WHERE id = ?`)
      .bind(status, resolution, status, disputeId),
    env.DB.prepare(`INSERT INTO challenge_events (id, challenge_id, actor_id, event_type, from_status, to_status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(makeId('evt'), dispute.challenge_id, primary.id, eventType, dispute.challenge_status, finalizing ? challengeStatus : dispute.challenge_status,
        JSON.stringify({ disputeId, status, outcome: finalizing ? outcome : null, resolution })),
    auditStatement(env, primary.id, 'ADMIN_DISPUTE_STATUS_CHANGE', 'dispute', disputeId,
      { status: dispute.status, challengeStatus: dispute.challenge_status }, { status, outcome: finalizing ? outcome : null, challengeStatus: finalizing ? challengeStatus : dispute.challenge_status, resolution }),
  ];
  if (finalizing) {
    statements.push(env.DB.prepare('UPDATE challenges SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(challengeStatus, dispute.challenge_id));
    const previousSettlement = safeJsonParse(openingEvent?.metadata_json, {}).settlementStatus;
    const settlementStatus = outcome === 'RESTORE' && previousSettlement
      ? previousSettlement
      : challengeStatus === 'SUCCESS' ? 'PROCESSING' : challengeStatus === 'FAILED' || challengeStatus === 'CANCELLED' ? 'FAILED' : null;
    if (settlementStatus) statements.push(env.DB.prepare("UPDATE settlements SET status = ? WHERE challenge_id = ? AND status NOT IN ('PAID','REFUNDED')").bind(settlementStatus, dispute.challenge_id));
  }
  for (const userId of [...new Set([dispute.opened_by, dispute.respondent_id].filter(Boolean))]) {
    statements.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
      VALUES (?, ?, 'DISPUTE_UPDATE', ?, ?, 'challenge', ?)`)
      .bind(makeId('not'), userId, finalizing ? '분쟁 처리 결과가 등록되었습니다' : '분쟁 처리 단계가 변경되었습니다', resolution, dispute.challenge_id));
  }
  await env.DB.batch(statements);
  return json({ ok: true, disputeId, status, challengeStatus: finalizing ? challengeStatus : dispute.challenge_status, moneyTransferred: false });
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
        .bind(makeId('not'), item.owner_id, `${item.title} 미션이 중지되고 Strike가 반영되었습니다.`, item.id),
    ];
    if (item.selected_solver_id) {
      operations.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body, resource_type, resource_id)
        VALUES (?, ?, 'FUNDING_FAILED', '보상금 Funding이 완료되지 않았습니다', ?, 'challenge', ?)`)
        .bind(makeId('not'), item.selected_solver_id, `${item.title} 미션이 중지되었습니다.`, item.id));
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
      identity: Boolean(user.verified_identity_current),
      business: false,
      professional: false,
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
      identityVerified: false,
      businessVerified: false,
      professionalVerified: false,
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
    isExample: String(c.id || '').startsWith('demo_') || String(c.title || '').startsWith('[예시]'),
    visibility: c.submitted_visibility || c.visibility,
    selectedSolverId: c.selected_solver_id,
    paymentDueAt: c.payment_due_at,
    ownerSubjectType: c.owner_subject_type || 'individual',
    ownerVerification: safeJsonParse(c.owner_verification_snapshot_json, {}),
    moderationReasons: safeJsonParse(c.moderation_reasons_json, []),
    moderationPending: false,
    moderationAction: c.moderation_action || (c.moderation_decision === 'ADMIN_REVIEW' ? 'CHANGES_REQUIRED' : c.moderation_decision === 'ARCHIVED' ? 'AUTO_REJECTED' : 'AUTO_APPROVED'),
    moderationDecision: c.moderation_decision || (c.status === 'REVIEW' ? 'ADMIN_REVIEW' : 'AUTO_APPROVED'),
    moderationRiskScore: Number(c.moderation_risk_score || 0),
    moderationPolicyVersion: c.moderation_policy_version || MODERATION_POLICY_VERSION,
    moderationGuidance: safeJsonParse(c.moderation_guidance_json, []),
    moderationAutoReviewedAt: c.moderation_auto_reviewed_at || null,
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
    solverSubjectType: t.solver_subject_type || 'individual',
    solverVerification: safeJsonParse(t.solver_verification_snapshot_json, {}),
    solver: {
      displayName: t.solver_name,
      trustScore: Number(t.solver_trust || 0),
      identityVerified: false,
      businessVerified: false,
      professionalVerified: false,
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
    const body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return problem(400, 'INVALID_JSON', 'JSON 객체가 필요합니다.');
    return body;
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
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
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

function base64UrlToBytes(value) {
  const normalized = String(value).replaceAll('-', '+').replaceAll('_', '/');
  return base64ToBytes(normalized + '='.repeat((4 - normalized.length % 4) % 4));
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

async function verifiedPartiesGate(challenge, teaser, env) {
  if (verificationEnforcement(env)==='advisory') return null;
  const owner = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(challenge.owner_id).first();
  if (!owner || !['active','limited'].includes(owner.status)) return problem(403,'OWNER_UNAVAILABLE','의뢰자 계정을 확인할 수 없습니다.');
  const ownerGate = verificationGate(await memberVerificationContext(owner,challenge.owner_subject_type || 'individual',env));
  if(ownerGate) return ownerGate;
  const solverId = teaser?.solver_id || challenge.selected_solver_id;
  if (!solverId) return problem(409,'SOLVER_REQUIRED','선정된 수행자가 필요합니다.');
  const solver = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(solverId).first();
  if(!solver || !['active','limited'].includes(solver.status) || solver.id===owner.id) return problem(403,'SOLVER_UNAVAILABLE','수행자 계정을 확인할 수 없습니다.');
  if(!teaser) teaser = await env.DB.prepare('SELECT solver_subject_type FROM teasers WHERE challenge_id=? AND solver_id=?').bind(challenge.id,solverId).first();
  return verificationGate(await memberVerificationContext(solver,teaser?.solver_subject_type || 'individual',env));
}
async function reviewMemberVerification(request,env) {
  const admin=await requirePrimaryAdmin(request,env);
  if(admin instanceof Response) return admin;
  const body=await readJson(request);
  if(body instanceof Response) return body;
  const decision=String(body.decision||'');
  const reason=cleanText(body.reason,10,500);
  if(!['REJECTED','REVOKED','RECONFIRM_REQUIRED'].includes(decision)||!reason) return problem(400,'INVALID_REVIEW','심사 사유가 필요합니다. 관리자는 기관 검증 없이 인증 완료로 변경할 수 없습니다.');
  const row=await env.DB.prepare('SELECT * FROM member_verifications WHERE id=?').bind(String(body.verificationId||'')).first();
  if(!row) return problem(404,'VERIFICATION_NOT_FOUND','인증 요청을 찾을 수 없습니다.');
  if(row.user_id===admin.id) return problem(403,'SELF_REVIEW_DENIED','본인의 인증을 심사할 수 없습니다.');
  const status=decision==='RECONFIRM_REQUIRED'?'EXPIRED':decision;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO verification_reviews(id,verification_id,reviewer_id,decision,reason) VALUES(?,?,?,?,?)').bind(makeId('vrr'),row.id,admin.id,decision,reason),
    env.DB.prepare('UPDATE member_verifications SET status=?,status_reason=?,revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status,reason,row.id),
    env.DB.prepare("UPDATE verified_identities SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND ?='IDENTITY'").bind(row.user_id,row.verification_type),
    auditStatement(env,admin.id,'VERIFICATION_ADMIN_REVIEW','member_verification',row.id,{status:row.status},{status,reason})
  ]);
  return json({ok:true,status});
}
