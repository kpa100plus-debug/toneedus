import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const origin = 'https://modu-challenge.yeit.workers.dev';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateProductionSnapshot({health, publicConfig, bootstrap, index, sw}, config, commit) {
  assert.match(commit || '', /^[0-9a-f]{40}$/i, 'A full deployment commit is required');
  assert.equal(health.ok, true); assert.equal(health.environment, 'production');
  assert.equal(health.commit, commit); assert.equal(health.version, config.vars.APP_VERSION); assert.equal(health.pwaVersion, config.vars.PWA_VERSION);
  assert.equal(health.moneyEnabled, false); assert.equal(health.moneyMode, 'disabled'); assert.equal(health.liveTransactionsAvailable, false);
  for (const settings of [publicConfig, bootstrap.config]) {
    assert.equal(settings.moneyEnabled, false); assert.equal(settings.moneyMode, 'disabled');
    assert.equal(settings.activityVerification, 'email'); assert.equal(settings.emailVerificationRequired, true);
  }
  assert.ok(Array.isArray(bootstrap.challenges), 'Bootstrap mission list missing');
  assert.ok(index.includes(`live-app.js?v=${health.pwaVersion.slice(1)}`)); assert.ok(!index.includes('class="transaction-launch-notice"'));
  assert.ok(sw.includes(`modu-challenge-${health.pwaVersion}`));
  return {productionVerified: true, version: health.version, pwaVersion: health.pwaVersion, commit: health.commit,
    moneyEnabled: health.moneyEnabled, moneyMode: health.moneyMode, identityAvailable: publicConfig.identityAvailable,
    emailVerificationAvailable: publicConfig.emailVerificationAvailable, activityVerification: publicConfig.activityVerification,
    publicMissionCount: bootstrap.challenges.length};
}

export async function readDeploymentMetadata({accountId, token, workerName}, fetcher = fetch) {
  if (!accountId || !token) return {verified: false, reason: 'CLOUDFLARE_CREDENTIALS_UNAVAILABLE'};
  assert.match(accountId, /^[0-9a-f]{32}$/i);
  assert.equal(workerName, 'modu-challenge');
  try {
    // GET only. Select specific non-sensitive fields; never persist the provider
    // response (which contains author email and could include other metadata).
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`, {
      method: 'GET', headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return {verified: false, reason: `CLOUDFLARE_HTTP_${response.status}`};
    const data = await response.json();
    const deployment = data.success === true ? data.result?.deployments?.[0] : null;
    if (!deployment || !uuid.test(deployment.id) || !Array.isArray(deployment.versions) || !deployment.versions.length ||
      deployment.versions.some(version => !uuid.test(version.version_id) || !Number.isFinite(version.percentage)) ||
      deployment.versions.reduce((sum, version) => sum + version.percentage, 0) !== 100) {
      return {verified: false, reason: 'CLOUDFLARE_DEPLOYMENT_METADATA_INVALID'};
    }
    return {verified: true, worker: workerName, deploymentId: deployment.id,
      createdAt: Number.isFinite(Date.parse(deployment.created_on)) ? new Date(deployment.created_on).toISOString() : null,
      versions: deployment.versions.map(version => ({id: version.version_id, percentage: version.percentage}))};
  } catch {
    return {verified: false, reason: 'CLOUDFLARE_METADATA_REQUEST_FAILED'};
  }
}

async function main() {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const request = path => fetch(origin + path, {signal: AbortSignal.timeout(15000), headers: {'Cache-Control': 'no-cache'}});
  async function read(path, type = 'json') {
    const response = await request(path);
    assert.equal(response.status, 200, `Unexpected HTTP status for ${path}`);
    return type === 'json' ? response.json() : response.text();
  }
  let error, result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [health, publicConfig, bootstrap, index, sw, admin, verifications] = await Promise.all([
        read('/api/health'), read('/api/config'), read('/api/bootstrap'), read('/', 'text'), read('/sw.js', 'text'),
        request('/api/admin/overview'), request('/api/me/verifications'),
      ]);
      assert.ok([401, 403].includes(admin.status), 'Anonymous administrator access must be blocked');
      assert.ok([401, 403].includes(verifications.status), 'Anonymous verification access must be blocked');
      result = {...validateProductionSnapshot({health, publicConfig, bootstrap, index, sw}, config, process.env.GITHUB_SHA),
        anonymousAdminStatus: admin.status, anonymousVerificationStatus: verifications.status};
      error = null; break;
    } catch (e) { error = e; if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
  if (error) throw error;
  // Inspect redirects without following them or signing in to external accounts.
  // Persist only the checks, never OAuth state, cookies or authorization URLs.
  result.oauthStarts = {};
  for (const [provider, hostname] of [['google', 'accounts.google.com'], ['naver', 'nid.naver.com']]) {
    const response = await fetch(`${origin}/api/auth/oauth/${provider}?returnTo=%2Fcreate`, {
      redirect: 'manual', signal: AbortSignal.timeout(15000), headers: {'Cache-Control': 'no-cache'},
    });
    assert.equal(response.status, 302, `${provider} OAuth start unavailable`);
    const destination = new URL(response.headers.get('Location'));
    assert.equal(destination.protocol, 'https:'); assert.equal(destination.hostname, hostname);
    assert.equal(destination.searchParams.get('redirect_uri'), `${origin}/api/auth/oauth/${provider}/callback`);
    const state = destination.searchParams.get('state');
    const cookie = response.headers.get('Set-Cookie') || '';
    assert.ok(state && state.length >= 20 && cookie.includes(`mc_oauth_state=${state};`), `${provider} state binding missing`);
    assert.ok(/;\s*HttpOnly/i.test(cookie) && /;\s*Secure/i.test(cookie) && /;\s*SameSite=Lax/i.test(cookie), `${provider} state cookie protection missing`);
    result.oauthStarts[provider] = {status: response.status, destinationHost: hostname, callbackMatches: true,
      stateCookieProtected: true, externalLoginCompleted: false};
  }
  result.workerDeployment = await readDeploymentMetadata({accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, workerName: config.name});
  result.checkedAt = new Date().toISOString();
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
