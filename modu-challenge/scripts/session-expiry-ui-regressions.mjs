import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { CATEGORY_META, STATUS_META, FUNDING_META } from '../public/assets/data.js';
import { calculateSettlement } from '../public/assets/business-rules.js';
const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), {
  url: 'https://test.invalid/#/create', runScripts: 'outside-only', pretendToBeVisual: true,
});
const win = dom.window, doc = win.document, ctx = dom.getInternalVMContext();
win.scrollTo = () => {}; win.HTMLElement.prototype.scrollIntoView = () => {}; win.matchMedia = () => ({ matches: false }); win.setupEntityUi = () => {};
Object.assign(win, { CATEGORY_META, STATUS_META, FUNDING_META, calculateSettlement });
vm.runInContext('class ApiError extends Error {constructor(message,options={}){super(message);Object.assign(this,options)}};const apiClient={};', ctx);
vm.runInContext(readFileSync(new URL('../public/assets/live-app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('init().catch((error) => fatal(error));', ''), ctx);
const run = code => vm.runInContext(code, ctx);

run(`loadRouteData=async()=>{};state.loading=false;state.authLoading=false;state.config={environment:'production',moneyEnabled:false};state.route='create';state.user={id:'owner-a',emailVerified:true};main.innerHTML=renderCreate();document.querySelector('[name=title]').value='세션 만료 후 복원할 미션 제목';state.adminOverview={private:'admin'};state.selectedChallenge={private:'mission'};state.challenges=[{id:'private',visibility:'private'},{id:'public',visibility:'public'}];`);
run('showError(new ApiError("로그인이 필요합니다",{status:401}));');
assert.equal(run('state.user'),null);
assert.equal(run('state.adminOverview'),null);assert.equal(run('state.selectedChallenge'),null);
assert.equal(run('state.challenges.length'),1);assert.equal(run('state.challenges[0].id'),'public');
assert.ok(doc.querySelector('.session-expired-prompt [data-action=login]'));
assert.equal(doc.querySelector('#challenge-create-form'),null);
assert.equal(JSON.parse(win.sessionStorage.getItem('modu-challenge-create-draft-owner-a')).values.title,'세션 만료 후 복원할 미션 제목');
await run('completeAuthentication({id:"owner-a",emailVerified:true})');
assert.equal(doc.querySelector('#challenge-create-form [name=title]').value,'세션 만료 후 복원할 미션 제목');
assert.equal(win.sessionStorage.getItem('modu-expired-session-user'),null);
console.log('PASS session expiry: private UI cleared, draft retained, same-account login resumes without submitting');
run('showError(new ApiError("로그인이 필요합니다",{status:401}));');
await run('completeAuthentication({id:"owner-b",emailVerified:true})');
assert.equal(doc.querySelector('#challenge-create-form [name=title]').value,'');
assert.equal(win.sessionStorage.getItem('modu-identity-return'),null);
assert.equal(JSON.parse(win.sessionStorage.getItem('modu-challenge-create-draft-owner-a')).values.title,'세션 만료 후 복원할 미션 제목');
console.log('PASS session expiry: different account cannot inherit the previous author’s draft');
win.close();
