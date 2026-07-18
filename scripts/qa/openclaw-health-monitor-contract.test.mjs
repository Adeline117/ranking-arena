import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  findStaleActivePlatforms,
  getActiveFetcherFailures,
} from '../openclaw/health-monitor-contract.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

test('registry-backed health evaluates revived active sources', () => {
  const stale = findStaleActivePlatforms([
    { platform: 'lbank', ageHours: 60, status: 'critical' },
    { platform: 'kucoin', ageHours: null, status: 'critical' },
    { platform: 'gateio', ageHours: 2, status: 'healthy' },
    { platform: 'blofin', ageHours: 13, status: 'warning' },
  ])

  assert.deepEqual(stale, [
    { platform: 'lbank', ageHours: 60, thresholdHours: 48 },
    { platform: 'kucoin', ageHours: null, thresholdHours: 48 },
    { platform: 'blofin', ageHours: 13, thresholdHours: 12 },
  ])
})

test('invalid ages fail closed as missing data', () => {
  const stale = findStaleActivePlatforms([
    { platform: 'phemex', ageHours: Number.NaN },
    { platform: 'bitget_spot', ageHours: -1 },
  ])

  assert.deepEqual(stale, [
    { platform: 'phemex', ageHours: null, thresholdHours: 48 },
    { platform: 'bitget_spot', ageHours: null, thresholdHours: 48 },
  ])
})

test('auto-fix accepts exact active sources and rejects group job aliases', () => {
  const failures = getActiveFetcherFailures({
    platformHealth: [{ platform: 'lbank' }, { platform: 'bybit' }],
    recentFailures: [
      { job_name: 'fetch-traders-lbank', error_message: 'timeout' },
      { job_name: 'batch-fetch-traders-bybit', error_message: '429' },
      { job_name: 'batch-fetch-traders-a1', error_message: 'timeout' },
      { job_name: 'fetch-traders-retired', error_message: '404' },
    ],
  })

  assert.deepEqual(failures, [
    { platform: 'lbank', errorMessage: 'timeout' },
    { platform: 'bybit', errorMessage: '429' },
  ])
})

test('obsolete scraper sentinel cannot return through workflow drift', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/openclaw-sentinels.yml'), 'utf8')

  assert.doesNotMatch(workflow, /scraper-health|check-scraper-health/)
  assert.equal(existsSync(join(repoRoot, 'scripts/openclaw/check-scraper-health.mjs')), false)
})

test('OpenClaw workflow installs deterministically and propagates hard failures', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/openclaw-sentinels.yml'), 'utf8')

  assert.doesNotMatch(workflow, /npm ci[^\n]*\|\|[^\n]*npm install/)
  assert.equal((workflow.match(/run: npm ci --ignore-scripts/g) || []).length, 9)

  // Only the three independent checks in the shared pipeline-health job may
  // continue so all of them get evidence. Their outcomes are aggregated into
  // a final red job instead of being silently converted to green.
  assert.equal((workflow.match(/continue-on-error:\s*true/g) || []).length, 3)
  for (const id of ['pipeline-health-monitor', 'trust-scorecard-snapshot', 'db-size-sentinel']) {
    assert.match(workflow, new RegExp(`id: ${id}`))
    assert.match(workflow, new RegExp(`steps\\.${id}\\.outcome`))
  }
  assert.match(workflow, /name: Propagate sentinel failures/)
  assert.match(workflow, /echo "::error::Failed sentinels:/)
})
