import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const known = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'launch-inventory-gap.json'), 'utf8')
).unclassified

// The release inventory was last classified on 2026-08-04. A migration newer
// than that and absent from it would silently miss the release. Existing gaps
// are listed so they can only shrink; see docs/LAUNCH_CHECKLIST.md.
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
  const newest = [...classified].sort().at(-1)
  const unclassified = readdirSync(resolve(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql') && file > newest && !classified.has(file))
    .sort()
  assert.deepEqual(unclassified, known)
})
