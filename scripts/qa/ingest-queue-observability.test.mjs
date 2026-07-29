import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = readFileSync('worker/src/dashboard.ts', 'utf8')
const queueState = readFileSync('scripts/ingest-queue-state.mts', 'utf8')

test('Bull Board exposes every bulk, fast-lane, and Tier-C region queue', () => {
  const bulk = dashboard.indexOf('new BullMQAdapter(getRegionQueue(region))')
  const fast = dashboard.indexOf('new BullMQAdapter(getFastQueue(region))')
  const tierC = dashboard.indexOf('new BullMQAdapter(getTierCQueue(region))')

  assert.ok(bulk >= 0)
  assert.ok(fast > bulk)
  assert.ok(tierC > fast)
})

test('queue-state CLI reports and closes every queue class', () => {
  const bulk = queueState.indexOf('{ label: region, queue: getRegionQueue(region) }')
  const fast = queueState.indexOf('{ label: `fast/${region}`, queue: getFastQueue(region) }')
  const tierC = queueState.indexOf('{ label: `tierc/${region}`, queue: getTierCQueue(region) }')

  assert.ok(bulk >= 0)
  assert.ok(fast > bulk)
  assert.ok(tierC > fast)
  assert.match(queueState, /await Promise\.allSettled\(queues\.map/)
  assert.match(queueState, /await closeConnection\(\)/)
  assert.doesNotMatch(queueState, /process\.exit\(/)
})
