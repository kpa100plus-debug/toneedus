import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildInventory, compareInventories, preservationSql, preservationTables, optionalPreservationTables, scopeFromRestore} from './production-preservation.mjs';
import {readDeploymentMetadata, validateProductionSnapshot} from './verify-production.mjs';

const key = Buffer.alloc(32, 42);
const cwd = fileURLToPath(new URL('..', import.meta.url));
function fixture() {
  return preservationTables.map(([table, keys, columns]) => ({success: true, results: [{
    __preservation_table: table,
    ...Object.fromEntries([...new Set([...keys, ...(columns === '*' ? ['immutable_payload'] : columns)])].map(column => [column, `${table}-${column}`])),
    private_note: 'never-publish-private-record',
  }]}));
}
const inventory = data => buildInventory(data, key);

test('preservation SQL runs against all current migrations and covers every protected column', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const filename of (await readdir(new URL('../migrations/', import.meta.url))).sort()) {
      if (filename.endsWith('.sql')) db.exec(await readFile(new URL('../migrations/' + filename, import.meta.url), 'utf8'));
    }
    const queries = preservationSql().trim().split(';').filter(query => query.trim());
    assert.equal(queries.length, 35);
    const response = queries.map(query => ({success: true, results: db.prepare(query).all()}));
    assert.equal(compareInventories(inventory(response), inventory(response)).preserved, true);
    for (const [table, keys, protectedColumns] of [...preservationTables, ...optionalPreservationTables]) {
      // Optional legacy/runtime-owned tables may not exist in a fresh schema.
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists && optionalPreservationTables.some(([name]) => name === table)) {
        assert.ok(!['mission_simulations', 'mission_simulation_events'].includes(table), `${table} migration missing`);
        continue;
      }
      const columns = new Set(db.prepare(`SELECT * FROM "${table}"`).columns().map(column => column.name));
      for (const column of [...keys, ...(protectedColumns === '*' ? [] : protectedColumns)]) assert.ok(columns.has(column), `${table}.${column}`);
    }
  } finally { db.close(); }
});

test('published evidence contains no raw IDs, private fields, emails or HMAC key', () => {
  const data = fixture();
  data[0].results[0].email = 'private@example.invalid';
  const serialized = JSON.stringify(inventory(data));
  for (const secret of ['private@example.invalid', 'never-publish-private-record', 'users-id', key.toString('hex')]) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /HMAC-SHA256/);
});

test('optional push and migration records are inventoried only when present in verified backup', () => {
  const counts = Object.fromEntries(preservationTables.map(([table]) => [table, 0]));
  const initial = scopeFromRestore({restoreVerified: true, counts});
  assert.equal(initial.length, preservationTables.length);
  for (const [table] of optionalPreservationTables) counts[table] = 0;
  const complete = scopeFromRestore({restoreVerified: true, counts});
  assert.equal(complete.length, preservationTables.length + optionalPreservationTables.length);
  assert.match(preservationSql(complete), /FROM "push_delivery_logs"/);
  assert.match(preservationSql(complete), /FROM "transaction_refund_receipts"/);
  const responses = complete.map(() => ({success: true, results: []}));
  const baseline = buildInventory(responses, key, complete);
  assert.equal(compareInventories(baseline, buildInventory(responses, key, complete)).preserved, true);
  assert.throws(() => scopeFromRestore({counts}), /Verified backup/);
  assert.throws(() => scopeFromRestore({restoreVerified: true, counts: {users: 0}}), /Required production table/);
});

test('normal activity updates and newly added members are retained without false preservation failure', () => {
  const before = fixture(), after = structuredClone(before);
  after[0].results[0].last_login_at = '2099-01-01';
  after[0].results.push({...after[0].results[0], id: 'new-member'});
  after[1].results[0].view_count = 500;
  const result = compareInventories(inventory(before), inventory(after));
  assert.deepEqual(result.tables.users, {before: 1, after: 2, retained: 1, added: 1, mutableRowsChanged: 1});
  assert.equal(result.tables.challenges.mutableRowsChanged, 1);
});

