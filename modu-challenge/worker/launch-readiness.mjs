// Live financial adapters have NOT passed provider certification. A flag or secret
// must never activate the legacy manual/webhook simulation as a live payment rail.
export const LIVE_FINANCIAL_ADAPTERS_RELEASED = false;
// Administrator-only diagnostics: presence/validity, never secret values.
export function identitySetupChecks(env) {
  return [
    { key: 'IDENTITY_VERIFICATION_PROVIDER', label: 'PortOne V2 인증기관 선택', ready: env.IDENTITY_VERIFICATION_PROVIDER === 'portone-v2' },
    { key: 'IDENTITY_INTEGRATION_APPROVED', label: '기관 계약·연동 검증 승인', ready: env.IDENTITY_INTEGRATION_APPROVED === 'true' },
    ...['PORTONE_STORE_ID', 'PORTONE_IDENTITY_CHANNEL_KEY', 'PORTONE_API_SECRET', 'IDENTITY_HASH_SECRET'].map(key => ({
      key, label: ({ PORTONE_STORE_ID: '상점 ID', PORTONE_IDENTITY_CHANNEL_KEY: '본인인증 채널 키', PORTONE_API_SECRET: '서버 API 시크릿', IDENTITY_HASH_SECRET: '식별정보 해시 전용 시크릿' })[key],
      ready: typeof env[key] === 'string' && env[key].length >= (key === 'IDENTITY_HASH_SECRET' ? 32 : 8),
    })),
  ];
}
export function identityConfigured(env) {
  return env.IDENTITY_VERIFICATION_PROVIDER === 'portone-v2' &&
    env.IDENTITY_INTEGRATION_APPROVED === 'true' &&
    ['PORTONE_STORE_ID','PORTONE_IDENTITY_CHANNEL_KEY','PORTONE_API_SECRET','IDENTITY_HASH_SECRET']
      .every(key => typeof env[key] === 'string' && env[key].length >= (key === 'IDENTITY_HASH_SECRET' ? 32 : 8));
}
export function launchReadiness(env) {
  return {
    liveTransactionsAvailable: false,
    entityReviewImplemented: true,
    financialSandboxAdaptersImplemented: true,
    identityConnected: identityConfigured(env),
    verificationEnforcement: ['test','development'].includes(env.APP_ENV) ? (env.VERIFICATION_ENFORCEMENT || 'required') : 'required',
    blockers: [
      ...(!identityConfigured(env) ? ['IDENTITY_PROVIDER_CONTRACT_AND_VALIDATION'] : []),
      'ENTITY_AUTHORITY_REVIEW_AND_RETENTION_POLICY',
      'PG_MARKETPLACE_AND_CUSTODY_CONTRACT',
      'PAYOUT_SELLER_KYC_AND_PROVIDER_ADAPTER',
      'PROVIDER_SANDBOX_AND_LIVE_ACCEPTANCE',
      'LEGAL_COMPANY_DETAILS_AND_TRANSACTION_POLICIES'
    ]
  };
}
