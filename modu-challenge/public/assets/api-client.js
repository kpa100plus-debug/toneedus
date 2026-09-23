/**
 * 모두의클리어 same-origin API client
 * © 2026 ISEA GROUP. All Rights Reserved.
 */

const PASSWORD_KDF_ITERATIONS = 210_000;
const PASSWORD_SALT_BYTES = 16;
const REQUEST_TIMEOUT_MS = 20_000;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function createPasswordMaterial(password, options = {}) {
  const value = String(password || '');
  if (value.length < 10 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw new ApiError('비밀번호는 영문과 숫자를 포함해 10자 이상이어야 합니다.', { code: 'WEAK_PASSWORD' });
  }

  const iterations = Number(options.iterations || PASSWORD_KDF_ITERATIONS);
  if (iterations !== PASSWORD_KDF_ITERATIONS) {
    throw new ApiError('안전한 로그인 설정을 확인하지 못했습니다.', { code: 'INVALID_KDF_SETTINGS' });
  }

  let saltBytes;
  try {
    saltBytes = options.salt
      ? base64ToBytes(String(options.salt))
      : crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  } catch {
    throw new ApiError('안전한 로그인 설정을 확인하지 못했습니다.', { code: 'INVALID_KDF_SETTINGS' });
  }
  if (saltBytes.length !== PASSWORD_SALT_BYTES) {
    throw new ApiError('안전한 로그인 설정을 확인하지 못했습니다.', { code: 'INVALID_KDF_SETTINGS' });
  }

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits'],
  );
  const verifier = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256',
  }, key, 256);

  return {
    passwordSalt: bytesToBase64(saltBytes),
    passwordVerifier: bytesToBase64(new Uint8Array(verifier)),
  };
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => timeoutController.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const options = {
    method,
    credentials: 'same-origin',
    signal: timeoutController.signal,
    headers: { Accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new ApiError(timeoutController.signal.aborted
      ? '요청 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.'
      : '서버에 연결하지 못했습니다. 네트워크 상태를 확인해주세요.', {
      code: timeoutController.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
      details: error?.message || null,
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  let payload = null;
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    try { payload = await response.json(); } catch { payload = null; }
  } else {
    try { payload = { raw: await response.text() }; } catch { payload = null; }
  }

  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError(error.message || `요청을 처리하지 못했습니다. (${response.status})`, {
      status: response.status,
      code: error.code || `HTTP_${response.status}`,
      details: error.details || payload,
    });
  }
  return payload;
}

export const apiClient = {
  listSimulations: () => api('/api/simulations'),
  createSimulation: (data) => api('/api/simulations', { method:'POST', body:data }),
  getSimulation: (id) => api(`/api/simulations/${encodeURIComponent(id)}`),
  actSimulation: (id, data) => api(`/api/simulations/${encodeURIComponent(id)}`, { method:'POST', body:data }),
  bootstrap: () => api('/api/bootstrap'),
  config: () => api('/api/config'),
  health: () => api('/api/health'),
  me: () => api('/api/me'),
  activity: () => api('/api/me/activity'),
  markNotificationRead: (id) => api(`/api/me/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }),
  pushSettings: () => api('/api/me/push-settings'),
  savePushSubscription: (subscription) => api('/api/me/push-subscriptions', { method: 'POST', body: subscription }),
  removePushSubscription: (endpoint) => api('/api/me/push-subscriptions/remove', { method: 'POST', body: { endpoint } }),
  oauthSignupInfo: () => api('/api/auth/oauth-signup'),
  oauthSignup: (data) => api('/api/auth/oauth-signup', { method: 'POST', body: data }),
  signup: (data) => api('/api/auth/signup', { method: 'POST', body: data }),
  loginOptions: (email) => api('/api/auth/login-options', { method: 'POST', body: { email } }),
  login: (data) => api('/api/auth/login', { method: 'POST', body: data }),
  verifyEmail: (token) => api('/api/auth/verify-email', { method: 'POST', body: { token } }),
  resendVerification: (email) => api('/api/auth/resend-verification', { method: 'POST', body: { email } }),
  findEmail: (data) => api('/api/auth/find-email', { method: 'POST', body: data }),
  requestPasswordReset: (email) => api('/api/auth/request-password-reset', { method: 'POST', body: { email } }),
  resetPassword: (data) => api('/api/auth/reset-password', { method: 'POST', body: data }),
  recoverPrimary: (data) => api('/api/auth/recover-primary', { method: 'POST', body: data }),
  logout: (endpoint = '') => api('/api/auth/logout', { method: 'POST', body: { endpoint } }),
  changePassword: (data) => api('/api/auth/change-password', { method: 'POST', body: data }),
  myVerifications: () => api('/api/me/verifications'),
  requestVerification: (data) => api('/api/me/verifications/requests', { method: 'POST', body: data }),
  saveActorProfile: (data) => api('/api/me/actor-profiles', { method: 'POST', body: data }),
  listChallenges: (params = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    });
    return api(`/api/challenges${query.size ? `?${query}` : ''}`);
  },
  getMyTeaser: (id) => api(`/api/challenges/${encodeURIComponent(id)}/my-teaser`),
  getChallenge: (id) => api(`/api/challenges/${encodeURIComponent(id)}`),
  createChallenge: (data, idempotencyKey) => api('/api/challenges', {
    method: 'POST', body: data, headers: { 'Idempotency-Key': idempotencyKey },
  }),
  updateChallenge: (id, data) => api(`/api/challenges/${encodeURIComponent(id)}`, { method: 'PUT', body: data }),
  cancelChallenge: (id, reason) => api(`/api/challenges/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { reason } }),
  openDispute: (id, data) => api(`/api/challenges/${encodeURIComponent(id)}/disputes`, { method: 'POST', body: data }),
  createModerationAppeal: (id, reason) => api(`/api/challenges/${encodeURIComponent(id)}/moderation/appeals`, { method: 'POST', body: { reason } }),
  submitTeaser: (id, data) => api(`/api/challenges/${encodeURIComponent(id)}/teasers`, { method: 'POST', body: data }),
  updateTeaser: (id, teaserId, data) => api(`/api/challenges/${encodeURIComponent(id)}/teasers/${encodeURIComponent(teaserId)}`, { method: 'PUT', body: data }),
  withdrawTeaser: (id, teaserId) => api(`/api/challenges/${encodeURIComponent(id)}/teasers/${encodeURIComponent(teaserId)}/withdraw`, { method: 'POST', body: {} }),
  listTeasers: (id) => api(`/api/challenges/${encodeURIComponent(id)}/teasers`),
  shortlist: (id, teaserId, mode = 'shortlist') => api(`/api/challenges/${encodeURIComponent(id)}/shortlist`, { method: 'POST', body: { teaserId, mode } }),
  requestFunding: (id) => api(`/api/challenges/${encodeURIComponent(id)}/funding/request`, { method: 'POST', body: {} }),
  confirmFunding: (id, data = {}) => api(`/api/challenges/${encodeURIComponent(id)}/funding/confirm`, { method: 'POST', body: data }),
  submitProof: (id, data) => api(`/api/challenges/${encodeURIComponent(id)}/proof`, { method: 'POST', body: data }),
  confirmSuccess: (id) => api(`/api/challenges/${encodeURIComponent(id)}/success`, { method: 'POST', body: {} }),
  createReview: (id, data) => api(`/api/challenges/${encodeURIComponent(id)}/reviews`, { method: 'POST', body: data }),
  trust: (userId) => api(`/api/users/${encodeURIComponent(userId)}/trust`),
  startIdentity: body => api('/api/me/identity/start', {method:'POST',body}),
  completeIdentity: body => api('/api/me/identity/complete', {method:'POST',body}),
  verificationReviews: () => api('/api/admin/verification-reviews'),
  reviewVerification: body => api('/api/admin/verification-reviews', {method:'POST',body}),
  adminOverview: () => api('/api/admin/overview'),
  sendPushAnnouncement: (data) => api('/api/admin/push-announcements', { method: 'POST', body: data }),
  approveModerationChallenge: (id) => api(`/api/admin/challenges/${encodeURIComponent(id)}/moderation/approve`, { method: 'POST', body: {} }),
  archiveModerationChallenge: (id, reason) => api(`/api/admin/challenges/${encodeURIComponent(id)}/moderation/archive`, { method: 'POST', body: { reason } }),
  moderationQueue: () => api('/api/admin/moderation-queue'),
  autoReviewModerationQueue: () => api('/api/admin/moderation/auto-review', { method: 'POST', body: {} }),
  addModerationNote: (id, note, requestApproval) => api(`/api/admin/challenges/${encodeURIComponent(id)}/moderation/notes`, { method: 'POST', body: { note, requestApproval } }),
  adminMemberDetail: (userId) => api(`/api/admin/members/${encodeURIComponent(userId)}`),
  updateAdminMemberStatus: (userId, data) => api(`/api/admin/members/${encodeURIComponent(userId)}/status`, { method: 'POST', body: data }),
  adminDisputeDetail: (disputeId) => api(`/api/admin/disputes/${encodeURIComponent(disputeId)}`),
  updateAdminDisputeStatus: (disputeId, data) => api(`/api/admin/disputes/${encodeURIComponent(disputeId)}/status`, { method: 'POST', body: data }),
  appointDeputy: (userId) => api('/api/admin/deputies', { method: 'POST', body: { userId } }),
  revokeDeputy: (userId) => api(`/api/admin/deputies/${encodeURIComponent(userId)}/revoke`, { method: 'POST', body: {} }),
  issueStrike: (data) => api('/api/admin/strikes', { method: 'POST', body: data }),
};
