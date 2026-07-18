import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const source = readFileSync(resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

function migrationArray(name) {
  const marker = new RegExp(`^${name}=\\(\\n`, 'm')
  const match = marker.exec(source)
  assert.ok(match, `${name} is missing`)
  const bodyStart = match.index + match[0].length
  const end = source.indexOf('\n)', bodyStart)
  assert.notEqual(end, -1, `${name} is not terminated`)
  const body = source.slice(bodyStart, end)
  return [...body.matchAll(/^\s+(202\d{11}_[a-z0-9_]+\.sql)$/gm)].map((match) => match[1])
}

test('predeploy, postdeploy and recovery phases are exact, unique and ordered', () => {
  const predeploy = migrationArray('PREDEPLOY_MIGRATIONS')
  const postdeploy = migrationArray('POSTDEPLOY_MIGRATIONS')
  const concurrentRecovery = migrationArray('CONCURRENT_RECOVERY_MIGRATIONS')
  const recovery = migrationArray('RECOVERY_MIGRATIONS')
  const superseded = migrationArray('SUPERSEDED_MIGRATIONS')
  const all = [...predeploy, ...postdeploy, ...concurrentRecovery, ...recovery, ...superseded]

  assert.equal(predeploy.length, 40)
  assert.deepEqual(postdeploy, ['20260716192000_social_edge_write_contract.sql'])
  assert.deepEqual(concurrentRecovery, [
    '20260716090000_add_account_export_cursor_indexes.sql',
    '20260716091500_add_security_export_cursor_indexes.sql',
    '20260716094500_add_bookmark_export_cursor_indexes.sql',
    '20260716101500_add_interaction_export_cursor_indexes.sql',
    '20260716110000_add_domain_export_cursor_indexes.sql',
  ])
  assert.deepEqual(recovery, [
    '20260716112000_exchange_connections_server_only.sql',
    '20260716112200_atomic_impression_recording.sql',
    '20260716083256_repair_legacy_exchange_logo_paths.sql',
  ])
  assert.deepEqual(superseded, ['20260716104500_collection_read_write_boundaries.sql'])
  assert.equal(new Set(all).size, 50)
  assert.equal(predeploy[0], '20260716111600_atomic_group_application_review.sql')
  assert.equal(predeploy.at(-1), '20260717222500_notification_type_contract.sql')
})

test('runner records exact file bodies and hashes in the same transaction', () => {
  assert.ok(source.includes('ARRAY[\\$$tag\\$'))
  assert.match(source, /shasum -a 256/)
  assert.match(source, /created_by, idempotency_key/)
  assert.match(source, /perl -0pe '' "\$file"/)
  assert.match(source, /migration ledger version already exists/)
  assert.match(source, /SET LOCAL search_path TO DEFAULT/)
})

test('transactional body stripping survives documentation after COMMIT', () => {
  assert.ok(source.includes('s/(^|\\n)COMMIT;(?:\\n|\\z)/$1/'))

  for (const migration of [
    ...migrationArray('PREDEPLOY_MIGRATIONS'),
    ...migrationArray('POSTDEPLOY_MIGRATIONS'),
    ...migrationArray('RECOVERY_MIGRATIONS'),
  ]) {
    const body = readFileSync(resolve(ROOT, 'supabase/migrations', migration), 'utf8')
    const stripped = body.replace(/(^|\n)BEGIN;\n/, '$1').replace(/(^|\n)COMMIT;(?:\n|$)/, '$1')
    assert.doesNotMatch(stripped, /^BEGIN;$|^COMMIT;$/m, migration)
  }
})

test('production writes require phase-specific confirmations', () => {
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_PREDEPLOY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_POSTDEPLOY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_CONCURRENT_RECOVERY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_RECOVERY"/)
  assert.match(source, /dry-run-all[\s\S]*emit_all_dry_run/)
  assert.match(source, /dry-run-recovery[\s\S]*emit_cutover_ledger_requirement/)
  assert.match(source, /printf '%s\\n' 'ROLLBACK;'/)
  assert.match(source, /postdeploy requires all predeploy ledger rows/)
  assert.match(source, /recovery requires all launch cutover ledger rows/)
})

test('concurrent recovery is resumable and never enters a transaction', () => {
  assert.match(source, /validate_concurrent_migration_file/)
  assert.match(source, /CREATE INDEX CONCURRENTLY/)
  assert.match(source, /pg_advisory_lock/)
  assert.match(source, /ledger_state/)
  assert.match(source, /SKIP exact ledger/)
  assert.match(source, /refusing drifted ledger/)
  assert.doesNotMatch(source, /emit_transaction 'COMMIT' "\$\{CONCURRENT_RECOVERY_MIGRATIONS/)
})

test('transactional recovery is resumable and keeps unrelated locks separate', () => {
  assert.match(source, /dry-run-recovery[\s\S]*ledger_state[\s\S]*ROLLBACK/)
  assert.match(
    source,
    /apply-recovery[\s\S]*ledger_state[\s\S]*emit_migration "\$migration"[\s\S]*COMMIT/
  )
  assert.doesNotMatch(source, /emit_transaction 'COMMIT' "\$\{RECOVERY_MIGRATIONS/)
})

test('status makes the intentionally superseded migration explicit', () => {
  assert.match(source, /phase in predeploy postdeploy concurrent-recovery recovery superseded/)
  assert.match(source, /superseded-by-20260717230000/)
  assert.match(source, /missing-superseder/)
})
