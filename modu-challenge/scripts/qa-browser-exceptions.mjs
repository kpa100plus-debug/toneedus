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
 const search=await pageFor(null,'explore');
 await search.route('**/api/challenges?*',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'검사용 통신 실패'}})}));
 await search.locator('#explore-search').fill('통신 실패 검색');
 await search.waitForResponse(r=>r.url().includes('/api/challenges?')&&r.status()===503);
 await search.locator('[data-action="retry-missions"]').waitFor();assert.doesNotMatch(await search.locator('#explore-grid').innerText(),/검색 결과가 없습니다/);assert.match(await search.locator('#explore-pagination').innerText(),/불러오지 못했습니다/);await search.unroute('**/api/challenges?*');await search.locator('[data-action="retry-missions"]').click();await search.waitForFunction(()=>document.querySelector('#explore-result-count')?.textContent==='0개 미션');assert.equal(await search.locator('#explore-search').inputValue(),'통신 실패 검색');console.log('PASS failed search has persistent retry; retry preserves query and receives real empty result');
 const home=await pageFor(null,'home');let release;const pending=new Promise(r=>release=r);let entered;const intercepted=new Promise(r=>entered=r);
 await home.route('**/api/challenges?*',async r=>{entered();await pending;await r.continue()});
 await home.locator('#hero-search-form [name=q]').fill('검수');await home.locator('#hero-search-form button[type=submit]').click();await intercepted;
 await home.getByRole('button',{name:'이용방법',exact:true}).first().click();await home.getByRole('heading',{name:'이용방법',exact:true}).waitFor();release();
 await home.waitForResponse(r=>r.url().includes('/api/challenges?'));await home.waitForTimeout(300);
 assert.equal(new URL(home.url()).hash,'#/how');console.log('PASS delayed home search cannot navigate away from the user’s newer page');
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser.close();}
