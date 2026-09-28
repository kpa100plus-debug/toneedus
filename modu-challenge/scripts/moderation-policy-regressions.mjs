import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import worker from '../worker/index.mjs';

let checks = 0;
const pass = (name) => { checks++; console.log(`PASS moderation: ${name}`); };
const source = readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function assessChallengeModeration('), source.indexOf('function analyzeChallengeForModeration('));
const policy = vm.createContext({});
vm.runInContext(functions, policy);
const run = (code) => vm.runInContext(code, policy);
const mission = {
  title: '공원 안내판 디자인 제안', summary: '공원에서 사용할 안내판 디자인을 요청합니다.',
  description: '공원 안내 정보를 쉽게 읽을 수 있는 안내판 시안과 편집 가능한 원본 파일을 제출해주세요.',
  successCriteria: '안내판 시안 두 개와 최종 원본 파일 제출', paymentTrigger: '최종 원본 파일 확인 후 보상금 준비',
  evidenceRequirements: '시안 이미지와 원본 파일 제출', category: 'IDEA', region: '전국·온라인',
  deadline: '2099-01-01', visibility: 'public', rewardAmount: 100000,
};
policy.fixture = mission;
for (const [score, action] of [[0, 'AUTO_APPROVED'], [29, 'AUTO_APPROVED'], [30, 'CHANGES_REQUIRED'], [59, 'CHANGES_REQUIRED'], [60, 'AUTO_REJECTED'], [100, 'AUTO_REJECTED']]) {
  policy.score = score;
  const decision = run("addModerationFinding(assessChallengeModeration(fixture), {code:'BOUNDARY',label:'경계 검증',score,prohibited:false})");
  assert.equal(decision.riskScore, score); assert.equal(decision.action, action);
}
pass('0/29/30/59/60/100 thresholds match published policy');
assert.equal(run("addModerationFinding(assessChallengeModeration(fixture), {code:'PROHIBITED',label:'금지 항목',score:0,prohibited:true}).action"), 'AUTO_REJECTED');
pass('prohibited flag rejects independently of numeric score');
for (const rewardAmount of [10000, 500000, 3000000, 100000000]) {
  policy.amount = rewardAmount;
  assert.equal(run('assessChallengeModeration({...fixture,rewardAmount:amount}).riskScore'), 0);
  assert.equal(run("assessChallengeModeration({...fixture,rewardAmount:amount,description:'고객 연락처를 동의 절차와 함께 정리해주세요.'}).riskScore"), 40);
}
pass('amount cannot create or amplify a content risk finding');
for (const field of ['description', 'paymentTrigger', 'evidenceRequirements']) {
  policy.field = field;
  assert.equal(run("assessChallengeModeration({...fixture,[field]:'도박 사이트를 운영하는 업무'}).action"), 'AUTO_REJECTED');
}
assert.equal(run("assessChallengeModeration({...fixture,description:'업무용 DB 구조를 설계하고 DB 파일을 제공해주세요.'}).action"), 'AUTO_APPROVED');
assert.equal(run("assessChallengeModeration({...fixture,description:'동의 없는 고객 DB 판매를 진행합니다.'}).action"), 'AUTO_REJECTED');
pass('payment/evidence promises screened; ordinary database delivery is not personal-data trade');

const sql = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
  if (file.endsWith('.sql')) sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}
const DB = {
  prepare(query) { return {
    args: [], bind(...args) { this.args = args; return this; },
    async first() { return sql.prepare(query).get(...this.args) || null; },
    async all() { return { results: sql.prepare(query).all(...this.args) }; },
    async run() {
      if (/\bRETURNING\b/i.test(query)) return { results: sql.prepare(query).all(...this.args), meta: { changes: Number(sql.prepare('SELECT changes() n').get().n) } };
      if (/^\s*SELECT/i.test(query)) return this.all();
      const result = sql.prepare(query).run(...this.args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  }; },
  async batch(statements) {
    sql.exec('BEGIN');
    try { const output = []; for (const statement of statements) output.push(await statement.run()); sql.exec('COMMIT'); return output; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  },
};
const env = { DB, APP_ENV: 'test', PUBLIC_MONEY_ENABLED: 'false', LOCAL_MONEY_SIMULATION: 'false', VERIFICATION_ENFORCEMENT: 'advisory' };
async function req(path, body, cookie = '', method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const response = await worker.fetch(new Request(`https://test.invalid${path}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': crypto.randomUUID(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {} });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
const common = { realName: '검증용 회원', region: '서울', birthYear: 1980, gender: 'female', termsAccepted: true, privacyAccepted: true,
  passwordSalt: Buffer.alloc(16, 1).toString('base64'), passwordVerifier: Buffer.alloc(32, 2).toString('base64') };
const owner = await req('/api/auth/signup', { ...common, displayName: '검수회귀회원', email: 'moderation@test.invalid', phone: '01000003001' });
const pendingOwner = await req('/api/auth/signup', { ...common, displayName: '검수대기회원', email: 'pending@test.invalid', phone: '01000003002' });
assert.equal(owner.status, 201); assert.equal(pendingOwner.status, 201);
sql.prepare('UPDATE users SET email_verified=1, trust_score=73 WHERE id=?').run(owner.body.user.id);
sql.prepare('UPDATE users SET trust_score=61 WHERE id=?').run(pendingOwner.body.user.id);
const trustBefore = sql.prepare('SELECT id,trust_score FROM users ORDER BY id').all();

const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External analysis service unavailable'); };
const high = await req('/api/challenges', { ...mission, rewardAmount: 100000000 }, owner.cookie, 'POST', { 'Idempotency-Key': 'moderation-public-replay-001' });
globalThis.fetch = fetchBefore;
assert.equal(high.status, 201, JSON.stringify(high.body)); assert.equal(high.body.moderationAction, 'AUTO_APPROVED');
assert.equal(sql.prepare('SELECT moderation_risk_score FROM challenges WHERE id=?').get(high.body.challenge.id).moderation_risk_score, 0); assert.equal((await req(`/api/challenges/${high.body.challenge.id}`)).status, 200);
pass('safe maximum reward publishes through the API when external services are unavailable');

for (const amount of [100000001, 100000000.5, 9999]) {
  const invalid = await req('/api/challenges', { ...mission, rewardAmount: amount }, owner.cookie);
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_REWARD');
}
pass('server rejects amounts above 100 million, fractional amounts and amounts below the minimum');
const duplicate = await req('/api/challenges', mission, owner.cookie);
assert.deepEqual(duplicate.body.existingMission, {id:high.body.challenge.id,title:mission.title});
const savedDuplicate = await req(`/api/challenges/${duplicate.body.challenge.id}?refresh=1`, undefined, owner.cookie);
assert.deepEqual(savedDuplicate.body.context.existingMission, duplicate.body.existingMission);
assert.equal((await req(`/api/challenges/${duplicate.body.challenge.id}`, undefined, pendingOwner.cookie)).status, 404);
assert.equal((await req(`/api/challenges/${high.body.challenge.id}`, undefined, pendingOwner.cookie)).body.context.existingMission, null);
pass('duplicate recovery points to the exact original for its owner without exposing private copies to another member');
assert.equal(duplicate.body.moderationAction, 'CHANGES_REQUIRED'); assert.equal(duplicate.body.challenge.publicationVisibility, 'private');
assert.equal((await req(`/api/challenges/${duplicate.body.challenge.id}`)).status, 404);
assert.ok(duplicate.body.moderationGuidance.some((item) => /기존 미션을 수정/.test(item.message)));
const originalEdit = await req(`/api/challenges/${high.body.challenge.id}`, mission, owner.cookie, 'PUT');
assert.equal(originalEdit.status, 200);
assert.equal(originalEdit.body.moderationAction, 'AUTO_APPROVED');
assert.equal(originalEdit.body.challenge.publicationVisibility, 'public');
pass('self-edit excludes the current row and a blocked private copy cannot demote its published original');
const edited = await req(`/api/challenges/${duplicate.body.challenge.id}`, { ...mission, title: '박물관 전시 안내 책자 제작' }, owner.cookie, 'PUT');
assert.equal(edited.body.moderationAction, 'AUTO_APPROVED'); assert.equal(edited.body.challenge.id, duplicate.body.challenge.id);
assert.equal((await req(`/api/challenges/${duplicate.body.challenge.id}`)).status, 200);
pass('duplicate stays private, and a substantive correction immediately republishes the preserved record');

for (const [field, value] of [
  ['title', '부산 공원 안내판 디자인 제안'],
  ['summary', '이 미션에서는 공원의 입구 위치를 안내할 별도 안내판을 요청합니다.'],
  ['description', '출입구 전용 안내판을 설계하고 휠체어 접근 경로를 표시한 원본을 납품해주세요.'],
  ['successCriteria', '대형 안내판 다섯 개의 원본과 최종 인쇄 규격을 제출해주세요.'],
  ['paymentTrigger', '최종 시안 검토와 수행계획을 확인한 뒤 보상금 준비를 진행합니다.'],
  ['evidenceRequirements', '실제 설치위치를 표시한 도면과 현장사진 제출'],
  ['category', 'PUBLIC'], ['region', '부산'],
]) {
  const distinct = await req('/api/challenges', { ...mission, [field]: value }, owner.cookie);
  assert.equal(distinct.status, 201, JSON.stringify(distinct.body));
  assert.equal(distinct.body.moderationAction, 'AUTO_APPROVED', `distinct ${field} must not be blocked by the title`);
}
pass('title prefix, substantive fields, category and region distinguish different missions in real create requests');

const recoveryInput = { ...mission, description: '같은 제목을 사용하지만 이번 의뢰는 공원 동쪽 입구의 점자 안내판 세 개를 설계하는 별도 작업입니다.' };
enqueue('legacy-title-only', owner.body.user.id, recoveryInput.title);
sql.prepare(`UPDATE challenges SET description=?,status='DRAFT',moderation_action='CHANGES_REQUIRED',moderation_risk_score=30,
  moderation_policy_version='2026-09-27-v3',moderation_reasons_json=? WHERE id='legacy-title-only'`)
  .run(recoveryInput.description, JSON.stringify([{ code: 'POSSIBLE_DUPLICATE', label: '동일·유사 미션 중복 등록 가능성', score: 30 }]));
const legacyBefore = await req('/api/challenges/legacy-title-only', undefined, owner.cookie);
assert.match(legacyBefore.body.challenge.moderationReasons[0].message, /이전 중복검수 기준/);
assert.doesNotMatch(legacyBefore.body.challenge.moderationReasons[0].message, /내용과 조건이 같은 진행 중/);
assert.equal(sql.prepare("SELECT moderation_risk_score FROM challenges WHERE id='legacy-title-only'").get().moderation_risk_score, 30);
const legacyRecovered = await req('/api/challenges/legacy-title-only', recoveryInput, owner.cookie, 'PUT');
assert.equal(legacyRecovered.body.challenge.id, 'legacy-title-only');
assert.equal(legacyRecovered.body.moderationAction, 'AUTO_APPROVED');
assert.equal(legacyRecovered.body.challenge.publicationVisibility, 'public');
assert.equal(sql.prepare("SELECT moderation_policy_version FROM challenges WHERE id='legacy-title-only'").get().moderation_policy_version, '2026-09-27-v4');
pass('legacy title-only rejection is explained truthfully, preserved on read and reopened on explicit resave using the same mission ID');

const lifecycleInput = { ...mission, title: 'ABC 안내판 제작 범위 검사' };
enqueue('lifecycle-probe', owner.body.user.id, lifecycleInput.title);
policy.env = env; policy.ownerId = owner.body.user.id; policy.lifecycleInput = lifecycleInput;
for (const [status, visibility, expected] of [
  ['DRAFT', 'private', false], ['DRAFT', 'public', false], ['OPEN', 'private', false],
  ['SUCCESS', 'public', false], ['FAILED', 'public', false], ['CANCELLED', 'public', false],
  ['OPEN', 'public', true], ['OPEN', 'unlisted', true], ['EXECUTING', 'public', true],
]) {
  sql.prepare("UPDATE challenges SET status=?,visibility=? WHERE id='lifecycle-probe'").run(status, visibility);
  const decision = await run('evaluateChallengeModeration(lifecycleInput,ownerId,null,env)');
  assert.equal(decision.reasons.some((reason) => reason.code === 'POSSIBLE_DUPLICATE'), expected, `${status}/${visibility}`);
}
assert.equal((await run("evaluateChallengeModeration(lifecycleInput,ownerId,'lifecycle-probe',env)")).action, 'AUTO_APPROVED');
sql.prepare("UPDATE challenges SET owner_id=? WHERE id='lifecycle-probe'").run(pendingOwner.body.user.id);
assert.equal((await run('evaluateChallengeModeration(lifecycleInput,ownerId,null,env)')).action, 'AUTO_APPROVED');
sql.prepare("UPDATE challenges SET owner_id=? WHERE id='lifecycle-probe'").run(owner.body.user.id);
const changedCommercialTerms = await run("evaluateChallengeModeration({...lifecycleInput,title:'ＡＢＣ 안내판 제작 범위 검사',rewardAmount:90000000,deadline:'2099-12-31'},ownerId,null,env)");
assert.equal(changedCommercialTerms.action, 'CHANGES_REQUIRED');
sql.prepare("UPDATE challenges SET title='앱 테스트' WHERE id='lifecycle-probe'").run();
assert.equal((await run("evaluateChallengeModeration({...lifecycleInput,title:'앱 테스트'},ownerId,null,env)")).action, 'CHANGES_REQUIRED');
sql.prepare("UPDATE challenges SET status='CANCELLED' WHERE id='lifecycle-probe'").run();
pass('only same-owner active public/link missions can collide; historical/private/self rows are ignored while formatting, reward and date changes cannot bypass exact-content duplicate detection');

const medium = await req('/api/challenges', { ...mission, title: '고객 연락처 정리 업무 요청', description: '고객 연락처를 동의 절차와 함께 정리하고 결과 문서를 작성해주세요.', rewardAmount: 100000000 }, owner.cookie);
assert.equal(medium.body.moderationAction, 'CHANGES_REQUIRED'); assert.equal(sql.prepare('SELECT moderation_risk_score FROM challenges WHERE id=?').get(medium.body.challenge.id).moderation_risk_score, 40);
const prohibited = await req('/api/challenges', { ...mission, title: '작업 원본파일 전달 업무', evidenceRequirements: '가짜 계정으로 허위 리뷰 증빙 제출' }, owner.cookie);
assert.equal(prohibited.body.moderationAction, 'AUTO_REJECTED'); assert.equal(prohibited.body.challenge.publicationVisibility, 'private');
pass('high value cannot escalate medium risk into rejection; prohibited evidence instructions are blocked');

const internalFixture = JSON.stringify([{ code: 'AMBIGUOUS_SUCCESS', label: '성공조건을 확인해주세요', score: 30, prohibited: false, rawEvidence: 'PRIVATE_MODERATION_EVIDENCE', sourceText: 'PRIVATE_MODERATION_SOURCE' }]);
sql.prepare('UPDATE challenges SET moderation_reasons_json=? WHERE id=?').run(internalFixture, high.body.challenge.id);
const replay = await req('/api/challenges', mission, owner.cookie, 'POST', { 'Idempotency-Key': 'moderation-public-replay-001' });
assert.equal(replay.body.duplicatePrevented, true); assert.equal(replay.body.challenge.id, high.body.challenge.id);
const forbiddenKeys = new Set(['moderationRiskScore', 'moderationPolicyVersion', 'policyVersion', 'riskScore', 'score', 'code', 'prohibited', 'rawEvidence', 'sourceText']);
function assertPublicModeration(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, `private moderation key leaked: ${key}`);
    assertPublicModeration(nested);
  }
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_MODERATION_EVIDENCE|PRIVATE_MODERATION_SOURCE/);
}
for (const response of [high, duplicate, edited, medium, prohibited, replay,
  await req(`/api/challenges/${high.body.challenge.id}`),
  await req(`/api/challenges/${medium.body.challenge.id}`, undefined, owner.cookie),
  await req('/api/challenges'), await req('/api/bootstrap')]) {
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.body));
  assertPublicModeration(response.body);
}
assert.match(replay.body.moderationReasons[0].message, /확인 가능한 기준/);
assert.ok(medium.body.moderationReasons.every((reason) => typeof reason.label === 'string' && typeof reason.message === 'string'));
const storedAudit = sql.prepare("SELECT after_json FROM audit_logs WHERE resource_id=? AND action='CHALLENGE_MODERATION_CHANGES_REQUIRED'").get(medium.body.challenge.id);
assert.equal(JSON.parse(storedAudit.after_json).moderationRiskScore, 40);
assert.ok(JSON.parse(storedAudit.after_json).moderationReasons.some((reason) => reason.code === 'PERSONAL_INFORMATION'));
pass('create/edit/replay/detail/list/bootstrap expose helpful explanations without private scores, policy, detection codes or raw evidence; audit retains full detail');

sql.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(owner.body.user.id);
sql.prepare("INSERT INTO admin_roles(user_id,role) VALUES (?,'primary')").run(owner.body.user.id);
const appeal = await req(`/api/challenges/${prohibited.body.challenge.id}/moderation/appeals`, { reason: '검수 사유를 다시 확인하고 제출한 자료의 합법성과 안전 근거를 검토해주세요.' }, owner.cookie);
assert.equal(appeal.status, 201);
assert.equal((await req('/api/admin/moderation-queue')).status, 401);
assert.equal((await req('/api/admin/moderation-queue', undefined, pendingOwner.cookie)).status, 403);
const adminQueue = await req('/api/admin/moderation-queue', undefined, owner.cookie);
assert.equal(adminQueue.status, 200);
const internalReview = adminQueue.body.challenges.find((item) => item.id === prohibited.body.challenge.id);
assert.equal(internalReview.moderation_risk_score, 100);
assert.equal(internalReview.moderation_policy_version, '2026-09-27-v4');
assert.ok(internalReview.moderationReasons.some((reason) => reason.code === 'DECEPTION_PHISHING' && reason.prohibited));
pass('only authorized administrator review retains risk, policy and detection evidence');
const detailPath = `/api/admin/challenges/${prohibited.body.challenge.id}/moderation`;
assert.equal((await req(detailPath)).status, 401);
assert.equal((await req(detailPath, undefined, pendingOwner.cookie)).status, 403);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='ADMIN_MODERATION_DETAIL_VIEW'").get().n, 0);
const internalDetail = await req(detailPath, undefined, owner.cookie);
assert.equal(internalDetail.status, 200);
assert.equal(internalDetail.body.moderation.riskScore, 100);
assert.equal(internalDetail.body.moderation.policyVersion, '2026-09-27-v4');
assert.equal(internalDetail.body.moderation.action, 'AUTO_REJECTED');
assert.ok(internalDetail.body.moderation.reasons.some((reason) => reason.code === 'DECEPTION_PHISHING'));
assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='ADMIN_MODERATION_DETAIL_VIEW' AND resource_id=? AND actor_id=?").get(prohibited.body.challenge.id, owner.body.user.id).n, 1);
assert.equal((await req('/api/admin/challenges/missing-mission/moderation', undefined, owner.cookie)).status, 404);
sql.prepare("UPDATE challenges SET moderation_reasons_json='invalid-json', moderation_policy_version='' WHERE id=?").run(prohibited.body.challenge.id);
const unavailableDetail = await req(detailPath, undefined, owner.cookie);
assert.equal(unavailableDetail.body.moderation.policyVersion, null);
assert.equal(unavailableDetail.body.moderation.reasons, null);
pass('on-demand admin detail is authorized, access-audited and preserves unavailable stored values as null');
function enqueue(id, ownerId, title) {
  sql.prepare(`INSERT INTO challenges (id,owner_id,title,summary,description,category,region,reward_amount,fee_rate,success_criteria,payment_trigger,evidence_requirements,deadline,status,funding_status,visibility,submitted_visibility,moderation_decision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'REVIEW','POSTED','private','public','ADMIN_REVIEW')`)
    .run(id, ownerId, title, mission.summary, mission.description, mission.category, mission.region, 100000000, .1, mission.successCriteria, mission.paymentTrigger, mission.evidenceRequirements, mission.deadline);
}
enqueue('cron-duplicate', owner.body.user.id, mission.title);
enqueue('cron-safe', owner.body.user.id, '공공 정원 식물 이름표 제작');
enqueue('cron-email', pendingOwner.body.user.id, '주민센터 안내문 표지 디자인');
enqueue('cron-category', owner.body.user.id, mission.title);
sql.prepare("UPDATE challenges SET category='LOCAL' WHERE id='cron-category'").run();
enqueue('cron-region', owner.body.user.id, mission.title);
sql.prepare("UPDATE challenges SET region='대전' WHERE id='cron-region'").run();
const reviewed = await req('/api/admin/moderation/auto-review', {}, owner.cookie);
assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body)); assert.equal(reviewed.body.autoApproved, 3); assert.equal(reviewed.body.changesRequired, 2);
const result = (id) => sql.prepare('SELECT * FROM challenges WHERE id=?').get(id);
assert.equal(result('cron-duplicate').moderation_action, 'CHANGES_REQUIRED');
assert.equal(result('cron-duplicate').visibility, 'private');
assert.ok(JSON.parse(result('cron-duplicate').moderation_reasons_json).some((item) => item.code === 'POSSIBLE_DUPLICATE'));
assert.equal(result('cron-safe').moderation_action, 'AUTO_APPROVED'); assert.equal(result('cron-safe').moderation_risk_score, 0);
assert.equal(result('cron-category').moderation_action, 'AUTO_APPROVED');
assert.equal(result('cron-region').moderation_action, 'AUTO_APPROVED');
assert.equal(result('cron-email').status, 'DRAFT'); assert.equal(result('cron-email').visibility, 'private');
assert.ok(JSON.parse(result('cron-email').moderation_guidance_json).some((item) => /이메일 인증/.test(item.message)));
const auditCount = sql.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'CHALLENGE_MODERATION_%'").get().n;
assert.equal((await req('/api/admin/moderation/auto-review', {}, owner.cookie)).body.checked, 0);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'CHALLENGE_MODERATION_%'").get().n, auditCount);
pass('Cron uses matching content/duplicate policy, enforces email, and does not repeat decisions');

assert.deepEqual(sql.prepare('SELECT id,trust_score FROM users ORDER BY id').all(), trustBefore);
assert.equal(sql.prepare('SELECT COUNT(*) n FROM challenges').get().n, 19);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM trust_policy_items WHERE weight IS NOT NULL").get().n, 0);
assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []);
assert.equal(sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
pass('all mission records and legacy TRUST values survive; new trust weights remain unset');
sql.close();
console.log(`${checks} moderation policy checks passed`);
