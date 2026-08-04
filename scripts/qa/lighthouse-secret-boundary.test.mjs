import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parse } from 'yaml'
import { hasCredentialExpression } from './workflow-credential-expression.mjs'
import packageLock from '../../package-lock.json' with { type: 'json' }
import packageJson from '../../package.json' with { type: 'json' }

const require = createRequire(import.meta.url)
const lighthouseConfig = require('../../lighthouserc.js')

const workflowPath = '.github/workflows/lighthouse-ci.yml'
const workflow = readFileSync(workflowPath, 'utf8')
const parsed = parse(workflow)

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
  assert.equal(hasCredentialExpression('${{ github.sha }}'), false)
})

test('Lighthouse PR builds receive no repository or production secrets', () => {
  assert.equal(hasCredentialExpression(workflow), false)
  assert.deepEqual(parsed.permissions, { contents: 'read' })
  assert.equal(parsed.jobs.lighthouse.permissions, undefined)
  assert.equal(parsed.env.NEXT_PUBLIC_SUPABASE_URL, 'https://placeholder.supabase.co')
  assert.equal(parsed.env.SUPABASE_URL, 'https://placeholder.supabase.co')
  assert.match(parsed.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, /^ci-build-/)
  assert.match(parsed.env.SUPABASE_SERVICE_ROLE_KEY, /^ci-build-/)
  assert.match(parsed.env.CRON_SECRET, /^ci-build-/)
  assert.ok(parsed.env.CRON_SECRET.length >= 32)
  assert.equal(parsed.env.UPSTASH_REDIS_REST_URL, 'http://127.0.0.1:9')
  assert.match(parsed.env.UPSTASH_REDIS_REST_TOKEN, /^ci-runtime-/)
})

test('repository commands cannot inherit a persisted, cached, or later write credential', () => {
  const checkout = parsed.jobs.lighthouse.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/checkout@')
  )
  assert.ok(checkout)
  assert.equal(checkout.with.ref, '${{ github.sha }}')
  assert.equal(checkout.with['persist-credentials'], false)
  const setupNode = parsed.jobs.lighthouse.steps.find((step) =>
    String(step.uses ?? '').startsWith('actions/setup-node@')
  )
  assert.ok(setupNode)
  assert.equal(setupNode.with?.cache, undefined)
  const checkoutIndex = parsed.jobs.lighthouse.steps.indexOf(checkout)
  const firstRepositoryCommand = parsed.jobs.lighthouse.steps.findIndex(
    (step, index) => index > checkoutIndex && typeof step.run === 'string'
  )
  assert.ok(firstRepositoryCommand > checkoutIndex)
  for (const step of parsed.jobs.lighthouse.steps.slice(checkoutIndex + 1)) {
    assert.equal(hasCredentialExpression(step), false)
  }
  for (const step of parsed.jobs.lighthouse.steps.slice(firstRepositoryCommand)) {
    assert.equal(
      step.uses,
      undefined,
      'no action may be registered after repository-controlled commands begin'
    )
  }
  for (const step of parsed.jobs.lighthouse.steps.slice(
    checkoutIndex + 1,
    firstRepositoryCommand
  )) {
    if (step.uses) assert.match(step.uses, /^actions\/setup-node@[0-9a-f]{40}$/)
  }
})

test('every Lighthouse third-party action is pinned to an immutable commit', () => {
  const actions = parsed.jobs.lighthouse.steps
    .map((step) => step.uses)
    .filter((value) => typeof value === 'string')
  assert.ok(actions.length > 0)
  for (const action of actions) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/)
})

test('Lighthouse audits real pages repeatedly and fails on HTTP or score regressions', () => {
  const lighthouse = lighthouseConfig.ci
  assert.deepEqual(lighthouse.collect.url, [
    'http://127.0.0.1:3000/',
    'http://127.0.0.1:3000/methodology',
    'http://127.0.0.1:3000/about',
  ])
  assert.equal(lighthouse.collect.numberOfRuns, 3)
  assert.equal(lighthouse.collect.settings.preset, 'desktop')
  assert.equal(lighthouse.assert.assertions['http-status-code'], 'error')
  assert.equal(lighthouse.assert.assertions['categories:performance'][0], 'error')
  assert.equal(lighthouse.upload.target, 'filesystem')
  assert.equal(lighthouse.upload.outputDir, '.lighthouseci/reports')
})

test('Lighthouse readiness and execution fail closed without public upload', () => {
  const step = parsed.jobs.lighthouse.steps.find(
    (candidate) => candidate.name === 'Run Lighthouse CI'
  )
  assert.ok(step)
  assert.match(step.run, /set -euo pipefail/)
  assert.match(step.run, /export LHCI_ORIGIN="http:\/\/127\.0\.0\.1:\$\{LHCI_PORT\}"/)
  assert.match(step.run, /node \.\/node_modules\/next\/dist\/bin\/next start/)
  assert.match(step.run, /--hostname 127\.0\.0\.1/)
  assert.match(step.run, /curl --fail --silent --show-error/)
  assert.match(step.run, /if \[ "\$ready" -ne 1 \]/)
  assert.match(step.run, /kill -0 "\$SERVER_PID"/)
  assert.match(step.run, /trap cleanup_server EXIT INT TERM/)
  assert.match(step.run, /npx --no-install lhci collect/)
  assert.match(step.run, /npx --no-install lhci assert/)
  assert.doesNotMatch(step.run, /autorun|lhci upload|--no-sandbox/)
  assert.equal(packageJson.devDependencies['@lhci/cli'], '0.15.1')
  assert.equal(packageLock.packages['node_modules/@lhci/cli'].version, '0.15.1')
  assert.equal(packageJson.overrides.tmp, '0.2.7')
  assert.deepEqual(
    Object.entries(packageLock.packages)
      .filter(([path]) => path === 'node_modules/tmp' || path.endsWith('/node_modules/tmp'))
      .map(([path, metadata]) => [path, metadata.version]),
    [['node_modules/tmp', '0.2.7']]
  )
})

test('Lighthouse origin override accepts only a credential-free loopback HTTP origin', () => {
  const command = [
    '-e',
    "process.stdout.write(require('./lighthouserc.js').ci.collect.url.join('\\n'))",
  ]
  const accepted = spawnSync(process.execPath, command, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, LHCI_ORIGIN: 'http://127.0.0.1:43117' },
  })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(
    accepted.stdout,
    [
      'http://127.0.0.1:43117/',
      'http://127.0.0.1:43117/methodology',
      'http://127.0.0.1:43117/about',
    ].join('\n')
  )

  for (const unsafeOrigin of [
    'https://127.0.0.1:43117',
    'http://localhost:43117',
    'http://user:password@127.0.0.1:43117',
    'http://127.0.0.1:43117/prefix',
    'http://example.com:43117',
  ]) {
    const rejected = spawnSync(process.execPath, command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, LHCI_ORIGIN: unsafeOrigin },
    })
    assert.notEqual(rejected.status, 0, unsafeOrigin)
    assert.match(rejected.stderr, /Invalid LHCI_ORIGIN/)
  }
})
