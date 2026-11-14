import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const known = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'launch-inventory-gap.json'), 'utf8')
).unclassified

// The release inventory was fully classified through 2026-08-04. A migration
// newer than that and absent from it would silently miss the release. Existing
// gaps are listed so they can only shrink; see docs/LAUNCH_CHECKLIST.md. The
// horizon is fixed rather than "newest classified file": classifying a later
// forward replacement must not hide an older migration that is still a gap.
const CLASSIFIED_THROUGH = '20260804054000_publish_copier_snapshot_atomically.sql'

test('no new migration is missing from the release inventory', () => {
  const inventory = JSON.parse(
    execFileSync('node', ['scripts/qa/launch-migration-inventory.mjs'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
  )
  const classified = new Set(
    inventory.phases.flatMap((phase) => phase.migrations.map((migration) => migration.file))
  )
  assert.ok(classified.has(CLASSIFIED_THROUGH))
  const unclassified = readdirSync(resolve(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql') && file > CLASSIFIED_THROUGH && !classified.has(file))
    .sort()
  assert.deepEqual(unclassified, known)
})
