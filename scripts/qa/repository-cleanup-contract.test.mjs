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

test('retired ad hoc UI screenshot entrypoint stays removed', () => {
  const retiredEntrypoints = [
    'scripts/qa-ui-check.mjs',
    'scripts/qa-screenshot-rankings.mjs',
    'scripts/qa-screenshot.mjs',
    'scripts/screenshot-diagnose.ts',
    'scripts/mobile-screenshot-test.mjs',
  ]
  const supportedEntrypoint = 'scripts/qa/visual-audit.mjs'

  assert.deepEqual(
    retiredEntrypoints.filter((path) => existsSync(join(repoRoot, path))),
    [],
    'retired fixed-route screenshot scripts must not return; use the maintained visual audit'
  )
  assert.equal(
    existsSync(join(repoRoot, supportedEntrypoint)),
    true,
    'the maintained visual audit entrypoint must remain available'
  )

  const packageCommands = Object.values(packageJson.scripts).join('\n')
  for (const retiredEntrypoint of retiredEntrypoints) {
    assert.doesNotMatch(packageCommands, new RegExp(retiredEntrypoint.replaceAll('.', '\\.')))
  }
})

test('retired one-off schema and VPS instructions stay removed', () => {
  const retiredOperationalFiles = ['scripts/get-schema.mjs', 'scripts/DEPLOY_TO_VPS.md']

  assert.deepEqual(
    retiredOperationalFiles.filter((path) => existsSync(join(repoRoot, path))),
    [],
    'retired probes and deployment instructions must not bypass supported schema and ingest workflows'
  )

  assert.equal(existsSync(join(repoRoot, 'docs/INGEST_WORKER_DEPLOY.md')), true)
  assert.equal(packageJson.scripts['gen:types'], 'bash scripts/gen-types.sh')
})

test('retired pre-arena tools stay removed', () => {
  const retiredPreArenaTools = [
    'scripts/generate-trader-bios.ts',
    'scripts/lib/base-importer.mjs',
    'scripts/lib/data-validation.mjs',
    'scripts/lib/platform-config.mjs',
    'scripts/lib/stealth-browser.mjs',
  ]

  assert.deepEqual(
    retiredPreArenaTools.filter((path) => existsSync(join(repoRoot, path))),
    [],
    'retired tools outside the supported arena pipeline must be rewritten, not restored'
  )

  const packageCommands = Object.values(packageJson.scripts).join('\n')
  for (const retiredTool of retiredPreArenaTools) {
    assert.doesNotMatch(packageCommands, new RegExp(retiredTool.replaceAll('.', '\\.')))
  }
})

test('retired duplicate post hooks stay removed', () => {
  const retiredHooks = [
    'app/components/post/hooks/usePostFeedData.ts',
    'app/components/post/hooks/useBookmarkRepost.ts',
  ]

  assert.deepEqual(
    retiredHooks.filter((path) => existsSync(join(repoRoot, path))),
    [],
    'dead offset-feed and duplicate bookmark hooks must not return beside the supported post flow'
  )

  const hooksIndex = readFileSync(join(repoRoot, 'app/components/post/hooks/index.ts'), 'utf8')
  for (const retiredHook of ['usePostFeedData', 'useBookmarkRepost']) {
    assert.doesNotMatch(hooksIndex, new RegExp(retiredHook))
  }
})
