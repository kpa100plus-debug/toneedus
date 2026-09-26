import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { CATEGORY_META, STATUS_META, FUNDING_META } from '../public/assets/data.js';
import { calculateSettlement } from '../public/assets/business-rules.js';

const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), {
  url: 'http://test.invalid/#/home', runScripts: 'outside-only', pretendToBeVisual: true,
});
const win = dom.window, doc = win.document, ctx = dom.getInternalVMContext();
win.scrollTo = () => {};
win.HTMLElement.prototype.scrollIntoView = () => {};
win.matchMedia = () => ({ matches: false });
win.setupEntityUi = () => {};
Object.assign(win, { CATEGORY_META, STATUS_META, FUNDING_META, calculateSettlement });
vm.runInContext('class ApiError extends Error {}; const apiClient = {};', ctx);
vm.runInContext(readFileSync(new URL('../public/assets/live-app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('init().catch((error) => fatal(error));', ''), ctx);
const run = code => vm.runInContext(code, ctx);
let count = 0;
const pass = name => { count++; console.log('PASS modal interaction: ' + name); };

await run(`
  loadCurrentUser = async () => ({id:'modal-qa', emailVerified:true});
  loadBootstrapData = async () => ({config:{environment:'production',moneyEnabled:false},health:{},challenges:[]});
  loadRouteData = async () => {};
  render = renderSystemNotice = openDirectAuthRoute = bindWebAppInstall = () => {};
  openDeepLinkedChallenge = async () => {};
  init();
`);

function openDraft(formId) {
  run(`openModal('<form id="${formId}" data-challenge-id="mission-qa"><textarea name="description"></textarea><select name="category"><option value="FIND">찾기</option><option value="BUSINESS">사업</option></select></form>', {title:'작성 중'});`);
  return doc.querySelector('form');
}

for (const id of ['challenge-edit-form', 'teaser-edit-form', 'teaser-form']) {
  const form = openDraft(id);
  form.elements.description.value = `${id}에서 작성한 내용`;
  form.elements.description.dispatchEvent(new win.Event('input', { bubbles: true }));
  const key = run(`transientModalDraftKey(document.querySelector('form'))`);
  assert.equal(JSON.parse(win.sessionStorage.getItem(key)).description, `${id}에서 작성한 내용`);
  doc.querySelector('.modal-backdrop').click();
  assert.equal(doc.querySelector('form'), form);
  assert.equal(form.elements.description.value, `${id}에서 작성한 내용`);
  // A select change is captured on explicit close even without an input event.
  form.elements.category.value = 'BUSINESS';
  doc.querySelector('[aria-label="닫기"]').click();
  assert.equal(doc.querySelector('[role="dialog"]'), null);
  const reopened = openDraft(id);
  run(`restoreTransientModalDraft(document.querySelector('form'))`);
  assert.equal(reopened.elements.description.value, `${id}에서 작성한 내용`);
  assert.equal(reopened.elements.category.value, 'BUSINESS');
  run('closeModal()');
}
pass('background clicks retain mission and teaser forms; X closes and drafts restore');

let form = openDraft('challenge-edit-form');
form.elements.description.value = 'Escape로 닫기 전 내용';
doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(doc.querySelector('[role="dialog"]'), null);
form = openDraft('challenge-edit-form');
run(`restoreTransientModalDraft(document.querySelector('form'))`);
assert.equal(form.elements.description.value, 'Escape로 닫기 전 내용');
form.elements.description.value = '뒤로가기 전 내용';
win.dispatchEvent(new win.PopStateEvent('popstate'));
assert.equal(doc.querySelector('[role="dialog"]'), null);
assert.equal(run('modalHistoryEntry'), false);
form = openDraft('challenge-edit-form');
run(`restoreTransientModalDraft(document.querySelector('form'))`);
assert.equal(form.elements.description.value, '뒤로가기 전 내용');
run('closeModal()');
pass('Escape and browser history dismissal retain the current draft');

form = openDraft('teaser-form');
form.elements.description.value = '저장 공간이 부족한 경우';
const originalSetItem = win.Storage.prototype.setItem;
win.Storage.prototype.setItem = () => { throw new win.DOMException('Full', 'QuotaExceededError'); };
doc.querySelector('[aria-label="닫기"]').click();
win.Storage.prototype.setItem = originalSetItem;
assert.equal(doc.querySelector('[role="dialog"]'), null);
pass('X remains usable when browser draft storage is unavailable');

form = openDraft('teaser-form');
form.elements.description.value = '이미 제출된 내용';
const consumedKey = run(`transientModalDraftKey(document.querySelector('form'))`);
win.sessionStorage.removeItem(consumedKey);
run('closeModal()');
assert.equal(win.sessionStorage.getItem(consumedKey), null);
pass('submission-driven close does not recreate a consumed draft');

run(`const qaChallenge = {id:'mission-qa',status:'SHORTLISTED',fundingStatus:'POSTED',teaserCount:2};`);
for (const viewer of [{ isOwner: true }, { isSelectedSolver: true }, {}]) {
  const context = JSON.stringify(viewer);
  assert.doesNotMatch(run(`renderLiveActions(qaChallenge, ${context})`), /start-simulation/);
  assert.doesNotMatch(run(`renderProgressNotice(qaChallenge, ${context})`), /가상 거래로 복제해 테스트/);
}
assert.match(run('renderLiveActions(qaChallenge, {isAdmin:true})'), /start-simulation/);
assert.match(run('renderProgressNotice(qaChallenge, {isAdmin:true})'), /운영 관리자는 아래/);
pass('simulation clone action and instructions are visible only to administrators');

win.close();
console.log(`${count} modal interaction regression groups passed`);
