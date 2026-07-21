import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { validateReleaseHealth } from '../ci/validate-release-health.mjs'

const root = path.resolve(import.meta.dirname, '../..')

function health({ status = 'healthy', freshness = 'pass', message } = {}) {
  return {
    status,
    commit: 'b2777c7d6d56537f0615bac3d51ee51269f2b8cd',
    checks: {
      api: { status: 'pass' },
      database: { status: 'pass' },
      redis: { status: 'pass' },
      freshness: { status: freshness, ...(message ? { message } : {}) },
    },
  }
}

test('accepts healthy releases and a structured freshness-only degradation', () => {
  assert.equal(validateReleaseHealth(health()).safe, true)

  const result = validateReleaseHealth(
    health({
      status: 'degraded',
      freshness: 'fail',
      message: '13/32 sources fresh; 4 stale; 15 critical; 0 unknown',
    })
  )
  assert.equal(result.safe, true)
  assert.match(result.reason, /13\/32 sources fresh/)
})

test('fails closed for authority, runtime, count, and payload failures', () => {
  const cases = [
    null,
    {},
    health({ status: 'unhealthy', freshness: 'fail', message: '0/32 sources fresh' }),
    health({ status: 'degraded', freshness: 'fail', message: 'Freshness authority unavailable' }),
    health({
      status: 'degraded',
      freshness: 'fail',
      message: '13/32 sources fresh; 4 stale; 14 critical; 0 unknown',
    }),
  ]
  const redisFailure = health({
    status: 'degraded',
    freshness: 'fail',
    message: '13/32 sources fresh; 4 stale; 15 critical; 0 unknown',
  })
  redisFailure.checks.redis.status = 'fail'
  cases.push(redisFailure)

  for (const candidate of cases) assert.equal(validateReleaseHealth(candidate).safe, false)
})

test('CLI returns a bounded decision without echoing the full health payload', () => {
  const payload = health({
    status: 'degraded',
    freshness: 'fail',
    message: '13/32 sources fresh; 4 stale; 15 critical; 0 unknown',
  })
  payload.private_detail = 'must-not-be-echoed'
  const accepted = spawnSync('node', ['scripts/ci/validate-release-health.mjs'], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.match(accepted.stdout, /degraded: core release checks pass/)
  assert.doesNotMatch(accepted.stdout, /must-not-be-echoed/)

  const rejected = spawnSync('node', ['scripts/ci/validate-release-health.mjs'], {
    cwd: root,
    input: '{not-json',
    encoding: 'utf8',
  })
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /not valid JSON/)
})

test('deploy smoke and rollback use the same release-health authority', () => {
  const smoke = fs.readFileSync(path.join(root, 'scripts/post-deploy-check.sh'), 'utf8')
  const gate = fs.readFileSync(path.join(root, '.github/workflows/deploy-gate.yml'), 'utf8')

  assert.match(smoke, /node scripts\/ci\/validate-release-health\.mjs/)
  assert.doesNotMatch(smoke, /\[ "\$HEALTH_STATE" = "healthy" \]/)
  assert.match(gate, /install -m 700 scripts\/ci\/validate-release-health\.mjs/)
  assert.match(gate, /node "\$RUNNER_TEMP\/validate-release-health\.mjs"/)
  assert.match(gate, /"\$HEALTH_HTTP" = "202"/)
  assert.match(gate, /\[ "\$HEALTH_SAFE" = "true" \]/)
})
