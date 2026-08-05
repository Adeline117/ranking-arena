import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseDocument } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const packagePath = path.join(root, 'package.json')
const workflowPath = path.join(root, '.github/workflows/ci.yml')
const maintenanceTestPath = path.join(
  root,
  'scripts/maintenance/purge-ranking-authority-caches.test.mjs'
)
const maintenanceCommand = 'node --test scripts/maintenance/purge-ranking-authority-caches.test.mjs'
const maintenanceStepName = 'Ranking authority cache purge fail-closed contract'

function readRegularFile(filePath, description) {
  const metadata = fs.lstatSync(filePath)
  assert.equal(metadata.isSymbolicLink(), false, `${description} must not be a symlink`)
  assert.equal(metadata.isFile(), true, `${description} must be a regular file`)
  return fs.readFileSync(filePath, 'utf8')
}

test('maintenance unit entrypoint is exact, discoverable, and limited to the purge contract', () => {
  const packageSource = readRegularFile(packagePath, 'root package manifest')
  const packageJson = JSON.parse(packageSource)
  const maintenanceTest = readRegularFile(
    maintenanceTestPath,
    'ranking authority cache purge contract'
  )

  assert.equal(packageJson.scripts?.['qa:maintenance-unit'], maintenanceCommand)
  assert.equal((packageSource.match(/"qa:maintenance-unit"\s*:/g) ?? []).length, 1)
  assert.equal((maintenanceTest.match(/^test\(/gm) ?? []).length, 11)
  assert.match(
    maintenanceTest,
    /const SCRIPT = resolve\(ROOT, 'scripts\/maintenance\/purge-ranking-authority-caches\.sh'\)/
  )
  assert.doesNotMatch(maintenanceCommand, /[*?{}[\]]/)
})

test('lint-typecheck runs the exact maintenance entrypoint as a blocking named step', () => {
  const workflowSource = readRegularFile(workflowPath, 'CI workflow')
  const document = parseDocument(workflowSource, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  })
  const diagnostics = [...document.errors, ...document.warnings]
  assert.equal(
    diagnostics.length,
    0,
    `CI workflow must be strict YAML:\n${diagnostics.map(String).join('\n')}`
  )

  const workflow = document.toJS({ maxAliasCount: 100 })
  const lintJob = workflow.jobs?.['lint-typecheck']
  assert.ok(lintJob, 'CI must define lint-typecheck')
  const matchingSteps = lintJob.steps.filter((step) => step.name === maintenanceStepName)
  assert.equal(matchingSteps.length, 1, `${maintenanceStepName} must be defined exactly once`)

  const maintenanceStep = matchingSteps[0]
  assert.equal(maintenanceStep.run, 'npm run qa:maintenance-unit')
  assert.equal(maintenanceStep.if, undefined)
  assert.equal(maintenanceStep.env, undefined)
  assert.equal(maintenanceStep['continue-on-error'], undefined)
  assert.equal(lintJob['continue-on-error'], undefined)
  assert.doesNotMatch(maintenanceStep.run, /\|\|\s*true/)

  const installIndex = lintJob.steps.findIndex((step) => step.run === 'npm ci --ignore-scripts')
  assert.notEqual(installIndex, -1, 'lint-typecheck must install the root lockfile')
  assert.ok(
    installIndex < lintJob.steps.indexOf(maintenanceStep),
    'maintenance contract must run after the root lockfile install'
  )
})
