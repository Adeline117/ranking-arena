import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/lighthouse-ci.yml'), 'utf8')
const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const nightlyWorkflowSource = fs.readFileSync(
  path.join(root, '.github/workflows/e2e-nightly.yml'),
  'utf8'
)
const lighthouseWorkflow = parse(workflow)
const mainWorkflow = parse(ciWorkflow)
const nightlyWorkflow = parse(nightlyWorkflowSource)
const lighthouseConfig = await import(path.join(root, 'lighthouserc.js'))

test('CI validates pull requests targeting stacked branches', () => {
  assert.deepEqual(mainWorkflow.permissions, { contents: 'read' })
  for (const config of [mainWorkflow, lighthouseWorkflow]) {
    assert.ok(Object.hasOwn(config.on, 'pull_request'))
    assert.equal(config.on.pull_request, null)
  }
})

test('Lighthouse builds pull requests without production credentials', () => {
  assert.deepEqual(lighthouseWorkflow.permissions, { contents: 'read' })
  assert.equal(lighthouseWorkflow.env.NEXT_PUBLIC_SUPABASE_URL, 'https://placeholder.supabase.co')
  assert.equal(
    lighthouseWorkflow.env.SUPABASE_SERVICE_ROLE_KEY,
    'lighthouse-build-service-placeholder'
  )
  assert.equal(
    lighthouseWorkflow.env.CRON_SECRET,
    'lighthouse-build-placeholder-cron-secret-000000'
  )
  assert.equal(Object.hasOwn(lighthouseWorkflow.env, 'DATABASE_URL'), false)
  assert.doesNotMatch(workflow, /secrets\./)
  assert.doesNotMatch(workflow, /LHCI_GITHUB_(?:APP_)?TOKEN/)
})

test('Lighthouse allocates the validated production-build heap', () => {
  assert.match(
    workflow,
    /- name: Build\n\s+run: npm run build\n\s+env:\n[\s\S]*?NODE_OPTIONS: --max-old-space-size=4096/
  )
})

test('Lighthouse result parsing does not shadow github-script globals', () => {
  assert.doesNotMatch(workflow, /\b(?:const|let|var) glob\b/)
  assert.match(workflow, /core\.summary\.addRaw\(body\)\.write\(\)/)
  assert.doesNotMatch(workflow, /createComment/)
})

test('Lighthouse audits canonical application routes and retains hidden reports', () => {
  assert.deepEqual(lighthouseConfig.default.ci.collect.url, [
    'http://localhost:3000/',
    'http://localhost:3000/?ex=binance_futures',
    'http://localhost:3000/learn',
  ])
  const artifact = lighthouseWorkflow.jobs.lighthouse.steps.at(-1)
  assert.equal(artifact['continue-on-error'], true)
  assert.equal(artifact.with['include-hidden-files'], true)
  assert.equal(artifact.with['retention-days'], 3)
})

test('CI keeps optional artifacts bounded and off the quality gate', () => {
  const unitSteps = mainWorkflow.jobs['unit-tests'].steps
  const testStep = unitSteps.find((step) => step.name === 'Run tests with coverage')
  const coverageArtifact = unitSteps.find((step) => step.name === 'Upload coverage artifact')
  assert.match(testStep.run, /--coverageReporters=lcovonly/)
  assert.equal(coverageArtifact.uses, 'actions/upload-artifact@v6')
  assert.equal(coverageArtifact['continue-on-error'], true)
  assert.equal(coverageArtifact.with.path, 'coverage/lcov.info')
  assert.equal(coverageArtifact.with['retention-days'], 3)
  assert.equal(coverageArtifact.with['if-no-files-found'], 'warn')

  const buildWorkflow = JSON.stringify(mainWorkflow.jobs.build)
  assert.doesNotMatch(buildWorkflow, /nextjs-build|actions\/upload-artifact/)
  assert.doesNotMatch(ciWorkflow, /codecov\/codecov-action/)
})

test('Playwright uploads one bounded diagnostic only after a failure', () => {
  assert.deepEqual(nightlyWorkflow.permissions, { contents: 'read' })

  for (const job of [mainWorkflow.jobs.e2e, nightlyWorkflow.jobs.e2e]) {
    const artifacts = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].uses, 'actions/upload-artifact@v6')
    assert.equal(artifacts[0].if, 'failure()')
    assert.equal(artifacts[0]['continue-on-error'], true)
    assert.equal(artifacts[0].with['retention-days'], 3)
    assert.equal(artifacts[0].with['if-no-files-found'], 'warn')
    assert.equal(artifacts[0].with.path, 'playwright-report/\ntest-results/\n')
  }
})
