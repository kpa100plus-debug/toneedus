import {readFile, writeFile} from 'node:fs/promises';
import {createHmac, randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Durable records only. Expiring sessions, OTPs and rate-limit rows are included
// in the encrypted full backup, but may legitimately expire during deployment.
// Each projection preserves identity/ownership and important invariant values;
// ordinary activity state changes are allowed while the live service is running.
export const preservationTables = [
  ['users', ['id'], ['email', 'is_admin', 'trust_score', 'strike_count']],
  ['challenges', ['id'], ['owner_id']],
  ['admin_roles', ['user_id'], ['role']],
  ['teasers', ['id'], ['challenge_id', 'solver_id']],
  ['challenge_events', ['id'], '*'],
  ['proofs', ['id'], ['challenge_id', 'solver_id']],
  ['settlements', ['id'], ['challenge_id', 'owner_id', 'solver_id', 'gross_reward', 'platform_fee', 'solver_payout']],
  ['reviews', ['id'], ['challenge_id', 'reviewer_id', 'reviewee_id', 'reviewer_role', 'rating']],
  ['strikes', ['id'], ['user_id', 'strike_level', 'reason_code']],
  ['disputes', ['id'], ['challenge_id', 'opened_by']],
  ['audit_logs', ['id'], '*'],
  ['notifications', ['id'], ['user_id', 'type', 'resource_type', 'resource_id']],
  ['push_subscriptions', ['id'], ['user_id']],
  ['moderation_review_notes', ['id'], ['challenge_id', 'author_id']],
  ['auth_identities', ['id'], ['user_id', 'provider', 'provider_subject']],
  ['member_actor_profiles', ['id'], ['user_id', 'subject_type']],
  ['member_verifications', ['id'], ['user_id', 'verification_type', 'subject_type']],
  ['activity_qualifications', ['id'], ['user_id', 'activity_role', 'subject_type', 'challenge_id', 'teaser_id']],
  ['trust_policy_versions', ['id'], '*'],
  ['trust_policy_items', ['id'], '*'],
  ['trust_evidence', ['id'], '*'],
  ['moderation_appeals', ['id'], ['challenge_id', 'user_id']],
  ['identity_attempts', ['id'], ['user_id', 'consent_version']],
  ['verified_identities', ['user_id'], []],
  ['verification_reviews', ['id'], '*'],
  ['transaction_orders', ['id'], ['challenge_id', 'owner_id', 'solver_id', 'mode', 'amount', 'fee', 'net', 'request_key']],
  ['transaction_events', ['id'], '*'],
  ['transaction_ledger', ['id'], '*'],
  ['entity_cases', ['id'], ['user_id', 'subject_type']],
  ['entity_evidence', ['id'], ['case_id', 'kind']],
  ['entity_reviews', ['id'], '*'],
  ['provider_operations', ['id'], ['order_id', 'kind', 'request_key', 'fingerprint']],
  ['payout_sellers', ['user_id', 'mode'], []],
  ['payment_simulations', ['id'], ['user_id', 'request_id']],
  ['challenge_create_requests', ['owner_id', 'idempotency_key'], ['challenge_id']],
];

export const optionalPreservationTables = [
  ['mission_simulations', ['id'], ['challenge_id', 'owner_id', 'solver_id', 'teaser_id', 'source_reward', 'create_request_key', 'start_fingerprint']],
  ['mission_simulation_events', ['id'], '*'],
  ['push_delivery_logs', ['id'], '*'],
  ['push_announcement_logs', ['id'], ['actor_id']],
  ['transaction_refund_receipts', ['event_id'], '*'],
  ['provider_operation_intents', ['operation_id'], '*'],
  ['auth_identity_restrictions', ['identity_id'], []],
  ['d1_migrations', ['id'], '*'],
];

export function scopeFromRestore(validation) {
  if (!validation.restoreVerified || !validation.counts) throw Error('Verified backup counts required to choose inventory tables');
  if (preservationTables.some(([table]) => !Object.hasOwn(validation.counts, table))) throw Error('Required production table missing from backup');
  return [...preservationTables, ...optionalPreservationTables.filter(([table]) => Object.hasOwn(validation.counts, table))];
}

const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const project = (row, columns) => Object.fromEntries(columns.map(column => {
  if (!Object.hasOwn(row, column)) throw Error('D1 inventory is missing an expected column');
  return [column, row[column]];
}));

export function preservationSql(tables = preservationTables) {
  // Stable table tags make a missing/reordered result fail closed.
  return tables.map(([table, keys]) =>
    `SELECT '${table}' AS __preservation_table, * FROM "${table}" ORDER BY ${keys.map(key => `"${key}"`).join(',')};`).join('\n') + '\n';
}

export function buildInventory(data, key, scope = preservationTables) {
  if (!Array.isArray(data) || data.length !== scope.length ||
      data.some(result => result.success === false || !Array.isArray(result.results))) throw Error('Invalid D1 inventory');
  const hash = value => createHmac('sha256', key).update(canonical(value)).digest('hex');
  const tables = {};
  for (const [index, [table, keys, protectedColumns]] of scope.entries()) {
    const rows = {};
    for (const record of data[index].results) {
      if (record.__preservation_table !== table) throw Error('D1 inventory table order mismatch');
      const {__preservation_table, ...row} = record;
      const identity = project(row, keys);
      if (Object.values(identity).some(value => value === null || value === undefined)) throw Error('D1 inventory has a missing key');
      const keyHash = hash({table, ...identity});
      if (Object.hasOwn(rows, keyHash)) throw Error('D1 inventory has duplicate keys');
      rows[keyHash] = {
        protected: hash(protectedColumns === '*' ? row : project(row, [...keys, ...protectedColumns])),
        content: hash(row),
      };
    }
    tables[table] = {count: Object.keys(rows).length, rows};
  }
  return {format: 2, algorithm: 'HMAC-SHA256', scope, tables};
}

export function compareInventories(previous, current) {
  if (previous.format !== 2 || current.format !== 2) throw Error('Unsupported preservation baseline');
  if (canonical(previous.scope) !== canonical(current.scope)) throw Error('Preservation scope changed');
  const tables = {};
  for (const [table] of previous.scope) {
    const before = previous.tables?.[table], after = current.tables?.[table];
    if (!before || !after) throw Error('Preservation table missing');
    let changedRows = 0;
    for (const [key, record] of Object.entries(before.rows)) {
      if (!after.rows[key]) throw Error(`Preservation failed: ${table} lost an existing record; no automatic restore`);
      if (record.protected !== after.rows[key].protected) throw Error(`Preservation failed: ${table} protected values changed; no automatic restore`);
      if (record.content !== after.rows[key].content) changedRows++;
    }
    tables[table] = {before: before.count, after: after.count, retained: before.count, added: after.count - before.count, mutableRowsChanged: changedRows};
  }
  return {preserved: true, tables};
}

async function main() {
  const [mode, input, baseline, report] = process.argv.slice(2);
  const readJson = async file => {
    const raw = await readFile(file, 'utf8');
    try { return JSON.parse(raw); } catch { throw Error('Invalid inventory JSON; raw content suppressed'); }
  };
  if (mode === 'sql') {
    const scope = baseline ? scopeFromRestore(await readJson(baseline)) : preservationTables;
    await writeFile(input, preservationSql(scope));
    await writeFile(input + '.tables.json', JSON.stringify(scope));
    return;
  }
  if (!['before', 'after'].includes(mode) || !input || !baseline) throw Error('Expected sql output or before/after input baseline [report]');
  // The random HMAC key stays on the ephemeral runner and is never uploaded.
  // Published hash-only evidence cannot be used to guess member emails or IDs.
  const keyPath = baseline + '.key';
  const key = mode === 'before' ? randomBytes(32) : await readFile(keyPath);
  const previous = mode === 'after' ? await readJson(baseline) : null;
  const scope = previous?.scope || (report ? await readJson(report) : preservationTables);
  const inventory = buildInventory(await readJson(input), key, scope);
  if (mode === 'before') {
    if (inventory.tables.users.count < 21 || inventory.tables.challenges.count < 61) throw Error('Production counts below observed baseline. Stop and investigate.');
    await writeFile(keyPath, key, {mode: 0o600, flag: 'wx'});
    await writeFile(baseline, JSON.stringify(inventory, null, 2));
    console.log(JSON.stringify({preservation: 'before', counts: Object.fromEntries(Object.entries(inventory.tables).map(([table, value]) => [table, value.count]))}));
  } else {
    const result = compareInventories(previous, inventory);
    if (report) await writeFile(report, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({preservation: 'after', ...result}));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
