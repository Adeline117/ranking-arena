import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
const unitTests = workflow.jobs['unit-tests']
const coverage = unitTests.steps.find((step) => step.name === 'Run tests with coverage')

test('CI coverage uses the proven bounded worker budget and isolated Redis database', () => {
  assert.ok(coverage)
  assert.match(coverage.run, /--coverage(?:\s|$)/)
  assert.match(coverage.run, /--ci(?:\s|$)/)
  assert.match(coverage.run, /--maxWorkers=2(?:\s|$)/)
  assert.equal(coverage.env.WORKER_OWNERSHIP_REDIS_TEST_URL, 'redis://127.0.0.1:6379/15')
  assert.equal(
    unitTests.services['worker-ownership-redis'].image.includes('redis:7.4.9-alpine@'),
    true
  )
})
