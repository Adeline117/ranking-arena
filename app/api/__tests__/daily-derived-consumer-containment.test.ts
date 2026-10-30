/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GET as getEquity } from '@/app/api/traders/[handle]/equity/route'
import { GET as getIndicators } from '@/app/api/traders/[handle]/indicators/route'
import { GET as getHistory } from '@/app/api/trader/[platform]/[trader_key]/history/route'

const root = process.cwd()
const routeFiles = [
  'app/api/traders/[handle]/equity/route.ts',
  'app/api/traders/[handle]/indicators/route.ts',
  'app/api/trader/[platform]/[trader_key]/history/route.ts',
  'app/api/recommendations/hot/route.ts',
]

describe('unproven daily-derived public consumers', () => {
  it.each([
    ['equity', getEquity, 'DAILY_SERIES_NOT_PUBLISHED'],
    ['indicators', getIndicators, 'DAILY_INDICATORS_NOT_PUBLISHED'],
    ['history', getHistory, 'TRADER_HISTORY_NOT_PUBLISHED'],
  ] as const)(
    '%s returns a fixed unavailable, non-cacheable envelope',
    async (_name, get, code) => {
      const response = get()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe(
        'private, no-store, max-age=0, must-revalidate'
      )
      expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
      expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
      expect(body).toMatchObject({
        available: false,
        code,
        reason: 'snapshot_provenance_unverified',
        publication: null,
      })
    }
  )

  it('exposes no legacy daily read, data client, or publication cache path', () => {
    for (const file of routeFiles) {
      const route = readFileSync(join(root, file), 'utf8')
      expect(route).not.toContain('getSupabaseAdmin')
      expect(route).not.toContain('trader_daily_snapshots')
      expect(route).not.toContain('getServerCache')
      expect(route).not.toContain('tieredGetOrSet')
      expect(route).not.toContain('publicRankingCacheKey')
      expect(route).toContain("export const dynamic = 'force-dynamic'")
      expect(route).toContain('export const revalidate = 0')
    }
  })

  it('labels the sole admin count as non-authoritative forensic inventory', () => {
    const route = readFileSync(join(root, 'app/api/admin/observability/route.ts'), 'utf8')

    expect(route).toContain("authority: 'none' as const")
    expect(route).toContain("publicationState: 'quarantined' as const")
    expect(route).toContain("producerState: 'retired' as const")
    expect(route).toContain("? ('unknown' as const)")
    expect(route).toContain('estimatedRows: dailyInventoryResult?.count ?? null')
    expect(route).not.toContain(
      'tableSizes[tableNames[i]] = seasonResults[seasons.length + i]?.count ?? 0'
    )
  })

  it('rejects legacy equity cache bodies at the React Query boundary', () => {
    const hook = readFileSync(join(root, 'lib/hooks/useSWR.ts'), 'utf8')
    const functionStart = hook.indexOf('export function useTraderEquity(')
    const functionEnd = hook.indexOf('\n}\n\ninterface PositionsResponse', functionStart)
    const equityHook = hook.slice(functionStart, functionEnd)

    expect(functionStart).toBeGreaterThan(-1)
    expect(functionEnd).toBeGreaterThan(functionStart)
    expect(equityHook).toContain("queryKey: ['trader-equity', 'daily-publication-v1', handle]")
    expect(equityHook).toContain('acceptPublishedEquity(await fetcher<unknown>(url))')
    expect(equityHook).not.toContain('placeholderData')
  })

  it('epochs cached profile statistics after removing legacy daily-derived claims', () => {
    const traderQueries = readFileSync(join(root, 'lib/data/trader-queries.ts'), 'utf8')

    expect(traderQueries).toContain("CacheKey.traders.detail(handle) + ':stats:v2'")
    expect(traderQueries).not.toContain(".from('trader_daily_snapshots')")
    expect(traderQueries).toContain('activeSince: undefined')
    expect(traderQueries).toContain('profitableWeeksPct: undefined')
  })

  it('keeps every product series empty while unavailable', async () => {
    await expect(getEquity().json()).resolves.toMatchObject({
      contract: 'arena.daily-history-publication@1',
      equity: [],
      pnl: [],
      drawdown: [],
    })
    await expect(getIndicators().json()).resolves.toMatchObject({
      contract: 'arena.daily-history-publication@1',
      timestamps: [],
      rsi: [],
    })
    await expect(getHistory().json()).resolves.toMatchObject({
      contract: 'arena.trader-history-evidence@2',
      usage: 'forensic_only',
      provenance: 'unverified',
      derivedMetricsAllowed: false,
      history: { '7D': [], '30D': [], '90D': [] },
    })
  })

  // Hot recommendations use the sealed-view probe (lib/recommendations/hot-score.ts);
  // its fail-closed empty, no-store envelope is asserted in
  // app/api/recommendations/hot/__tests__/route.test.ts. The route still stays
  // in `routeFiles` above, so it cannot regain a legacy daily read or cache path.
})
