import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const source = readFileSync(resolve(ROOT, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

function migrationArray(name) {
  const marker = `${name}=(\n`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${name} is missing`)
  const bodyStart = start + marker.length
  const end = source.indexOf('\n)', bodyStart)
  assert.notEqual(end, -1, `${name} is not terminated`)
  const body = source.slice(bodyStart, end)
  return [...body.matchAll(/^\s+(202\d{11}_[a-z0-9_]+\.sql)$/gm)].map((match) => match[1])
}

test('predeploy and postdeploy phases are exact, unique and ordered', () => {
  const predeploy = migrationArray('PREDEPLOY_MIGRATIONS')
  const postdeploy = migrationArray('POSTDEPLOY_MIGRATIONS')
  const all = [...predeploy, ...postdeploy]

  assert.equal(predeploy.length, 40)
  assert.deepEqual(postdeploy, ['20260716192000_social_edge_write_contract.sql'])
  assert.equal(new Set(all).size, 41)
  assert.equal(predeploy[0], '20260716111600_atomic_group_application_review.sql')
  assert.equal(predeploy.at(-1), '20260717222500_notification_type_contract.sql')
  assert.ok(!predeploy.includes(postdeploy[0]))
})

test('runner records exact file bodies and hashes in the same transaction', () => {
  assert.ok(source.includes('ARRAY[\\$$tag\\$'))
  assert.match(source, /shasum -a 256/)
  assert.match(source, /created_by, idempotency_key/)
  assert.match(source, /perl -0pe '' "\$file"/)
  assert.match(source, /migration ledger version already exists/)
  assert.match(source, /SET LOCAL search_path TO DEFAULT/)
})

test('production writes require phase-specific confirmations', () => {
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_PREDEPLOY"/)
  assert.match(source, /ARENA_PRODUCTION_MIGRATION_CONFIRM:-}" != "APPLY_POSTDEPLOY"/)
  assert.match(source, /dry-run-all[\s\S]*emit_all_dry_run/)
  assert.match(source, /printf '%s\\n' 'ROLLBACK;'/)
  assert.match(source, /postdeploy requires all predeploy ledger rows/)
})
