import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE_CRON_ROUTES = [
  'app/api/cron/snapshot-ranks/route.ts',
  'app/api/cron/compute-leaderboard-watchdog/route.ts',
  'app/api/cron/health-check-all/route.ts',
  'app/api/cron/scan-data-quality/route.ts',
  'app/api/cron/worker-heartbeat-check/route.ts',
  'app/api/cron/meta-monitor/route.ts',
  'app/api/cron/sync-ranking-store/route.ts',
  'app/api/cron/ensure-partitions/route.ts',
  'app/api/cron/retry-dead-letters/route.ts',
  'app/api/cron/data-reconciliation/route.ts',
  'app/api/cron/score-backtest/route.ts',
  'app/api/cron/sync-authorized-traders/route.ts',
  'app/api/cron/warm-cache/route.ts',
  'app/api/cron/api-tier-payment-reconciliation/route.ts',
  'app/api/cron/cleanup-deleted-accounts/route.ts',
  'app/api/cron/reconcile-subscriptions/route.ts',
  'app/api/cron/subscription-expiry/route.ts',
  'app/api/cron/weekly-digest/route.ts',
  'app/api/cron/expire-mutes/route.ts',
] as const

describe('core cron safety budgets', () => {
  it.each(CORE_CRON_ROUTES)('%s fires before its serverless runtime limit', (relativePath) => {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8')
    const maxDurationSeconds = Number(source.match(/export const maxDuration = (\d+)/)?.[1])
    const safetyTimeoutMs = Number(
      source.match(/safetyTimeoutMs: ([\d_]+)/)?.[1].replaceAll('_', '')
    )

    expect(maxDurationSeconds).toBeGreaterThan(0)
    expect(safetyTimeoutMs).toBeGreaterThan(0)
    expect(safetyTimeoutMs).toBeLessThan(maxDurationSeconds * 1_000)
    expect(maxDurationSeconds * 1_000 - safetyTimeoutMs).toBeGreaterThanOrEqual(5_000)
  })

  it('bounds both warm-cache self-requests inside the route budget', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/cron/warm-cache/route.ts'), 'utf8')

    expect(source).toContain('const warmupSignal = AbortSignal.timeout(8_000)')
    expect(source.match(/signal: warmupSignal/g)).toHaveLength(2)
  })
})
