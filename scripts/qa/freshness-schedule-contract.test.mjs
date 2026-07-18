import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const vercelConfig = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
const crons = vercelConfig.crons ?? []
const metaMonitor = readFileSync(join(root, 'app/api/cron/meta-monitor/route.ts'), 'utf8')

const FRESHNESS_PATH = '/api/cron/check-data-freshness'
const FRESHNESS_SCHEDULE = '39 1,4,7,10,13,16,19,22 * * *'

test('registers exactly one three-hour freshness schedule without exceeding Vercel quota', () => {
  const definitions = crons.filter((cron) => cron.path === FRESHNESS_PATH)
  assert.deepEqual(definitions, [{ path: FRESHNESS_PATH, schedule: FRESHNESS_SCHEDULE }])
  assert.ok(crons.length <= 100, `expected at most 100 Vercel crons, found ${crons.length}`)

  const [minute, hourList, dayOfMonth, month, dayOfWeek] = FRESHNESS_SCHEDULE.split(' ')
  assert.equal(minute, '39')
  assert.deepEqual([dayOfMonth, month, dayOfWeek], ['*', '*', '*'])

  const fireMinutes = hourList.split(',').map((hour) => Number(hour) * 60 + Number(minute))
  assert.equal(fireMinutes.length, 8)
  const wrapped = [...fireMinutes, fireMinutes[0] + 24 * 60]
  assert.deepEqual(
    wrapped.slice(1).map((value, index) => value - wrapped[index]),
    Array(8).fill(180)
  )
})

test('keeps the six-hour meta-monitor aligned to a 180-minute freshness expectation', () => {
  assert.deepEqual(
    crons.filter((cron) => cron.path === '/api/cron/meta-monitor'),
    [{ path: '/api/cron/meta-monitor', schedule: '23 */6 * * *' }]
  )
  assert.match(metaMonitor, /['"]check-data-freshness['"]:\s*180/)
  assert.match(metaMonitor, /findStuckCronJobs\(statuses, EXPECTED_INTERVALS\)/)
})
