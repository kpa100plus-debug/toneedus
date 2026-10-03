import {mkdirSync} from 'node:fs';
mkdirSync(process.env.QA_EVIDENCE_DIR || '/tmp/modu-qa-evidence',{recursive:true});
const chromium=process.env.QA_CHROMIUM_ADAPTER ? (await import(process.env.QA_CHROMIUM_ADAPTER)).default : null;
const {chromium:pw}=await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
if(chromium)chromium.setGraphicsMode=false;
const browser=await pw.launch({executablePath:process.env.QA_CHROMIUM_PATH || undefined,args:[...(chromium?.args || []).filter(a=>!a.includes('in-process-gpu')&&a!=='--single-process'),'--disable-gpu','--disable-software-rasterizer','--disable-vulkan'],headless:true});
const origin='http://127.0.0.1:8789';
async function pageFor(role,route='explore'){const c=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});if(role)await c.addCookies([{name:'mc_session',value:'qa-session-'+role,url:origin}]);const p=await c.newPage();p.setDefaultTimeout(6000);await p.goto(origin+'/#/'+route);await p.waitForFunction(()=>!document.querySelector('#account-button')?.disabled);const dismiss=p.locator('[data-action="dismiss-install"]');if(await dismiss.count())await dismiss.click();return p;}
async function detail(p){if(await p.locator('.modal').count())await p.locator('[data-action=close-modal]').first().click();await p.goto(origin+'/#/explore');await p.locator('[data-challenge-id="qa_mission_2"]').first().click();await p.locator('.modal').waitFor();}
try{
 const p=await pageFor(null,'home');const cdp=await p.context().newCDPSession(p);const result=await cdp.send('Page.getAppManifest');assert.equal(result.errors.length,0,JSON.stringify(result.errors));const m=JSON.parse(result.data);assert.equal(m.display,'standalone');assert.equal(m.start_url,'/?source=pwa');
 for(const icon of m.icons){const r=await p.request.get(origin+icon.src);assert.equal(r.status(),200);assert.match(r.headers()['content-type'],/image\/png/);const b=await r.body();const [w,h]=icon.sizes.split('x').map(Number);assert.equal(b.readUInt32BE(16),w);assert.equal(b.readUInt32BE(20),h);}
 const apple=await p.locator('link[rel=apple-touch-icon]').getAttribute('href');const a=await p.request.get(origin+apple);assert.equal(a.status(),200);assert.equal((await a.body()).readUInt32BE(16),180);
 await p.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Service worker not ready')),8000))])});const cache=await p.evaluate(async()=>{const keys=await caches.keys();return {keys,icons:await Promise.all(['/assets/icon-180.png','/assets/icon-192.png','/assets/icon-512.png','/assets/icon-maskable-512.png'].map(async u=>!!(await caches.match(u))))}});assert.ok(cache.icons.every(Boolean),JSON.stringify(cache));
 const installability=await cdp.send('Page.getInstallabilityErrors');assert.deepEqual(installability.installabilityErrors,[]);console.log('PASS Chromium manifest/installability, PNG dimensions, apple-touch-icon and service-worker icon cache');
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser.close();}
