import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  analyzeMigrationEntries,
  KNOWN_SHORT_COLLISION_PATHS,
  parseLegacyBaseline,
  scanMigrationDirectory,
  sha256,
  validateCommittedBaseline,
} from './migration-history-shape.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'qa', 'migration-history-shape-baseline.txt')

function entry(migrationPath, contents) {
  return { path: migrationPath, contents: Buffer.from(contents) }
}

test('checked-in migration history matches the offline legacy fingerprint', () => {
  const result = scanMigrationDirectory()

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.summary, {
    migrationCount: 531,
    modernCount: 340,
    legacyCount: 191,
    legacyLetterVersionCount: 93,
    shortCollisionCount: 3,
    baselineCount: 191,
  })
})

test('committed baseline retains all letter-version and short-collision debts', () => {
  const baseline = parseLegacyBaseline(readFileSync(BASELINE_PATH, 'utf8'))

  assert.deepEqual(validateCommittedBaseline(baseline), [])
  for (const migrationPath of KNOWN_SHORT_COLLISION_PATHS) {
    assert.equal(baseline.has(migrationPath), true)
  }

  const expanded = new Map(baseline)
  expanded.set('supabase/migrations/20260718_new_short_version.sql', 'a'.repeat(64))
  assert.match(validateCommittedBaseline(expanded).join('\n'), /exactly 191 paths/)
})

test('rejects a new non-14-digit migration while allowing legacy debt to shrink', () => {
  const oldPath = 'supabase/migrations/00001_initial_schema.sql'
  const oldContents = 'legacy'
  const baseline = new Map([[oldPath, sha256(oldContents)]])

  const withoutDebt = analyzeMigrationEntries(
    [entry('supabase/migrations/20260718010101_safe_change.sql', 'select 1;')],
    baseline
  )
  assert.deepEqual(withoutDebt.errors, [])

  const withNewDebt = analyzeMigrationEntries(
    [entry('supabase/migrations/20260718_new_short_version.sql', 'select 1;')],
    baseline
  )
  assert.match(withNewDebt.errors.join('\n'), /new migration must use a 14-digit/)
})

test('legacy exceptions require both the exact path and exact sha256', () => {
  const allowedPath = 'supabase/migrations/20260315a_directory_sort_priority.sql'
  const baseline = new Map([[allowedPath, sha256('original')]])

  const changed = analyzeMigrationEntries([entry(allowedPath, 'modified')], baseline)
  assert.match(changed.errors.join('\n'), /legacy migration fingerprint changed/)

  const renamed = analyzeMigrationEntries(
    [entry('supabase/migrations/20260315c_directory_sort_priority.sql', 'original')],
    baseline
  )
  assert.match(renamed.errors.join('\n'), /new migration must use a 14-digit/)
})

test('rejects duplicate 14-digit versions and unsafe modern slugs', () => {
  const duplicate = analyzeMigrationEntries(
    [
      entry('supabase/migrations/20260718010101_first.sql', 'select 1;'),
      entry('supabase/migrations/20260718010101_second.sql', 'select 2;'),
    ],
    new Map()
  )
  assert.match(duplicate.errors.join('\n'), /duplicate 14-digit migration version/)

  const unsafeSlug = analyzeMigrationEntries(
    [entry('supabase/migrations/20260718010102_bad-name.sql', 'select 1;')],
    new Map()
  )
  assert.match(unsafeSlug.errors.join('\n'), /new migration must use a 14-digit/)
})

test('baseline parser fails closed on malformed, duplicate, or modern entries', () => {
  assert.throws(() => parseLegacyBaseline('not-a-baseline-line'), /invalid/)

  const digest = 'a'.repeat(64)
  assert.throws(
    () =>
      parseLegacyBaseline(
        `${digest}  supabase/migrations/00001_old.sql\n` +
          `${digest}  supabase/migrations/00001_old.sql\n`
      ),
    /duplicate/
  )
  assert.throws(
    () => parseLegacyBaseline(`${digest}  supabase/migrations/20260718010101_modern.sql\n`),
    /must not be legacy-allowlisted/
  )
})
