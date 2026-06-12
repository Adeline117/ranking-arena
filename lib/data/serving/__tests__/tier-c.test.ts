/**
 * Tier-C bridge tests: key-builder parity with the worker module (the two
 * are duplicated on purpose — this test is the sync guard) and result
 * payload → TraderCoreModules mapping.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { tierCJobId, tierCResultKey, coreModulesFromTierC } from '../tier-c'

describe('tier-c key builders stay in sync with worker/src/ingest/queues', () => {
  // Importing the worker module would drag bullmq (untransformed ESM) into
  // jest, so the parity guard asserts on the worker SOURCE text instead.
  const workerSource = readFileSync(
    join(__dirname, '../../../../worker/src/ingest/queues.ts'),
    'utf8'
  )
  const req = {
    sourceSlug: 'bitget_futures',
    exchangeTraderId: 'beb24d718eb23b54ac91',
    timeframe: 30 as const,
    surface: 'profile' as const,
  }

  it('jobId template parity (no ":" — BullMQ rejects colon custom ids)', () => {
    expect(tierCJobId(req)).toBe('tierc--bitget_futures--beb24d718eb23b54ac91--30--profile')
    expect(tierCJobId(req)).not.toContain(':')
    expect(workerSource).toContain(
      "['tierc', d.sourceSlug, d.exchangeTraderId, d.timeframe, d.surface].join('--')"
    )
  })

  it('result key template parity', () => {
    expect(tierCResultKey(req)).toBe('arena:live:bitget_futures:beb24d718eb23b54ac91:30:profile')
    expect(workerSource).toContain(
      '`arena:live:${d.sourceSlug}:${d.exchangeTraderId}:${d.timeframe}:${d.surface}`'
    )
  })
})

describe('coreModulesFromTierC', () => {
  const payload = {
    currency: 'USDT',
    asOf: '2026-06-10T12:00:00Z',
    stats: [
      {
        timeframe: 30,
        asOf: '2026-06-10T12:00:00Z',
        roi: 22.1,
        pnl: 5000,
        sharpe: null,
        mdd: 12.3,
        winRate: 58,
        winPositions: 116,
        totalPositions: 200,
        copierPnl: 900,
        copierCount: 28,
        aum: 80000,
        volume: null,
        profitShareRate: 10,
        holdingDurationAvgHours: null,
        tradingPreferences: { BTCUSDT: 0.6 },
        extras: { style_tags: ['steady'] },
      },
    ],
    series: [
      { timeframe: 30, metric: 'roi', points: [{ ts: '2026-06-09T00:00:00Z', value: 1.2 }] },
      { timeframe: 7, metric: 'roi', points: [{ ts: '2026-06-09T00:00:00Z', value: 9 }] },
    ],
  }

  it('maps camelCase ParsedStats to superset snake_case keys, NULL-collapsed', () => {
    const core = coreModulesFromTierC('bitget_futures', 30, payload)
    expect(core).not.toBeNull()
    expect(core!.stats).toEqual({
      roi: 22.1,
      pnl: 5000,
      mdd: 12.3,
      win_rate: 58,
      win_positions: 116,
      total_positions: 200,
      copier_pnl: 900,
      copier_count: 28,
      aum: 80000,
      profit_share_rate: 10,
    })
    expect('sharpe' in core!.stats).toBe(false) // NULL = not exposed, dropped
    expect(core!.extras.trading_preferences).toEqual({ BTCUSDT: 0.6 })
    expect(core!.extras.style_tags).toEqual(['steady'])
    expect(core!.cacheState).toBe('cold-fetched')
    expect(core!.timeframe).toBe(30)
  })

  it('only includes series for the requested timeframe', () => {
    const core = coreModulesFromTierC('bitget_futures', 30, payload)
    expect(core!.series.roi).toEqual([{ ts: '2026-06-09T00:00:00Z', value: 1.2 }])
  })

  it('returns null when the payload has no stats rows', () => {
    expect(coreModulesFromTierC('bitget_futures', 30, { stats: [], series: [] })).toBeNull()
  })
})
