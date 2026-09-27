import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../worker/index.mjs';

// Independent API-level fixture: authenticated members use the production
// configuration with no identity/payment credentials. No external transport.
const sql = new DatabaseSync(':memory:');
for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
  if (name.endsWith('.sql')) sql.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
}
const DB = {
  prepare(query) {
    return {
      args: [], bind(...args) { this.args = args; return this; },
      async first() { return sql.prepare(query).get(...this.args) || null; },
      async all() { return { results: sql.prepare(query).all(...this.args) }; },
      execute() {
        const statement = sql.prepare(query);
        if (statement.columns().length) {
          const results = statement.all(...this.args);
          return { results, meta: { changes: Number(sql.prepare('SELECT changes() n').get().n) } };
        }
        return { meta: { changes: Number(statement.run(...this.args).changes) } };
      },
      async run() { return this.execute(); },
    };
  },
  async batch(statements) {
    sql.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  },
};
const env = { DB, APP_ENV: 'production', PUBLIC_MONEY_ENABLED: 'false' };
const ids = { owner: 'mission_owner', solver: 'mission_solver', outsider: 'mission_outsider', admin: 'mission_admin' };
for (const [role, id] of Object.entries(ids)) {
  sql.prepare('INSERT INTO users(id,email,password_hash,password_salt,display_name,email_verified,trust_score,bounty_limit,is_admin) VALUES(?,?,?,?,?,1,73,100000000,?)')
    .run(id, id + '@test.invalid', 'fixture', 'fixture', '검수회원 ' + role, role === 'admin' ? 1 : 0);
  sql.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)')
    .run('session_' + id, id, createHash('sha256').update(id).digest('hex'), '2099-01-01T00:00:00Z');
  if (role === 'admin') sql.prepare("INSERT INTO admin_roles(user_id,role,appointed_by) VALUES(?,'primary',?)").run(id, id);
}
let serial = 0, passes = 0, transportCalls = 0;
const key = () => 'mission_sim_security_' + ++serial;
const pass = message => { passes++; console.log('PASS mission simulation security: ' + message); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { transportCalls++; throw new Error('External transport must not be used'); };
async function request(path, body, role = 'owner', extra = {}) {
  const reply = await worker.fetch(new Request('https://test.invalid' + path, {
    method: extra.method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.91', Cookie: role ? 'mc_session=' + ids[role] : '', ...extra.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {} });
  return { status: reply.status, body: await reply.json(), headers: reply.headers };
}
function seedMission() {
  const missionId = key(), teaserId = key(), otherTeaserId = key();
  sql.prepare(`INSERT INTO challenges(id,owner_id,title,summary,description,category,reward_amount,success_criteria,payment_trigger,evidence_requirements,deadline,status,funding_status,shortlisted_count,teaser_count,participant_count)
    VALUES(?,?,'실제 미션 연결 가상검수','실제 계정 두 명의 거래 흐름 검수','의뢰자와 선정 수행자 계정으로 결과물을 검수합니다.','IDEA',10000000,'원본 파일과 검수 자료 제출','선정 후 보상금 준비','최종 결과 파일 제출','2099-01-01','SHORTLISTED','POSTED',1,2,2)`)
    .run(missionId, ids.owner);
  for (const [id, user, status] of [[teaserId, ids.solver, 'SHORTLISTED'], [otherTeaserId, ids.outsider, 'SUBMITTED']]) {
    sql.prepare('INSERT INTO teasers(id,challenge_id,solver_id,headline,capability,approach,expected_days,status) VALUES(?,?,?,?,?,?,3,?)')
      .run(id, missionId, user, '결과물 제작 제안', '의뢰 내용을 확인하고 결과물을 제작합니다.', '초안을 검토한 뒤 최종 결과물을 전달합니다.', status);
  }
  return { missionId, teaserId, otherTeaserId, path: '/api/challenges/' + missionId + '/mission-simulation' };
}
const protectedTables = ['users', 'challenges', 'teasers', 'challenge_events', 'member_verifications', 'verified_identities', 'payout_sellers', 'settlements', 'proofs', 'reviews', 'strikes', 'disputes', 'notifications', 'transaction_orders', 'transaction_events', 'transaction_ledger', 'transaction_refund_receipts', 'provider_operations', 'payment_simulations'];
const snapshot = () => JSON.stringify(protectedTables.map(table => [table, sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

function status(response, expected) {
  assert.equal(response.status, expected, JSON.stringify(response.body));
  assert.match(response.headers.get('cache-control') || '', /(?:^|,\s*)no-store(?:,|$)/);
  return response.body;
}
const startBody = mission => ({ action: 'START', teaserId: mission.teaserId, requestId: key(), consent: true });
const savedCount = () => sql.prepare('SELECT COUNT(*) n FROM mission_simulation_events').get().n;
const description = '실제 의뢰 내용에 따른 최종 결과물과 검수 자료를 제작하여 가상 결과로 제출합니다.';
let current;
async function action(mission, name, role, fields = {}) {
  const body = { action: name, requestId: key(), revision: current.revision, ...fields };
  const response = await request(mission.path, body, role);
  if (response.status === 200) current = response.body.simulation;
  return { response, body };
}

try {
  const mission = seedMission(), preserved = snapshot();
  for (const role of [null, 'outsider', 'admin']) {
    status(await request(mission.path, undefined, role), role ? 403 : 401);
    status(await request(mission.path, startBody(mission), role), role ? 403 : 401);
  }
  const ownerContext = status(await request(mission.path), 200);
  assert.equal(ownerContext.canStart, true);
  assert.equal(ownerContext.candidateTeaserId, mission.teaserId);
  assert.equal(status(await request(mission.path, undefined, 'solver'), 200).canStart, false);
  status(await request(mission.path, startBody(mission), 'solver'), 403);
  pass('authenticated owner/candidate access; anonymous, outsider and nonparty administrator denied');

  status(await request(mission.path, startBody(mission), 'owner', { headers: { Origin: 'https://attacker.invalid' } }), 403);
  status(await request(mission.path, { ...startBody(mission), consent: false }), 400);
  status(await request(mission.path, { ...startBody(mission), teaserId: mission.otherTeaserId }), 409);
  status(await request(mission.path, { ...startBody(mission), role: 'owner' }), 400);
  sql.prepare('UPDATE users SET email_verified=0 WHERE id=?').run(ids.solver);
  status(await request(mission.path, startBody(mission)), 409);
  sql.prepare("UPDATE users SET email_verified=1,status='suspended' WHERE id=?").run(ids.solver);
  status(await request(mission.path, startBody(mission)), 409);
  sql.prepare("UPDATE users SET status='active' WHERE id=?").run(ids.solver);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM mission_simulations').get().n, 0);
  pass('CSRF, explicit simulation consent, current candidate and active/email-verified participants enforced before START');

  const initial = { ...startBody(mission), rewardAmount: 1, platformFee: 0, solverPayout: 999999999 };
  current = status(await request(mission.path, initial), 201).simulation;
  assert.equal(current.rewardAmount, 10000000);
  assert.equal(current.platformFee, 1000000);
  assert.equal(current.solverPayout, 9000000);
  assert.equal(current.mode, 'MISSION_SIMULATION');
  assert.equal(current.actualCharge, 0);
  assert.equal(current.stage, 'FUNDING_REQUIRED');
  assert.equal(current.ownerId, ids.owner);
  assert.equal(current.solverId, ids.solver);
  assert.equal(status(await request(mission.path, initial), 200).simulation.id, current.id);
  status(await request(mission.path, { ...initial, teaserId: mission.otherTeaserId }), 409);
  status(await request(mission.path, startBody(mission)), 409);
  assert.equal(savedCount(), 1);
  pass('10,000,000 KRW source amount and 10%/90% split are server-derived; START is idempotent and one active attempt is enforced');

  for (const role of ['outsider', 'admin']) {
    status(await request(mission.path, undefined, role), 403);
    status(await request(mission.path, { action: 'PAY_APPROVE', requestId: key(), revision: current.revision }, role), 403);
  }
  for (const name of ['PAY_APPROVE', 'REVIEW_ACCEPT', 'PAYOUT_SUCCESS']) status((await action(mission, name, 'solver')).response, 403);
  for (const name of ['BEGIN', 'SUBMIT_PROOF']) status((await action(mission, name, 'owner', { description })).response, 403);
  status((await action(mission, 'PAY_APPROVE', 'solver', { actorId: ids.owner })).response, 400);
  status((await action(mission, 'BEGIN', 'solver')).response, 409);
  pass('real session determines role; solver cannot fund/review/pay out, owner cannot perform/submit, spoofed role and out-of-order actions denied');

  status((await action(mission, 'PAY_FAIL', 'owner')).response, 200);
  assert.equal(current.paymentStatus, 'FAILED');
  status((await action(mission, 'PAY_CANCEL', 'owner')).response, 200);
  const funding = await action(mission, 'PAY_APPROVE', 'owner');
  status(funding.response, 200);
  const fundedCount = savedCount();
  status(await request(mission.path, funding.body, 'solver'), 403);
  status(await request(mission.path, funding.body), 200);
  assert.equal(savedCount(), fundedCount);
  assert.equal(current.stage, 'EXECUTING');
  assert.equal(current.paymentStatus, 'APPROVED');
  assert.equal(current.transactions.filter(item => item.kind === 'PAYMENT' && item.status === 'APPROVED').length, 1);
  pass('virtual payment failure/cancel/retry works; cross-actor replay denied and owner retry creates no duplicate payment or audit event');

  status((await action(mission, 'BEGIN', 'solver')).response, 200);
  const ownerActivity = status(await request('/api/me/activity'), 200);
  const solverActivity = status(await request('/api/me/activity', undefined, 'solver'), 200);
  assert.equal(ownerActivity.ownedChallenges.find(item => item.id === mission.missionId).missionSimulation.executionStarted, true);
  assert.equal(solverActivity.applications.find(item => item.challenge.id === mission.missionId).challenge.missionSimulation.executionStarted, true);
  const outsiderActivity = status(await request('/api/me/activity', undefined, 'outsider'), 200);
  assert.equal(outsiderActivity.applications.find(item => item.challenge.id === mission.missionId).challenge.missionSimulation, undefined);
  status((await action(mission, 'SUBMIT_PROOF', 'solver', { description: '짧음' })).response, 400);
  for (const evidenceUrl of ['javascript:alert(1)', 'http://test.invalid/proof', 'https://name:secret@test.invalid/proof']) {
    status((await action(mission, 'SUBMIT_PROOF', 'solver', { description, evidenceUrl })).response, 400);
  }
  const proof = await action(mission, 'SUBMIT_PROOF', 'solver', { description, evidenceUrl: 'https://test.invalid/private-proof' });
  status(proof.response, 200);
  assert.equal(current.stage, 'PROOF_SUBMITTED');
  const proofCount = savedCount();
  status(await request(mission.path, proof.body, 'solver'), 200);
  status(await request(mission.path, { ...proof.body, description: description + ' 다른 결과' }, 'solver'), 409);
  assert.equal(savedCount(), proofCount);
  for (const role of [null, 'outsider', 'admin']) {
    const detail = status(await request('/api/challenges/' + mission.missionId + '?refresh=1', undefined, role), 200);
    assert.ok(!JSON.stringify(detail).includes(current.proof.id));
    assert.ok(!JSON.stringify(detail).includes('private-proof'));
  }
  assert.ok(JSON.stringify(status(await request('/api/challenges/' + mission.missionId + '?refresh=1', undefined, 'solver'), 200)).includes(current.proof.id));
  pass('proof validates text/HTTPS, request fingerprint prevents changed replay, and private linked proof is visible only to the two parties');

  status((await action(mission, 'REVIEW_REJECT', 'owner', { reason: '짧음' })).response, 400);
  status((await action(mission, 'REVIEW_REJECT', 'owner', { reason: '최종 파일의 검수 자료를 추가해주세요.' })).response, 200);
  assert.equal(current.stage, 'EXECUTING');
  assert.equal(current.proofHistory.length, 1);
  assert.equal(current.proofHistory[0].status, 'REJECTED');
  status((await action(mission, 'SUBMIT_PROOF', 'solver', { description: description + ' 검수 의견을 반영했습니다.' })).response, 200);
  status((await action(mission, 'REVIEW_ACCEPT', 'owner')).response, 200);
  assert.equal(current.stage, 'SUCCESS');
  assert.equal(current.proof.status, 'ACCEPTED');
  assert.equal(current.proofHistory.length, 2);
  status((await action(mission, 'PAYOUT_FAIL', 'owner')).response, 200);
  const payout = await action(mission, 'PAYOUT_SUCCESS', 'owner');
  status(payout.response, 200);
  assert.equal(current.payoutStatus, 'PAID');
  assert.equal(current.transactions.filter(item => item.kind === 'PAYOUT' && item.status === 'PAID').length, 1);
  assert.equal(current.transactions.find(item => item.kind === 'PAYOUT' && item.status === 'PAID').amount, 9000000);
  assert.ok(current.transactions.every(item => item.mode === 'MISSION_SIMULATION' && item.actualCharge === 0));
  const paidCount = savedCount();
  status(await request(mission.path, payout.body), 200);
  status((await action(mission, 'PAYOUT_SUCCESS', 'owner')).response, 409);
  status((await action(mission, 'CANCEL', 'owner')).response, 409);
  status(await request(mission.path, startBody(mission)), 409);
  assert.equal(savedCount(), paidCount);
  const solverFinal = status(await request(mission.path, undefined, 'solver'), 200).simulation;
  assert.equal(solverFinal.payoutStatus, 'PAID');
  assert.equal(solverFinal.revision, current.revision);
  pass('two member sessions complete review rejection/resubmission/acceptance and virtual 9,000,000 KRW payout; terminal retries cannot duplicate or restart');

  assert.equal(snapshot(), preserved);
  const scheduled = [];
  await worker.scheduled({}, env, { waitUntil(promise) { scheduled.push(promise); } });
  await Promise.all(scheduled);
  assert.equal(snapshot(), preserved);
  assert.equal(transportCalls, 0);
  for (const path of ['funding/request', 'funding/confirm', 'success']) {
    assert.equal(status(await request('/api/challenges/' + mission.missionId + '/' + path, {}), 503).error.code, 'MONEY_FLOW_DISABLED');
  }
  const health = status(await request('/api/health'), 200);
  assert.equal(health.moneyEnabled, false);
  assert.equal(health.moneyMode, 'disabled');
  assert.equal(snapshot(), preserved);
  pass('source mission, real proof/settlement/TRUST/Strike/identity tables stay byte-for-byte unchanged; Cron has no penalty and live money stays disabled with zero transport calls');

  sql.prepare("UPDATE challenges SET selected_solver_id=?,status='EXECUTING',funding_status='FUNDED' WHERE id=?").run(ids.solver, mission.missionId);
  sql.prepare("UPDATE teasers SET status='SELECTED' WHERE id=?").run(mission.teaserId);
  const archived = status(await request(mission.path), 200);
  assert.equal(archived.simulation.active, false);
  assert.equal(archived.simulation.blockedReason, 'MISSION_CHANGED');
  assert.equal(archived.simulation.payoutStatus, 'PAID');
  assert.equal(archived.canStart, false);
  status(await request(mission.path, startBody(mission)), 409);
  pass('finished virtual payout releases source lifecycle locks; later actual progress marks the virtual record inactive without deleting history or allowing restart');

  const race = seedMission(), starters = [startBody(race), startBody(race)];
  const starts = await Promise.all(starters.map(body => request(race.path, body)));
  assert.deepEqual(starts.map(reply => reply.status).sort(), [201, 409]);
  current = starts.find(reply => reply.status === 201).body.simulation;
  const sameRevision = current.revision;
  const conflicting = await Promise.all(['PAY_APPROVE', 'PAY_FAIL'].map(name => request(race.path, { action: name, requestId: key(), revision: sameRevision })));
  assert.deepEqual(conflicting.map(reply => reply.status).sort(), [200, 409]);
  current = status(await request(race.path), 200).simulation;
  assert.equal(current.revision, sameRevision + 1);
  status(await request(race.path, { action: 'CANCEL', requestId: key(), revision: sameRevision }), 409);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM mission_simulation_events WHERE simulation_id=?').get(current.id).n, 2);
  pass('concurrent START reserves one attempt and concurrent updates use revision CAS with exactly one immutable event');

  for (const query of ["UPDATE challenges SET reward_amount=20000000 WHERE id=?", "UPDATE challenges SET status='CANCELLED' WHERE id=?", "UPDATE challenges SET selected_solver_id='mission_outsider' WHERE id=?"]) {
    assert.throws(() => sql.prepare(query).run(race.missionId), /MISSION_SIMULATION_LOCKED/);
  }
  assert.throws(() => sql.prepare("UPDATE teasers SET status='WITHDRAWN' WHERE id=?").run(race.teaserId), /MISSION_SIMULATION_LOCKED/);
  status(await request('/api/challenges/' + race.missionId + '/cancel', { reason: '가상 진행 중 원본 미션 취소 방지 검사' }), 409);
  status(await request('/api/challenges/' + race.missionId + '/teasers/' + race.teaserId + '/withdraw', {}, 'solver'), 409);
  const oldId = current.id;
  status((await action(race, 'CANCEL', 'owner')).response, 200);
  assert.equal(current.stage, 'CANCELLED');
  assert.equal(current.active, false);
  if (current.paymentStatus === 'APPROVED') assert.equal(current.transactions.filter(item => item.kind === 'REFUND').length, 1);
  sql.prepare("UPDATE teasers SET status='SUBMITTED' WHERE id=?").run(race.teaserId);
  sql.prepare("UPDATE teasers SET status='SHORTLISTED' WHERE id=?").run(race.otherTeaserId);
  const changed = status(await request(race.path), 200);
  assert.equal(changed.canStart, true);
  assert.equal(changed.candidateTeaserId, race.otherTeaserId);
  current = status(await request(race.path, { ...startBody(race), teaserId: changed.candidateTeaserId }), 201).simulation;
  assert.notEqual(current.id, oldId);
  assert.equal(current.solverId, ids.outsider);
  assert.ok(sql.prepare('SELECT closed_at FROM mission_simulations WHERE id=?').get(oldId).closed_at);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM mission_simulations WHERE challenge_id=?').get(race.missionId).n, 2);
  status(await request(race.path, undefined, 'solver'), 403);
  status((await action(race, 'CANCEL', 'owner')).response, 200);
  pass('source lifecycle/candidate is locked until virtual cancellation; canceled history persists and restart uses the current candidate with prior solver access revoked');

  const availability = seedMission();
  current = status(await request(availability.path, startBody(availability)), 201).simulation;
  sql.prepare("UPDATE users SET status='suspended' WHERE id=?").run(ids.solver);
  let unavailable = status(await request(availability.path), 200);
  assert.equal(unavailable.simulation.active, false);
  assert.equal(unavailable.simulation.blockedReason, 'PARTICIPANT_UNAVAILABLE');
  status((await action(availability, 'PAY_APPROVE', 'owner')).response, 409);
  status((await action(availability, 'CANCEL', 'owner')).response, 200);
  sql.prepare("UPDATE users SET status='active',email_verified=0 WHERE id=?").run(ids.solver);
  assert.equal(status(await request(availability.path), 200).canStart, false);
  status(await request(availability.path, startBody(availability)), 409);
  sql.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(ids.solver);
  pass('participant suspension invalidates ongoing virtual actions; owner can release the lock, and invalid email blocks restart');

  const actual = seedMission();
  sql.prepare("UPDATE challenges SET status='FUNDING_REQUIRED',funding_status='PAYMENT_REQUIRED',payment_due_at='2000-01-01',selected_solver_id=? WHERE id=?").run(ids.solver, actual.missionId);
  sql.prepare("UPDATE teasers SET status='SELECTED' WHERE id=?").run(actual.teaserId);
  assert.equal(status(await request(actual.path), 200).canStart, false);
  status(await request(actual.path, startBody(actual)), 409);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM mission_simulations WHERE challenge_id=?').get(actual.missionId).n, 0);
  pass('mission with an existing real funding request/deadline cannot be imported into virtual flow');

  const suspendedOwner = seedMission();
  current = status(await request(suspendedOwner.path, startBody(suspendedOwner)), 201).simulation;
  status((await action(suspendedOwner, 'PAY_APPROVE', 'owner')).response, 200);
  const financeTables = ['settlements', 'proofs', 'reviews', 'strikes', 'member_verifications', 'verified_identities', 'payout_sellers', 'transaction_orders', 'transaction_events', 'transaction_ledger', 'provider_operations'];
  const financialSnapshot = () => JSON.stringify(financeTables.map(table => [table, sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const financialBefore = financialSnapshot();
  const reputationBefore = sql.prepare('SELECT id,trust_score,strike_count FROM users ORDER BY id').all();
  status(await request('/api/admin/members/' + ids.owner + '/status', { status: 'suspended', reason: '가상 진행 중 의뢰자 정지 계정 처리 회귀 검사' }, 'admin'), 200);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(ids.owner).n, 0);
  status(await request(suspendedOwner.path, { action: 'CANCEL', requestId: key(), revision: current.revision }), 401);
  status(await request('/api/challenges/' + suspendedOwner.missionId + '/cancel', { reason: '정지된 의뢰자의 미션을 기존 관리자 권한으로 취소합니다.' }, 'admin'), 200);
  assert.equal(sql.prepare('SELECT status FROM challenges WHERE id=?').get(suspendedOwner.missionId).status, 'CANCELLED');
  const suspendedRecord = status(await request(suspendedOwner.path, undefined, 'solver'), 200).simulation;
  assert.equal(suspendedRecord.active, false);
  assert.equal(suspendedRecord.paymentStatus, 'APPROVED');
  status(await request(suspendedOwner.path, undefined, 'admin'), 403);
  status(await request(suspendedOwner.path, { action: 'CANCEL', requestId: key(), revision: current.revision }, 'admin'), 403);
  status((await action(suspendedOwner, 'BEGIN', 'solver')).response, 409);
  assert.equal(financialSnapshot(), financialBefore);
  assert.deepEqual(sql.prepare('SELECT id,trust_score,strike_count FROM users ORDER BY id').all(), reputationBefore);
  pass('suspended owner loses all sessions; existing administrator can cancel the actual mission without virtual access, real finance or reputation changes');

  const beforeRepeat = JSON.stringify(sql.prepare('SELECT * FROM mission_simulations ORDER BY id').all());
  const beforeEvents = JSON.stringify(sql.prepare('SELECT * FROM mission_simulation_events ORDER BY id').all());
  const migration = readFileSync(new URL('../migrations/0027_mission_simulations.sql', import.meta.url), 'utf8');
  sql.exec(migration); sql.exec(migration);
  assert.equal(JSON.stringify(sql.prepare('SELECT * FROM mission_simulations ORDER BY id').all()), beforeRepeat);
  assert.equal(JSON.stringify(sql.prepare('SELECT * FROM mission_simulation_events ORDER BY id').all()), beforeEvents);
  assert.throws(() => sql.exec('UPDATE mission_simulation_events SET action=action'), /MISSION_SIMULATION_EVENT_IMMUTABLE/);
  assert.throws(() => sql.exec('DELETE FROM mission_simulation_events'), /MISSION_SIMULATION_EVENT_IMMUTABLE/);
  assert.throws(() => sql.exec('UPDATE mission_simulations SET source_reward=1'), /MISSION_SIMULATION_SNAPSHOT_IMMUTABLE/);
  assert.equal(transportCalls, 0);
  pass('migration can run repeatedly while preserving records; event and source snapshot tampering is rejected');
} finally { globalThis.fetch = originalFetch; }
console.log(`Mission simulation security regression tests: ${passes} groups passed.`);
