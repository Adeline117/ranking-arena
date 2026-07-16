/**
 * Board-level "free series" contract (spec §13.1): five adapters embed a
 * per-trader cumulative ROI/PnL sparkline IN the leaderboard row, so every
 * ranked trader gets a chart at zero extra fetch cost. These tests assert
 * parseLeaderboardSeries decodes real RAW board fixtures into well-formed
 * SeriesPoint blocks (ISO ts, finite value, correct timeframe/metric).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { BoardSeriesBlock, ParseCtx, RankingTimeframe } from '../../core/types'
import { parseOkxLeaderboardSeries } from '../okx/parsers'
import { parseToobitLeaderboardSeries } from '../toobit/parsers'
import { parseXtLeaderboardSeries } from '../xt/parsers'
import { parseBlofinLeaderboardSeries } from '../blofin/parsers'
import { parseBitunixLeaderboardSeries } from '../bitunix/parsers'
import { parseBinanceWeb3LeaderboardSeries } from '../binance-web3/parsers'

function fixture(adapter: string, name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', adapter, '__tests__', 'fixtures', name), 'utf8')
  )
}

const ctx: ParseCtx = {
  sourceSlug: 'x',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-12T00:00:00.000Z',
  meta: {},
}

/** Shared well-formedness assertions for one (id → blocks) map. */
function assertWellFormed(
  map: Map<string, BoardSeriesBlock[]>,
  expectTf: RankingTimeframe,
  expectMetrics: string[],
  replaceSeries = false
): void {
  expect(map.size).toBeGreaterThan(0)
  for (const [id, blocks] of map) {
    expect(id.length).toBeGreaterThan(0)
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block.timeframe).toBe(expectTf)
      expect(expectMetrics).toContain(block.metric)
      expect(block.points.length).toBeGreaterThan(0)
      expect(block.replaceSeries).toBe(replaceSeries ? true : undefined)
      // monotonic ISO ascending + finite values
      let prev = ''
      for (const p of block.points) {
        expect(typeof p.ts).toBe('string')
        expect(new Date(p.ts).toISOString()).toBe(p.ts) // valid ISO
        expect(p.ts >= prev).toBe(true)
        prev = p.ts
        expect(Number.isFinite(p.value)).toBe(true)
      }
    }
  }
}

describe('okx parseLeaderboardSeries (pnlRatios → roi)', () => {
  it('decodes board sparkline for every ranked trader', () => {
    const map = parseOkxLeaderboardSeries(fixture('okx', 'board-page.json'), ctx, 90)
    assertWellFormed(map, 90, ['roi'])
  })
})

describe('toobit parseLeaderboardSeries (leaderTradeProfit → roi)', () => {
  it('decodes board sparkline for every ranked trader', () => {
    const map = parseToobitLeaderboardSeries(fixture('toobit', 'board-page.json'), ctx, 30)
    assertWellFormed(map, 30, ['roi'])
  })
})

describe('xt parseLeaderboardSeries (chart → pnl)', () => {
  it('decodes cumulative-income chart, dropping the epoch-0 seed', () => {
    const map = parseXtLeaderboardSeries(fixture('xt', 'leaderboard-fut-30.json'), ctx, 30)
    assertWellFormed(map, 30, ['pnl'], true)
    // epoch-0 placeholder must never leak into points
    for (const blocks of map.values())
      for (const b of blocks)
        for (const p of b.points) {
          expect(new Date(p.ts).getTime()).toBeGreaterThan(0)
        }
  })
})

describe('blofin parseLeaderboardSeries (chart_data.roi → roi)', () => {
  it('decodes cumulative-ROI chart for every ranked trader', () => {
    const map = parseBlofinLeaderboardSeries(fixture('blofin', 'board-fut-30.json'), ctx, 30)
    assertWellFormed(map, 30, ['roi'])
  })
})

describe('bitunix parseLeaderboardSeries (dailyWinRate → roi)', () => {
  it('decodes daily cumulative ROI for every ranked trader', () => {
    const map = parseBitunixLeaderboardSeries(
      fixture('bitunix', 'trader-list-30d-p1.json'),
      ctx,
      30
    )
    assertWellFormed(map, 30, ['roi', 'pnl'])
  })
})

describe('binance web3 parseLeaderboardSeries (dailyPNL → pnl_daily + cumulative pnl)', () => {
  it('decodes native daily and chart-ready cumulative PnL for every ranked wallet', () => {
    const map = parseBinanceWeb3LeaderboardSeries(
      fixture('binance-web3', 'board-page.json'),
      ctx,
      7
    )
    assertWellFormed(map, 7, ['pnl_daily', 'pnl'])
    for (const blocks of map.values()) {
      expect(blocks.map((block) => block.metric).sort()).toEqual(['pnl', 'pnl_daily'])
    }
  })
})

describe('adapters without inline board series', () => {
  it('omit parseLeaderboardSeries entirely (no-cost opt-out)', async () => {
    const { getAdapter } = await import('../../core/adapter')
    await import('../register') // populate the registry
    // bitget has no inline board series — must not implement the optional hook
    expect(getAdapter('bitget').parseLeaderboardSeries).toBeUndefined()
    // the six that do, implement it
    for (const slug of ['okx', 'toobit', 'xt', 'blofin', 'bitunix', 'binance_web3']) {
      expect(typeof getAdapter(slug).parseLeaderboardSeries).toBe('function')
    }
  })
})
