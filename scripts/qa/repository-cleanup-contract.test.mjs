import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

test('retired standalone diagnostics stay removed in favor of supported entrypoints', () => {
  const retiredEntrypoints = ['scripts/arena-status-check.mjs', 'scripts/validate-data.mjs']

  assert.deepEqual(
    retiredEntrypoints.filter((path) => existsSync(join(repoRoot, path))),
    [],
    'retired diagnostics must not return; use diagnose, pipeline-health-check, or qa:serving'
  )

  assert.equal(packageJson.scripts.diagnose, 'node scripts/diagnose.mjs')
  assert.equal(packageJson.scripts['qa:serving'], 'node scripts/qa/serving-acceptance.mjs')

  const packageCommands = Object.values(packageJson.scripts).join('\n')
  for (const retiredEntrypoint of retiredEntrypoints) {
    assert.doesNotMatch(packageCommands, new RegExp(retiredEntrypoint.replaceAll('.', '\\.')))
  }
})
