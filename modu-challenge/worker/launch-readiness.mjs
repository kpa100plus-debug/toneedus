// Live financial adapters have NOT passed provider certification. A flag or secret
// must never activate the legacy manual/webhook simulation as a live payment rail.
export const LIVE_FINANCIAL_ADAPTERS_RELEASED = false;
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