test('linked virtual records join preservation after their first migration and keep immutable party and event evidence', () => {
  const counts = Object.fromEntries(preservationTables.map(([table]) => [table, 0]));
  const firstScope = scopeFromRestore({restoreVerified: true, counts});
  assert.equal(firstScope.some(([table]) => table === 'mission_simulations'), false);
  counts.mission_simulations = 1; counts.mission_simulation_events = 1;
  const scope = scopeFromRestore({restoreVerified: true, counts});
  const before = scope.map(([table, keys, columns]) => ({success: true, results: [{
    __preservation_table: table,
    ...Object.fromEntries([...new Set([...keys, ...(columns === '*' ? ['immutable_payload'] : columns)])].map(column => [column, `${table}-${column}`])),
    revision: 1,
  }]}));
  const baseline = buildInventory(before, key, scope);
  const simulationIndex = scope.findIndex(([table]) => table === 'mission_simulations');
  const eventIndex = scope.findIndex(([table]) => table === 'mission_simulation_events');
  const progressed = structuredClone(before); progressed[simulationIndex].results[0].revision = 2;
  assert.equal(compareInventories(baseline, buildInventory(progressed, key, scope)).preserved, true);
  for (const [index, column] of [[simulationIndex, 'solver_id'], [simulationIndex, 'source_reward'], [eventIndex, 'immutable_payload']]) {
    const after = structuredClone(before); after[index].results[0][column] = 'changed';
    assert.throws(() => compareInventories(baseline, buildInventory(after, key, scope)), /protected values changed/);
  }
  for (const index of [simulationIndex, eventIndex]) {
    const after = structuredClone(before); after[index].results = [];
    assert.throws(() => compareInventories(baseline, buildInventory(after, key, scope)), /lost an existing record/);
  }
});

for (const [index, [table]] of preservationTables.entries()) {
  test(`deleted existing ${table} record stops deployment`, () => {
    const before = fixture(), after = structuredClone(before);
    after[index].results = [];
    assert.throws(() => compareInventories(inventory(before), inventory(after)), /lost an existing record/);
  });
}

for (const [table, column] of [['users', 'trust_score'], ['users', 'is_admin'], ['admin_roles', 'role'], ['challenges', 'owner_id'],
  ['teasers', 'solver_id'], ['auth_identities', 'provider_subject'], ['transaction_orders', 'amount'], ['transaction_ledger', 'immutable_payload'],
  ['trust_policy_items', 'immutable_payload'], ['trust_evidence', 'immutable_payload'], ['audit_logs', 'immutable_payload']]) {
  test(`changed ${table}.${column} stops deployment`, () => {
    const before = fixture(), after = structuredClone(before);
    after[preservationTables.findIndex(([name]) => name === table)].results[0][column] = 'changed';
    assert.throws(() => compareInventories(inventory(before), inventory(after)), /protected values changed/);
  });
}

test('truncated, failed, mismatched, duplicate and missing-key inventories fail closed', () => {
  assert.throws(() => inventory(fixture().slice(1)), /Invalid D1/);
  const failed = fixture(); failed[0].success = false; assert.throws(() => inventory(failed), /Invalid D1/);
  const mismatch = fixture(); [mismatch[0], mismatch[1]] = [mismatch[1], mismatch[0]]; assert.throws(() => inventory(mismatch), /table order/);
  const duplicate = fixture(); duplicate[0].results.push({...duplicate[0].results[0]}); assert.throws(() => inventory(duplicate), /duplicate keys/);
  const missing = fixture(); delete missing[0].results[0].id; assert.throws(() => inventory(missing), /expected column/);
});

test('runner CLI creates a private HMAC key and hash-only baseline, then writes retention evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modu-preservation-'));
  try {
    const before = fixture();
    for (const [index, count] of [[0, 21], [1, 61]]) before[index].results = Array.from({length: count}, (_, i) => ({...before[index].results[0], id: `fixture-${index}-${i}`}));
    const input = join(directory, 'inventory.json'), baseline = join(directory, 'baseline.json'), report = join(directory, 'report.json');
    await writeFile(input, JSON.stringify(before));
    const run = mode => spawnSync(process.execPath, ['scripts/production-preservation.mjs', mode, input, baseline, ...(mode === 'after' ? [report] : [])], {cwd, encoding: 'utf8'});
    const first = run('before'); assert.equal(first.status, 0, first.stderr);
    assert.equal((await stat(baseline + '.key')).mode & 0o777, 0o600);
    assert.equal(first.stdout.includes('never-publish'), false);
    const second = run('after'); assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(await readFile(report, 'utf8')).tables.challenges.retained, 61);
    assert.equal(JSON.stringify(JSON.parse(await readFile(baseline, 'utf8'))).includes('fixture-'), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('isolated restore counts all tables without exposing records; corrupt foreign keys stop deployment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modu-restore-'));
  try {
    const input = join(directory, 'backup.sql'), output = join(directory, 'report.json');
    const schema = 'CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE challenges(id TEXT PRIMARY KEY);CREATE TABLE admin_roles(user_id TEXT);CREATE TABLE push_delivery_logs(id TEXT, user_id TEXT REFERENCES users(id));';
    await writeFile(input, schema + "INSERT INTO users VALUES('secret-member');INSERT INTO push_delivery_logs VALUES('secret-event','secret-member');");
    const run = () => spawnSync('python3', ['scripts/restore-backup-check.py', input, output], {cwd, encoding: 'utf8'});
    let result = run(); assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.tableCount, 4); assert.equal(report.counts.push_delivery_logs, 1); assert.equal(result.stdout.includes('secret-member'), false);
    await writeFile(input, schema + "INSERT INTO push_delivery_logs VALUES('secret-event','missing-member');");
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /restore validation failed/); assert.equal(result.stderr.includes('missing-member'), false);
    await writeFile(input, 'CREATE TABLE private_sensitive_sql( broken');
    result = run(); assert.notEqual(result.status, 0); assert.equal(result.stderr.includes('private_sensitive_sql'), false);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

