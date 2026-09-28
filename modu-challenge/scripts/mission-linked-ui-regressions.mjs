import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { CATEGORY_META, STATUS_META, FUNDING_META } from '../public/assets/data.js';
import { calculateSettlement } from '../public/assets/business-rules.js';

// Frontend contracts only: all API replies and identities below are fixtures.
// This suite never calls the production service or verifies external money flows.
const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), {
  url: 'https://test.invalid/#/home', runScripts: 'outside-only', pretendToBeVisual: true,
});
const win = dom.window, doc = win.document, context = dom.getInternalVMContext();
win.scrollTo = () => {};
win.HTMLElement.prototype.scrollIntoView = () => {};
win.matchMedia = () => ({ matches: false });
win.setupEntityUi = () => {};
Object.assign(win, { CATEGORY_META, STATUS_META, FUNDING_META, calculateSettlement });
vm.runInContext('class ApiError extends Error {constructor(message,options={}){super(message);Object.assign(this,options)}};const apiClient={};', context);
vm.runInContext(readFileSync(new URL('../public/assets/live-app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('init().catch((error) => fatal(error));', ''), context);
const run = code => vm.runInContext(code, context);
let passed = 0;
const pass = name => { passed++; console.log('PASS mission linked UI: ' + name); };

run(`state.user={id:'actual-owner',emailVerified:true,isAdmin:false};state.config={environment:'production',moneyEnabled:false,moneyMode:'disabled'};state.loading=false;state.authLoading=false;`);

const nativeSetTimeout = win.setTimeout.bind(win), nativeClearTimeout = win.clearTimeout.bind(win);
const tasks = new Map();
let time = 0, timerId = 0;
win.setTimeout = (callback, delay = 0) => { const id = ++timerId; tasks.set(id, { at: time + delay, callback }); return id; };
win.clearTimeout = id => tasks.delete(id);
function advanceTime(milliseconds) {
  time += milliseconds;
  for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at)) {
    if (task.at <= time && tasks.has(id)) { tasks.delete(id); task.callback(); }
  }
}
run(`history.replaceState({preserve:'history-state'},'','#/dashboard?oauth=success&challenge=mission-linked');renderSystemNotice();`);
assert.equal(doc.querySelector('#system-notice').hidden, false);
assert.match(doc.querySelector('#system-notice-title').textContent, /소셜 로그인 완료/);
advanceTime(4999);
assert.equal(doc.querySelector('#system-notice').hidden, false);
advanceTime(1);
assert.equal(doc.querySelector('#system-notice').hidden, true);
assert.equal(win.location.hash, '#/dashboard?challenge=mission-linked');
assert.equal(win.history.state.preserve, 'history-state');
pass('authenticated OAuth success disappears after five seconds while retaining mission return query and history state');

run(`history.replaceState(null,'','#/dashboard?oauth=success');renderSystemNotice();history.replaceState(null,'','#/dashboard?oauth_error=callback-failed');renderSystemNotice();`);
advanceTime(60000);
assert.equal(doc.querySelector('#system-notice').hidden, false);
assert.equal(doc.querySelector('#system-notice-body').textContent, 'callback-failed');
assert.match(win.location.hash, /oauth_error=callback-failed/);
run(`state.user=null;history.replaceState(null,'','#/dashboard?oauth=success');renderSystemNotice();`);
advanceTime(60000);
assert.equal(doc.querySelector('#system-notice').hidden, false);
assert.match(doc.querySelector('#system-notice-title').textContent, /로그인 상태 확인 필요/);
pass('OAuth errors and missing-session notices persist and cannot be hidden by an older success timer');
win.setTimeout = nativeSetTimeout;
win.clearTimeout = nativeClearTimeout;

const baseChallenge = {
  id: 'mission-linked', ownerId: 'actual-owner', title: '두 회원의 실제 미션 연결 테스트',
  category: 'LOCAL', status: 'SHORTLISTED', fundingStatus: 'POSTED', rewardAmount: 100000,
  summary: '실제 거래 없이 미션 진행을 확인합니다.', description: '검수용 설명',
  successCriteria: '결과 세 개를 제출', paymentTrigger: '최종 수행자 확정 후 가상 확보',
  evidenceRequirements: '검수용 결과 문서', region: '서울', deadline: '2026-12-31T00:00:00Z',
  participantCount: 2, teaserCount: 2, owner: { trustScore: 50, strikes: 0 },
};
const baseDetail = { challenge: baseChallenge, context: { isOwner: true, isAdmin: false }, ownerReviews: [] };
win.testDetail = structuredClone(baseDetail);
win.refreshReads = [];
run(`state.user={id:'actual-owner',emailVerified:true,isAdmin:false};state.selectedChallenge=testDetail;renderChallengeModal(testDetail);apiClient.getChallenge=async(id,options)=>{refreshReads.push({id,refresh:options?.refresh});return testDetail;};`);
assert.equal(doc.querySelectorAll('[data-action="open-mission-simulation"]').length, 2);
assert.match(doc.querySelector('.workflow-notice').textContent, /보상금 확보부터 결과 제출·검수·지급 완료/);
assert.match(doc.querySelector('.workflow-notice').textContent, /실제 청구·송금은 0원/);
assert.doesNotMatch(run('renderLiveActions(testDetail.challenge,{isOwner:false,isAdmin:false})'), /open-mission-simulation/);
assert.doesNotMatch(run('renderLiveActions({...testDetail.challenge,status:"OPEN"},{isOwner:true})'), /open-mission-simulation/);
pass('shortlisted owner has direct simulation entry in progress notice and sidebar, other members and unselected missions do not');
const unchangedDetail = doc.querySelector('[data-mission-detail]');
await run('refreshMissionDetail()');
assert.equal(doc.querySelector('[data-mission-detail]'), unchangedDetail);
assert.notEqual(run('missionDetailPollTimer'), null);
assert.equal(win.refreshReads[0].id, baseChallenge.id);
assert.equal(win.refreshReads[0].refresh, true);
pass('an unchanged detail refresh retains DOM, enables polling and uses the read-without-view-count refresh option');

let completeRefresh;
let detailRequests = 0;
win.pendingDetail = () => { detailRequests++; return new Promise(resolve => { completeRefresh = resolve; }); };
run('apiClient.getChallenge=pendingDetail;');
const oldRefresh = run('refreshMissionDetail()');
await run('refreshMissionDetail()');
assert.equal(detailRequests, 1);
run(`openModal('<form id="proof-writing-fixture"><textarea name="description">작성 중인 결과 내용을 보존합니다</textarea></form>',{title:'결과 작성'});`);
const writingForm = doc.querySelector('#proof-writing-fixture');
writingForm.elements.description.value += ' · 아직 제출하지 않음';
completeRefresh({ ...structuredClone(baseDetail), challenge: { ...baseChallenge, status: 'FUNDED' } });
await oldRefresh;
assert.equal(doc.querySelector('#proof-writing-fixture'), writingForm);
assert.match(writingForm.elements.description.value, /아직 제출하지 않음/);
assert.equal(run('missionDetailPollTimer'), null);
assert.equal(run('state.selectedChallenge.challenge.status'), 'SHORTLISTED');
pass('a delayed detail refresh cannot replace a newly opened writing form or lose its unsubmitted content');

run('state.selectedChallenge=testDetail;renderChallengeModal(testDetail);');
const oldUserDetail = doc.querySelector('[data-mission-detail]');
const userRefresh = run('refreshMissionDetail()');
run(`state.user={id:'actual-solver',emailVerified:true,isAdmin:false};`);
completeRefresh({ ...structuredClone(baseDetail), challenge: { ...baseChallenge, status: 'FUNDED' } });
await userRefresh;
assert.equal(doc.querySelector('[data-mission-detail]'), oldUserDetail);
assert.equal(run('state.selectedChallenge.challenge.status'), 'SHORTLISTED');
pass('a response requested by an earlier account cannot update the newly signed-in account view');

run(`state.user={id:'actual-owner',emailVerified:true,isAdmin:false};state.selectedChallenge=testDetail;renderChallengeModal(testDetail);`);
doc.querySelector('.modal-body').scrollTop = 180;
win.updatedDetail = { ...structuredClone(baseDetail), challenge: { ...baseChallenge, status: 'FUNDING_REQUIRED' } };
run('apiClient.getChallenge=async()=>updatedDetail;');
await run('refreshMissionDetail()');
assert.equal(run('state.selectedChallenge.challenge.status'), 'FUNDING_REQUIRED');
assert.equal(doc.querySelector('.modal-body').scrollTop, 180);
run('closeModal({preserveHistory:true});');
assert.equal(run('missionDetailPollTimer'), null);
pass('changed server detail updates the stage, retains scroll position, and closing cancels polling');

run('state.selectedChallenge=testDetail;renderChallengeModal(testDetail);apiClient.getChallenge=async()=>{throw new ApiError("network temporary failure")};');
const confirmedDetail = doc.querySelector('[data-mission-detail]');
await run('refreshMissionDetail()');
assert.equal(doc.querySelector('[data-mission-detail]'), confirmedDetail);
assert.equal(run('missionDetailPollBusy'), false);
run('closeModal({preserveHistory:true});');
pass('a polling error preserves the last confirmed detail and releases the pending-request guard');

const linkedBase = {
  id: 'linked-run-one', challengeId: baseChallenge.id, teaserId: 'candidate-teaser',
  ownerId: 'actual-owner', solverId: 'actual-solver', revision: 0,
  title: baseChallenge.title, rewardAmount: 100000, platformFee: 10000, solverPayout: 90000,
  feeRate: 0.1, stage: 'FUNDING_REQUIRED', paymentStatus: 'NONE', payoutStatus: 'NONE',
  executionStarted: false, proof: null, proofHistory: [], reviewReason: '', events: [],
  mode: 'MISSION_SIMULATION', actualCharge: 0, active: true, blockedReason: null,
};
let serverSimulation = null, expectedAction = null, actorId = 'actual-owner';
const requests = [];
function setActor(id, isAdmin = false) {
  actorId = id;
  run(`state.user=${JSON.stringify({ id, isAdmin, emailVerified: true, verification: { identity: false } })};`);
}
function accessFixture() {
  return {
    simulation: structuredClone(serverSimulation), mode: 'MISSION_SIMULATION', actualCharge: 0,
    viewerRole: actorId === 'actual-owner' ? 'owner' : actorId === 'actual-solver' ? 'solver' : null,
    canStart: actorId === 'actual-owner' && (!serverSimulation || serverSimulation.stage === 'CANCELLED'), candidateTeaserId: 'candidate-teaser',
  };
}
function detailFixture() {
  const participating = ['actual-owner', 'actual-solver'].includes(actorId);
  return {
    ...structuredClone(baseDetail),
    context: {
      isOwner: actorId === 'actual-owner', isAdmin: false,
      viewerTeaser: actorId === 'actual-solver' ? { id: 'candidate-teaser', status: 'SHORTLISTED', canEdit: false } : null,
      missionSimulation: participating ? structuredClone(serverSimulation) : null,
    },
  };
}
win.fixtureMissionAccess = accessFixture;
win.fixtureMissionDetail = detailFixture;
win.fixtureMissionAction = (challengeId, body) => {
  assert.ok(expectedAction, 'no unexpected API write is allowed');
  assert.equal(challengeId, baseChallenge.id);
  assert.equal(body.action, expectedAction.action);
  assert.match(body.requestId, /^[\w-]{16,100}$/);
  assert.equal('role' in body, false, 'the browser must not choose another account role');
  assert.equal('amount' in body || 'rewardAmount' in body, false, 'server amounts are not sent back as a charge');
  if (body.action === 'START') assert.equal('revision' in body, false);
  else assert.equal(body.revision, serverSimulation.revision);
  for (const [key, value] of Object.entries(expectedAction.payload || {})) assert.equal(body[key], value, key);
  requests.push({ actorId, challengeId, body: JSON.parse(JSON.stringify(body)) });
  serverSimulation = structuredClone(expectedAction.result);
  expectedAction = null;
  return accessFixture();
};
run(`state.route='explore';state.selectedChallenge=null;state.missionSimulationAccess=null;bindGlobalEvents();apiClient.getMissionSimulation=async()=>fixtureMissionAccess();apiClient.getChallenge=async()=>fixtureMissionDetail();apiClient.actMissionSimulation=async(id,body)=>fixtureMissionAction(id,body);`);
setActor('actual-owner');

const candidate = { id: 'candidate-teaser', solverId: 'actual-solver', status: 'SHORTLISTED', headline: '선정된 제안', capability: '수행 경험', approach: '단계별 수행', expectedDays: 3, solver: { trustScore: 50 } };
win.candidateFixture = candidate;
win.candidateAccess = accessFixture();
run('main.innerHTML=renderCandidateCard("mission-linked",candidateFixture,candidateAccess);');
assert.equal(doc.querySelector('[data-action=select-finalist]').disabled, true);
assert.equal(doc.querySelector('[data-action=shortlist]').disabled, true);
assert.equal(doc.querySelector('[data-action=open-mission-simulation]').dataset.teaserId, candidate.id);
assert.match(doc.querySelector('#main').textContent, /현재 수행자 후보/);
assert.match(doc.querySelector('#main').textContent, /이 후보로 가상 진행 시작/);
assert.match(doc.querySelector('#main').textContent, /실제 청구 및 송금 0원/);
run('main.innerHTML=renderCandidateCard("mission-linked",{...candidateFixture,id:"other-teaser",status:"SUBMITTED"},candidateAccess);');
assert.equal(doc.querySelector('[data-action=open-mission-simulation]'), null);
pass('only the current candidate offers linked VIRTUAL start while the real final-selection control remains disabled');

await run('openMissionSimulation("mission-linked","candidate-teaser")');
const startForm = doc.querySelector('#mission-simulation-start-form');
assert.ok(startForm.elements.consent.required);
assert.match(startForm.textContent, /후보선정과 별도로/);
await assert.rejects(run('runMissionSimulationAction("mission-linked","START",{teaserId:"candidate-teaser",consent:false},document.querySelector("#mission-simulation-start-form"))'), /동의/);
assert.equal(requests.length, 0);
startForm.elements.consent.checked = true;
expectedAction = { action: 'START', payload: { teaserId: candidate.id, consent: true }, result: linkedBase };
await run('handleForm(document.querySelector("#mission-simulation-start-form"))');
assert.equal(requests.length, 1);
assert.equal(requests[0].actorId, 'actual-owner');
assert.match(doc.querySelector('.mission-simulation-panel').textContent, /가상 최종 수행자가 확정/);
assert.ok(doc.querySelector('[data-step=PAY_APPROVE]'));
assert.equal(doc.querySelector('[data-step=BEGIN]'), null);
assert.equal(run('state.selectedChallenge.challenge.status'), 'SHORTLISTED');
pass('linked start requires explicit consent, creates its own final solver state and retains the original mission candidate status');

function expectStep(action, update, payload = {}) {
  expectedAction = { action, payload, result: { ...structuredClone(serverSimulation), ...update, revision: serverSimulation.revision + 1 } };
}
async function clickStep(action) {
  const button = doc.querySelector(`[data-action=mission-simulation-step][data-step=${action}]`);
  assert.ok(button, `the current account must see ${action}`);
  assert.equal(button.disabled, false);
  await run(`handleAction('mission-simulation-step',{challengeId:'mission-linked',step:${JSON.stringify(action)}},document.querySelector('[data-step=${action}]'))`);
  assert.equal(expectedAction, null, `the ${action} mock reply was consumed`);
}
function assertZeroMoney() {
  const panel = doc.querySelector('.mission-simulation-panel');
  assert.ok(panel);
  assert.match(panel.querySelector('.mission-simulation-zero').textContent, /VIRTUAL · 실제 청구 및 송금 0원/);
  assert.deepEqual([...panel.querySelectorAll('.mission-simulation-amounts strong')].map(element => element.textContent), ['100,000원', '10,000원', '90,000원', '0원']);
  assert.equal(panel.querySelector('[data-action=simulation-role]'), null);
  assert.equal(panel.querySelector('select[name=role]'), null);
  assert.equal(run('state.user.verification.identity'), false);
}
expectStep('PAY_FAIL', { paymentStatus: 'FAILED' });
await clickStep('PAY_FAIL');
assert.match(doc.querySelector('[data-step=PAY_APPROVE]').textContent, /재시도/);
expectStep('PAY_CANCEL', { paymentStatus: 'CANCELLED' });
await clickStep('PAY_CANCEL');
expectStep('PAY_APPROVE', { stage: 'EXECUTING', paymentStatus: 'APPROVED' });
await clickStep('PAY_APPROVE');
assert.equal(doc.querySelector('[data-step=BEGIN]'), null);
assert.match(doc.querySelector('.mission-simulation-panel').textContent, /선정 수행자의 시작을 기다리고/);
assertZeroMoney();
pass('the owner can record virtual payment failure, cancellation and approval with persistent 100000/10000/90000/actual-zero labels');

setActor('actual-solver');
await run('openMissionSimulation("mission-linked")');
assert.ok(doc.querySelector('[data-step=BEGIN]'));
assert.equal(doc.querySelector('[data-step=PAY_APPROVE]'), null);
assert.equal(doc.querySelector('[data-step=PAYOUT_SUCCESS]'), null);
expectStep('BEGIN', { executionStarted: true });
await clickStep('BEGIN');
assert.ok(doc.querySelector('[data-action=mission-simulation-proof]'));
assert.equal(requests.at(-1).actorId, 'actual-solver');
assertZeroMoney();
pass('a second signed-in account resumes the same linked record and only the designated solver receives begin and proof actions');

run('openMissionSimulationProof("mission-linked")');
let proofForm = doc.querySelector('#mission-simulation-proof-form');
const proofDescription = '성공조건 세 항목을 모두 확인했고 결과 문서와 비교 근거를 첨부합니다.';
proofForm.elements.description.value = proofDescription;
proofForm.elements.evidenceUrl.value = 'https://test.invalid/evidence';
proofForm.elements.description.dispatchEvent(new win.Event('input', { bubbles: true }));
const proofDraftKey = run('transientModalDraftKey(document.querySelector("#mission-simulation-proof-form"))');
assert.ok(win.sessionStorage.getItem(proofDraftKey));
await run('refreshMissionDetail()');
assert.equal(doc.querySelector('#mission-simulation-proof-form'), proofForm);
run('dismissModal();openMissionSimulationProof("mission-linked");');
proofForm = doc.querySelector('#mission-simulation-proof-form');
assert.equal(proofForm.elements.description.value, proofDescription);
assert.equal(proofForm.elements.evidenceUrl.value, 'https://test.invalid/evidence');
expectStep('SUBMIT_PROOF', { stage: 'PROOF_SUBMITTED', proof: { description: proofDescription, evidenceUrl: 'https://test.invalid/evidence', status: 'SUBMITTED' } }, { description: proofDescription, evidenceUrl: 'https://test.invalid/evidence' });
await run('handleForm(document.querySelector("#mission-simulation-proof-form"))');
assert.equal(expectedAction, null);
assert.equal(win.sessionStorage.getItem(proofDraftKey), null);
assert.match(doc.querySelector('.mission-simulation-proof').textContent, /성공조건 세 항목/);
assert.equal(doc.querySelector('[data-step=REVIEW_ACCEPT]'), null);
pass('solver proof text and HTTPS evidence survive polling and form reopening, then the consumed draft is cleared after server acceptance');

setActor('actual-owner');
await run('openMissionSimulation("mission-linked")');
assert.ok(doc.querySelector('[data-step=REVIEW_ACCEPT]'));
assert.ok(doc.querySelector('[data-action=mission-simulation-reject]'));
assert.equal(doc.querySelector('[data-action=mission-simulation-proof]'), null);
run('openMissionSimulationReject("mission-linked")');
const reason = '성공조건 세 번째 항목의 비교 근거를 보완해주세요.';
doc.querySelector('#mission-simulation-reject-form').elements.reason.value = reason;
doc.querySelector('#mission-simulation-reject-form').elements.reason.dispatchEvent(new win.Event('input', { bubbles: true }));
run('dismissModal();openMissionSimulationReject("mission-linked");');
assert.equal(doc.querySelector('#mission-simulation-reject-form').elements.reason.value, reason);
expectStep('REVIEW_REJECT', { stage: 'EXECUTING', reviewReason: reason, proof: { ...serverSimulation.proof, status: 'REJECTED' } }, { reason });
await run('handleForm(document.querySelector("#mission-simulation-reject-form"))');
assert.equal(expectedAction, null);
assert.match(doc.querySelector('.mission-simulation-panel').textContent, /세 번째 항목의 비교 근거를 보완/);
assert.equal(doc.querySelector('[data-step=PAYOUT_SUCCESS]'), null);
pass('only the owner can request specific proof corrections and that unsubmitted reason restores before review submission');

setActor('actual-solver');
await run('openMissionSimulation("mission-linked")');
run('openMissionSimulationProof("mission-linked")');
proofForm = doc.querySelector('#mission-simulation-proof-form');
assert.equal(proofForm.elements.description.value, '');
const revisedProof = proofDescription + ' 세 번째 항목 비교표와 근거를 추가했습니다.';
proofForm.elements.description.value = revisedProof;
expectStep('SUBMIT_PROOF', { stage: 'PROOF_SUBMITTED', reviewReason: '', proof: { description: revisedProof, evidenceUrl: '', status: 'SUBMITTED' } }, { description: revisedProof, evidenceUrl: '' });
await run('handleForm(document.querySelector("#mission-simulation-proof-form"))');
setActor('actual-owner');
await run('openMissionSimulation("mission-linked")');
expectStep('REVIEW_ACCEPT', { stage: 'SUCCESS', proof: { ...serverSimulation.proof, status: 'ACCEPTED' } });
await clickStep('REVIEW_ACCEPT');
expectStep('PAYOUT_FAIL', { payoutStatus: 'FAILED' });
await clickStep('PAYOUT_FAIL');
assert.match(doc.querySelector('[data-step=PAYOUT_SUCCESS]').textContent, /재시도/);
expectStep('PAYOUT_SUCCESS', { payoutStatus: 'PAID' });
await clickStep('PAYOUT_SUCCESS');
assert.match(doc.querySelector('.mission-simulation-panel h3').textContent, /가상 지급 완료/);
assert.equal(doc.querySelector('[data-step=PAYOUT_SUCCESS]'), null);
assertZeroMoney();
assert.equal(run('state.selectedChallenge.challenge.status'), 'SHORTLISTED');
assert.equal(run('state.selectedChallenge.challenge.fundingStatus'), 'POSTED');
pass('solver resubmission, owner acceptance and payout failure/retry end in virtual completion while real source status and zero charge remain explicit');

run('state.selectedChallenge=null;state.missionSimulationAccess=null;closeModal({preserveHistory:true});');
setActor('actual-solver');
await run('openMissionSimulation("mission-linked")');
assert.match(doc.querySelector('.mission-simulation-panel h3').textContent, /가상 지급 완료/);
assert.match(doc.querySelector('.mission-simulation-proof').textContent, /세 번째 항목 비교표/);
assert.equal(doc.querySelector('[data-action=mission-simulation-step]'), null);
assertZeroMoney();
pass('clearing local linked state and reopening restores the completed server fixture and proof for the other account');

const completedSimulation = structuredClone(serverSimulation);
setActor('actual-owner');
serverSimulation = { ...structuredClone(linkedBase), stage: 'EXECUTING', paymentStatus: 'APPROVED', revision: 3 };
await run('openMissionSimulation("mission-linked")');
expectStep('CANCEL', { stage: 'CANCELLED', paymentStatus: 'CANCELLED' });
await clickStep('CANCEL');
assert.match(doc.querySelector('.mission-simulation-panel').textContent, /실제 미션과 기존 티저는 보존/);
await run('openMissionSimulation("mission-linked","candidate-teaser")');
assert.ok(doc.querySelector('#mission-simulation-start-form'));
doc.querySelector('#mission-simulation-start-form').elements.consent.checked = true;
expectedAction = { action: 'START', payload: { teaserId: candidate.id, consent: true }, result: { ...structuredClone(linkedBase), id: 'linked-run-two' } };
await run('handleForm(document.querySelector("#mission-simulation-start-form"))');
assert.equal(run('state.selectedChallenge.context.missionSimulation.id'), 'linked-run-two');
assert.equal(run('state.selectedChallenge.challenge.status'), 'SHORTLISTED');
assertZeroMoney();
pass('owner cancellation retains the source mission and starting again requires fresh explicit consent for a new linked record');
serverSimulation = completedSimulation;
await run('openMissionSimulation("mission-linked")');

win.privateSimulation = structuredClone(serverSimulation);
for (const [id, admin] of [['unselected-candidate', false], ['unrelated-admin', true], [null, false]]) {
  setActor(id, admin);
  assert.equal(run('missionSimulationRole(privateSimulation)'), null);
  assert.equal(run('renderMissionSimulation(testDetail.challenge,privateSimulation)'), '');
  assert.throws(() => run('openMissionSimulationProof("mission-linked")'), /선정 수행자/);
  assert.throws(() => run('openMissionSimulationReject("mission-linked")'), /의뢰자/);
}
setActor('actual-owner');
assert.equal(run('renderMissionSimulation(testDetail.challenge,{...privateSimulation,actualCharge:100000})'), '');
assert.equal(run('renderMissionSimulation(testDetail.challenge,{...privateSimulation,mode:"LIVE"})'), '');
run('main.innerHTML=renderMissionSimulation(testDetail.challenge,{...privateSimulation,stage:"SUCCESS",payoutStatus:"NONE",active:false,blockedReason:"기존 가상 진행이 중단되었습니다"});');
assert.ok([...doc.querySelectorAll('[data-action=mission-simulation-step]:not([data-step=CANCEL])')].every(button => button.disabled));
pass('unselected candidates, anonymous users and unrelated administrators cannot inherit participant UI or relabel actual money as VIRTUAL');

win.emailBlockedSimulation = { ...structuredClone(linkedBase), active: false, blockedReason: 'EMAIL_REQUIRED' };
run('main.innerHTML=renderMissionSimulation(testDetail.challenge,emailBlockedSimulation);');
assert.equal(doc.querySelector('#main [data-step=CANCEL]').disabled, false);
for (const action of ['PAY_APPROVE', 'PAY_FAIL', 'PAY_CANCEL']) assert.equal(doc.querySelector(`#main [data-step=${action}]`).disabled, true);
assert.match(doc.querySelector('#main .workflow-blocked').textContent, /이메일 인증/);
assert.doesNotMatch(doc.querySelector('#main .mission-simulation-panel').textContent, /EMAIL_REQUIRED/);
setActor('actual-solver');
run('main.innerHTML=renderMissionSimulation(testDetail.challenge,emailBlockedSimulation);');
assert.equal(doc.querySelector('#main [data-step=CANCEL]'), null);
setActor('unrelated-admin', true);
run('main.innerHTML=renderMissionSimulation(testDetail.challenge,emailBlockedSimulation);');
assert.equal(doc.querySelector('#main [data-step=CANCEL]'), null);
assert.equal(doc.querySelector('#main .mission-simulation-panel'), null);
setActor('actual-owner');
pass('email-blocked inactive records retain owner cancellation recovery, disable payment actions and show Korean guidance without granting solver or admin cancellation');

run('main.innerHTML=renderMissionSimulation(testDetail.challenge,{...privateSimulation,proof:{description:"<script>unsafe()</script>",evidenceUrl:"javascript:unsafe()"},reviewReason:"<img src=x onerror=unsafe()>"});');
assert.equal(doc.querySelector('.mission-simulation-panel script'), null);
assert.equal(doc.querySelector('.mission-simulation-panel img'), null);
assert.equal(doc.querySelector('.mission-simulation-proof a'), null);
assert.match(doc.querySelector('.mission-simulation-proof').textContent, /<script>/);
pass('participant proof and rejection text are escaped and non-HTTPS evidence does not become an executable link');

run('clearTimeout(systemNoticeTimer);clearInterval(emailCountdownTimer);if(activityPollTimer)clearInterval(activityPollTimer);if(missionDetailPollTimer)clearInterval(missionDetailPollTimer);');
win.close();
console.log(`${passed} mission linked UI checks passed (mocked frontend only)`);
