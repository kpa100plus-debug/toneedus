import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const origin='https://modu-challenge.yeit.workers.dev';
async function read(path,type='json') {
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
  assert.equal(response.status,200,`Unexpected HTTP status for ${path}`);
  return type==='json'?response.json():response.text();
}
let error;
for(let attempt=1;attempt<=3;attempt++) {
  try {
    const [health,publicConfig,index,sw]=await Promise.all([read('/api/health'),read('/api/config'),read('/','text'),read('/sw.js','text')]);
    assert.equal(health.ok,true);assert.equal(health.environment,'production');
    assert.equal(health.commit,process.env.GITHUB_SHA);assert.equal(health.version,config.vars.APP_VERSION);assert.equal(health.pwaVersion,config.vars.PWA_VERSION);
    assert.equal(health.moneyEnabled,false);assert.equal(health.moneyMode,'disabled');assert.equal(health.liveTransactionsAvailable,false);
    assert.equal(publicConfig.moneyEnabled,false);assert.equal(publicConfig.moneyMode,'disabled');assert.equal(publicConfig.activityVerification,'email');assert.equal(publicConfig.emailVerificationRequired,true);
    assert.ok(index.includes(`live-app.js?v=${health.pwaVersion.slice(1)}`));assert.ok(!index.includes('class="transaction-launch-notice"'));
    assert.ok(sw.includes(`modu-challenge-${health.pwaVersion}`));
    console.log(JSON.stringify({productionVerified:true,version:health.version,pwaVersion:health.pwaVersion,commit:health.commit,moneyEnabled:health.moneyEnabled,moneyMode:health.moneyMode,identityAvailable:publicConfig.identityAvailable,emailVerificationAvailable:publicConfig.emailVerificationAvailable,activityVerification:publicConfig.activityVerification,checkedAt:new Date().toISOString()}));
    error=null;break;
  } catch(e) {error=e;if(attempt<3)await new Promise(resolve=>setTimeout(resolve,5000));}
}
if(error)throw error;