function snapshot() {
  const health = {ok: true, environment: 'production', version: '0.0.1', pwaVersion: 'v2', commit: 'a'.repeat(40), moneyEnabled: false, moneyMode: 'disabled', liveTransactionsAvailable: false};
  const publicConfig = {moneyEnabled: false, moneyMode: 'disabled', activityVerification: 'email', emailVerificationRequired: true};
  return {health, publicConfig, bootstrap: {config: {...publicConfig}, challenges: []}, index: '<script src="live-app.js?v=2">', sw: 'modu-challenge-v2'};
}
const config = {vars: {APP_VERSION: '0.0.1', PWA_VERSION: 'v2'}};
test('deployment validation requires matching commit, PWA cache and disabled money in both config APIs', () => {
  assert.equal(validateProductionSnapshot(snapshot(), config, 'a'.repeat(40)).productionVerified, true);
  assert.throws(() => validateProductionSnapshot(snapshot(), config, undefined));
  const money = snapshot(); money.bootstrap.config.moneyEnabled = true; assert.throws(() => validateProductionSnapshot(money, config, 'a'.repeat(40)));
  const commit = snapshot(); commit.health.commit = 'b'.repeat(40); assert.throws(() => validateProductionSnapshot(commit, config, 'a'.repeat(40)));
  const sw = snapshot(); sw.sw = 'modu-challenge-v1'; assert.throws(() => validateProductionSnapshot(sw, config, 'a'.repeat(40)));
});

const credentials = {accountId: '1'.repeat(32), token: 'never-log-token', workerName: 'modu-challenge'};
const deployment = {id: '11111111-1111-1111-1111-111111111111', author_email: 'private@example.invalid', annotations: {token: 'sensitive'},
  created_on: '2026-09-27T08:00:00Z', versions: [{version_id: '22222222-2222-2222-2222-222222222222', percentage: 100}]};
test('Worker version evidence is fetched using GET and exposes only permitted fields', async () => {
  const result = await readDeploymentMetadata(credentials, async (url, options) => {
    assert.ok(url.endsWith('/workers/scripts/modu-challenge/deployments')); assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer never-log-token');
    return new Response(JSON.stringify({success: true, result: {deployments: [deployment]}}));
  });
  assert.equal(result.verified, true); assert.equal(result.versions[0].id, deployment.versions[0].version_id);
  for (const value of ['private@example.invalid', 'never-log-token', 'sensitive']) assert.equal(JSON.stringify(result).includes(value), false);
});

test('missing permissions and malformed provider responses are recorded without leaking errors or claiming success', async () => {
  const missing = await readDeploymentMetadata({}, () => { throw Error('must not call'); }); assert.equal(missing.verified, false);
  const denied = await readDeploymentMetadata(credentials, async () => new Response('sensitive', {status: 403})); assert.deepEqual(denied, {verified: false, reason: 'CLOUDFLARE_HTTP_403'});
  const invalid = await readDeploymentMetadata(credentials, async () => new Response(JSON.stringify({success: true, result: {deployments: [{...deployment, versions: []}]}})));
  assert.equal(invalid.verified, false);
  const failed = await readDeploymentMetadata(credentials, async () => { throw Error('private-token'); }); assert.equal(JSON.stringify(failed).includes('private-token'), false);
});
