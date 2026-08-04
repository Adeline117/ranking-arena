import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'
import { hasCredentialExpression } from './workflow-credential-expression.mjs'

const workflowDirectory = '.github/workflows'
const pushMainOnly = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
const disabled = '${{ false }}'
const alwaysPushMainOnly = `always() && ${pushMainOnly}`

function loadWorkflow(name) {
  const source = readFileSync(`${workflowDirectory}/${name}.yml`, 'utf8')
  return { source, workflow: parse(source) }
}

test('credential matcher rejects dot and bracket GitHub expression syntax', () => {
  for (const expression of [
    '${{ secrets.PROD_KEY }}',
    "${{ secrets['PROD_KEY'] }}",
    '${{ Secrets.PROD_KEY }}',
    '${{ toJSON(secrets) }}',
    '${{ github.token }}',
    '${{ github. token }}',
    '${{ github . token }}',
    '${{ github["token"] }}',
    "${{ github[format('to{0}', 'ken')] }}",
    '${{ GitHub.Token }}',
    '${{ toJSON(github) }}',
    '${{ github.* }}',
    '${{ github }}',
    "${{ format('}}{0}', github.token) }}",
    "${{ format('{{{0}}}', secrets.PROD) }}",
    "${{ format('it''s }} {0}', secrets.PROD) }}",
    '${{ toJSON(github || null) }}',
    "${{ format('{0}', github || null) }}",
    '${{ github || null }}',
  ]) {
    assert.equal(hasCredentialExpression(expression), true)
  }
  assert.equal(hasCredentialExpression('offline, no secrets'), false)
  assert.equal(hasCredentialExpression('${{ github.ref }}-${{ github.sha }}'), false)
})

test('push and schedule workflows expose no arbitrary-ref dispatch', () => {
  const expectedTriggers = new Map([
    ['backup-db', ['schedule']],
    ['build-ingest-image', ['push']],
    ['deploy-freshness', ['schedule']],
    ['health-monitor', ['schedule']],
    ['openclaw-sentinels', ['schedule']],
  ])

  for (const [name, triggers] of expectedTriggers) {
    const { workflow } = loadWorkflow(name)
    assert.deepEqual(Object.keys(workflow.on), triggers, `${name} trigger drifted`)
    assert.equal(workflow.on.workflow_dispatch, undefined)
  }
})

test('NO-GO reusable workflows may be called but every job is unconditionally disabled', () => {
  for (const name of [
    'deploy-ingest-sg',
    'e2e-nightly',
    'mobile-build',
    'payment-path-canary',
    'vercel-release-control',
  ]) {
    const { source, workflow } = loadWorkflow(name)

    assert.deepEqual(
      Object.keys(workflow.on),
      ['workflow_call'],
      `${name} exposes a trigger other than workflow_call`
    )
    assert.equal(
      workflow.on.workflow_call.secrets,
      undefined,
      `${name} declares a reusable-workflow secret contract while suspended`
    )
    assert.match(source, /SECURITY SUSPENDED \(V1 NO-GO\)/)
    assert.match(source, /environment-only/)
    assert.match(source, /required reviewer/)
    assert.match(source, /protected(?:-| )main|protected tag\/release/)

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.if, disabled, `${name}:${jobName} is not fail-closed`)
    }
  }
})

test('event-driven privileged workflows provision no runner during NO-GO', () => {
  const expectedTriggers = new Map([
    ['backup-db', ['schedule']],
    ['build-ingest-image', ['push']],
    ['deploy-freshness', ['schedule']],
    ['deploy-gate', ['workflow_run']],
    ['health-monitor', ['schedule']],
    ['openclaw-sentinels', ['schedule']],
    ['post-deploy-evaluate', ['deployment_status']],
    ['post-deploy-smoke', ['deployment_status']],
  ])

  for (const [name, triggers] of expectedTriggers) {
    const { source, workflow } = loadWorkflow(name)
    assert.deepEqual(Object.keys(workflow.on), triggers, `${name} trigger drifted`)
    assert.match(source, /SECURITY SUSPENDED \(V1 NO-GO\)/)
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.if, disabled, `${name}:${jobName} is not fail-closed`)
    }
  }
})

test('every action reachable during NO-GO is pinned to one immutable commit', () => {
  for (const name of [
    'backup-db',
    'build-ingest-image',
    'ci',
    'deploy-freshness',
    'health-monitor',
    'lighthouse-ci',
    'openclaw-sentinels',
  ]) {
    const { workflow } = loadWorkflow(name)
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses) {
          assert.match(
            step.uses,
            /^[^@\s]+@[0-9a-f]{40}$/,
            `${name}:${jobName} uses mutable action`
          )
        }
      }
    }
  }
})

test('Lighthouse PR repository commands receive placeholders and no secret expressions', () => {
  const { source, workflow } = loadWorkflow('lighthouse-ci')
  assert.deepEqual(Object.keys(workflow.on), ['pull_request'])
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.equal(hasCredentialExpression(source), false)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.jobs.lighthouse.permissions, undefined)
  assert.equal(hasCredentialExpression(workflow.env ?? {}), false)

  const checkout = workflow.jobs.lighthouse.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@')
  )
  assert.ok(checkout)
  assert.equal(checkout.with.ref, '${{ github.sha }}')
  assert.equal(checkout.with['persist-credentials'], false)

  for (const step of workflow.jobs.lighthouse.steps.filter((candidate) => candidate.uses)) {
    assert.match(step.uses, /^[^@\s]+@[0-9a-f]{40}$/)
  }
  assert.doesNotMatch(source, /github-script|upload-artifact/)
})

test('CI pull requests have read-only token handling and no secret-bearing command path', () => {
  const { workflow } = loadWorkflow('ci')
  assert.deepEqual(Object.keys(workflow.on), ['push', 'pull_request'])
  assert.equal(workflow.on.pull_request_target, undefined)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(
    hasCredentialExpression(workflow.env ?? {}),
    false,
    'CI workflow-level env exposes a credential to every PR job'
  )

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const jobGuard = String(job.if ?? '')
    assert.equal(job.permissions, undefined, `${jobName} overrides the read-only workflow token`)
    const jobWithoutSteps = { ...job, steps: undefined }
    if (hasCredentialExpression(jobWithoutSteps)) {
      assert.equal(jobGuard, disabled, `${jobName} exposes job-level secrets while runnable`)
    }

    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.match(step.uses, /^actions\/checkout@[0-9a-f]{40}$/)
        assert.equal(
          step.with?.['persist-credentials'],
          false,
          `${jobName} persists the checkout token`
        )
      }

      if (step.uses?.startsWith('actions/setup-node@')) {
        assert.equal(step.with?.cache, undefined, `${jobName} registers a PR cache post-action`)
      }

      const serializedStep = JSON.stringify(step)
      if (hasCredentialExpression(serializedStep)) {
        const stepGuard = String(step.if ?? '')
        assert.ok(
          jobGuard === disabled || stepGuard === alwaysPushMainOnly,
          `${jobName}:${step.name ?? step.uses ?? step.run} exposes a secret to PRs`
        )
      }

      if (step.uses?.startsWith('actions/upload-artifact@')) {
        assert.ok(
          jobGuard === pushMainOnly || step.if === pushMainOnly || step.if === alwaysPushMainOnly,
          `${jobName} exposes an artifact runtime token after PR code`
        )
      }
    }
  }

  assert.equal(workflow.jobs['types-live-drift'].if, disabled)
  assert.equal(workflow.jobs['data-consistency'].if, disabled)
})
