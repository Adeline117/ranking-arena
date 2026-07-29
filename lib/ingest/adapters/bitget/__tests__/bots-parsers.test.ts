import { readFileSync } from 'fs'
import { join } from 'path'
import {
  assertBitgetBotsLeaderboardPublication,
  parseBitgetBotsBoardPage,
  parseBitgetBotsCopiers,
  parseBitgetBotsProfile,
} from '../bots-parsers'
import type { ParseCtx, ParsedLeaderboardRow, SourceRow } from '../../../core/types'

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))
}

const ctx: ParseCtx = {
  sourceSlug: 'bitget_bots_futures',
  currency: 'USDT',
  tfLabelMap: {},
  scrapedAt: '2026-06-11T00:00:00.000Z',
  meta: {},
}

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 41,
    slug: 'bitget_bots_futures',
    exchange_id: 5,
    product_type: 'futures',
    trader_kind_scope: 'bot',
    adapter_slug: 'bitget_bots',
    leaderboard_url: 'https://www.bitget.com/zh-CN/copy-trading/bot',
    timeframes_native: [30],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 180,
    deep_profile_topn: 200,
    positions_topn: 0,
    profile_cache_ttl: '01:00:00',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: 20,
    pagination_kind: 'numeric',
    cadence_tier_a: '01:00:00',
    cadence_tier_b: '06:00:00',
    cadence_tier_d: '01:00:00',
    fetch_region: 'local',
    rate_budget_ms: 0,
    phase: 0,
    serving_mode: 'serving',
    status: 'active',
    meta: {
      boards: ['futures_grid', 'futures_martingale'],
      inception_tf: true,
    },
    ...overrides,
  }
}

function clonedBoardFixture(name: string): { data: { data: Array<Record<string, unknown>> } } {
  return JSON.parse(JSON.stringify(fixture(name))) as {
    data: { data: Array<Record<string, unknown>> }
  }
}

function fullFuturesRows(): ParsedLeaderboardRow[] {
  const grid = parseBitgetBotsBoardPage(
    { board: 'futures_grid', payload: fixture('bots-board-futures-grid.json') },
    ctx
  ).rows
  const martingalePayload = clonedBoardFixture('bots-board-futures-grid.json')
  for (const card of martingalePayload.data.data) {
    card.strategyType = 4
    card.strategyId = `${String(card.strategyId)}4`
  }
  const martingale = parseBitgetBotsBoardPage(
    { board: 'futures_martingale', payload: martingalePayload },
    ctx
  ).rows.map((row, index) => ({ ...row, rank: grid.length + index + 1 }))
  return [...grid, ...martingale]
}

function publicationResult(rows = fullFuturesRows()) {
  return { parsedRows: rows, validRows: rows, rejectedRowCount: 0 }
}

describe('parseBitgetBotsBoardPage (live-captured fixtures, 2026-06-11)', () => {
  it('parses futures grid cards into shadow-trader rows with bot meta', () => {
    const page = parseBitgetBotsBoardPage(
      { board: 'futures_grid', payload: fixture('bots-board-futures-grid.json') },
      ctx
    )
    expect(page.reportedTotal).toBe(100)
    expect(page.rows).toHaveLength(20)
    const first = page.rows[0]
    expect(first.traderKind).toBe('bot')
    expect(first.botStrategy).toBe('grid')
    expect(first.exchangeTraderId).toMatch(/^\d+$/) // strategyId
    expect(first.nickname).toBe('RIVERUSDT') // pair is the card title
    expect(first.headlineRoi).toBeNull()
    expect(first.headlinePnl).toBeNull()
    expect(first.raw).toEqual({
      strategyId: first.exchangeTraderId,
      strategyType: 2,
      productId: expect.any(String),
      strAccountId: expect.any(String),
      status: expect.any(String),
    })
    expect(first.raw).not.toHaveProperty('profitRate')
    expect(first.raw).not.toHaveProperty('profitAmount')
    expect(first.headlineWinRate).toBeNull()
    // 最大回撤 now captured from thirtyMaxDrawdown (was dropped) — spec §11.5
    expect(typeof first.headlineMdd).toBe('number')
    const bot = first.traderMeta?.bot as Record<string, unknown>
    expect(bot).toMatchObject({
      exchange_bot_id: first.exchangeTraderId,
      pair: 'RIVERUSDT',
      product_type: 'futures',
      strategy: 'grid',
      direction: 'long',
      profit_share_rate: 30,
    })
    expect(bot.owner_account_id).toMatch(/^b/)
    expect(typeof bot.runtime_days).toBe('number')
    expect(bot.created_at_origin).toMatch(/Z$/)
  })

  it('parses spot martingale cards with the right strategy/product split', () => {
    const page = parseBitgetBotsBoardPage(
      { board: 'spot_martingale', payload: fixture('bots-board-spot-martingale.json') },
      ctx
    )
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.rows[0].botStrategy).toBe('martingale')
    const bot = page.rows[0].traderMeta?.bot as Record<string, unknown>
    expect(bot.product_type).toBe('spot')
  })

  it('rejects malformed envelopes instead of treating them as empty boards', () => {
    expect(() => parseBitgetBotsBoardPage(null, ctx)).toThrow('board page wrapper')
    expect(() => parseBitgetBotsBoardPage({ board: 'futures_grid', payload: {} }, ctx)).toThrow(
      'response code must be 200'
    )
  })

  it('parses the exact V4 partition projection while rejecting envelope drift', () => {
    const payload = fixture('bots-board-futures-grid.json')
    const envelope = {
      data_contract: 'arena.ingest.partitioned-numeric-parser-page@1',
      partition_id: 'futures_grid',
      request_page_index: 1,
      request_page_size: 20,
      payload,
    }
    expect(parseBitgetBotsBoardPage(envelope, ctx).rows).toHaveLength(20)
    expect(() =>
      parseBitgetBotsBoardPage({ ...envelope, partition_id: 'futures_martingale' }, ctx)
    ).toThrow('board identity and card strategyType must match')
    expect(() => parseBitgetBotsBoardPage({ ...envelope, unexpected: true }, ctx)).toThrow(
      'fields must match the reviewed contract exactly'
    )
    expect(() =>
      parseBitgetBotsBoardPage(
        { ...envelope, data_contract: 'arena.ingest.partitioned-numeric-parser-page@2' },
        ctx
      )
    ).toThrow('data contract is unsupported')

    for (const request_page_index of ['1', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseBitgetBotsBoardPage({ ...envelope, request_page_index }, ctx)).toThrow(
        'request_page_index must be a positive safe-integer number'
      )
    }
    for (const request_page_size of ['20', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseBitgetBotsBoardPage({ ...envelope, request_page_size }, ctx)).toThrow(
        'request_page_size must be a positive safe-integer number'
      )
    }
  })

  it('fails closed instead of silently swallowing cards without exact board identity', () => {
    const missingBoard = clonedBoardFixture('bots-board-futures-grid.json')
    expect(() => parseBitgetBotsBoardPage({ payload: missingBoard }, ctx)).toThrow('wrapper.board')

    const missingId = clonedBoardFixture('bots-board-futures-grid.json')
    delete missingId.data.data[0].strategyId
    expect(() =>
      parseBitgetBotsBoardPage({ board: 'futures_grid', payload: missingId }, ctx)
    ).toThrow('every board card requires a decimal strategyId string')

    const crossedStrategy = clonedBoardFixture('bots-board-futures-grid.json')
    crossedStrategy.data.data[0].strategyType = 4
    expect(() =>
      parseBitgetBotsBoardPage({ board: 'futures_grid', payload: crossedStrategy }, ctx)
    ).toThrow('board identity and card strategyType must match')

    const wrongPage = clonedBoardFixture('bots-board-futures-grid.json')
    expect(() =>
      parseBitgetBotsBoardPage(
        {
          board: 'futures_grid',
          requestPageIndex: 2,
          requestPageSize: 20,
          payload: wrongPage,
        },
        ctx
      )
    ).toThrow('pageNo must match its exact request')

    const falseTerminal = clonedBoardFixture('bots-board-futures-grid.json')
    falseTerminal.data.data.splice(10)
    expect(() =>
      parseBitgetBotsBoardPage(
        {
          board: 'futures_grid',
          requestPageIndex: 1,
          requestPageSize: 20,
          payload: falseTerminal,
        },
        ctx
      )
    ).toThrow('must exactly cover totalRecord')
  })
})

describe('assertBitgetBotsLeaderboardPublication', () => {
  it('accepts one complete canonical 30D product board', () => {
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(), source(), 30)
    ).not.toThrow()
  })

  it('rejects rejected, deduplicated, empty, or missing-partition populations', () => {
    const complete = fullFuturesRows()
    expect(() =>
      assertBitgetBotsLeaderboardPublication(
        { parsedRows: complete, validRows: complete, rejectedRowCount: 1 },
        source(),
        30
      )
    ).toThrow('zero rejected rows')
    expect(() =>
      assertBitgetBotsLeaderboardPublication(
        { parsedRows: complete, validRows: complete.slice(1), rejectedRowCount: 0 },
        source(),
        30
      )
    ).toThrow('changed the board population')
    expect(() =>
      assertBitgetBotsLeaderboardPublication(
        { parsedRows: [], validRows: [], rejectedRowCount: 0 },
        source(),
        30
      )
    ).toThrow('cannot be empty')
    const gridOnly = complete.filter((row) => row.botStrategy === 'grid')
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(gridOnly), source(), 30)
    ).toThrow('both configured strategy partitions')
  })

  it('validates partial upstream-error evidence without claiming a complete publication', () => {
    const gridOnly = fullFuturesRows().filter((row) => row.botStrategy === 'grid')
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(gridOnly), source(), 30, {
        purpose: 'evidence_only',
      })
    ).not.toThrow()
    expect(() =>
      assertBitgetBotsLeaderboardPublication(
        { parsedRows: [], validRows: [], rejectedRowCount: 0 },
        source(),
        30,
        { purpose: 'evidence_only' }
      )
    ).not.toThrow()
    expect(() =>
      assertBitgetBotsLeaderboardPublication(
        { parsedRows: gridOnly, validRows: gridOnly.slice(1), rejectedRowCount: 0 },
        source(),
        30,
        { purpose: 'evidence_only' }
      )
    ).toThrow('changed the board population')
  })

  it('rejects malformed or crossed bot metadata before publication', () => {
    const missingMeta = fullFuturesRows()
    missingMeta[0] = { ...missingMeta[0], traderMeta: null }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(missingMeta), source(), 30)
    ).toThrow('traderMeta must be a plain data object')

    const crossedIdentity = fullFuturesRows()
    crossedIdentity[0] = {
      ...crossedIdentity[0],
      traderMeta: {
        bot: {
          ...(crossedIdentity[0].traderMeta?.bot as Record<string, unknown>),
          exchange_bot_id: '999',
        },
      },
    }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(crossedIdentity), source(), 30)
    ).toThrow('bot identity mismatch')

    const invalidRuntime = fullFuturesRows()
    invalidRuntime[0] = {
      ...invalidRuntime[0],
      traderMeta: {
        bot: {
          ...(invalidRuntime[0].traderMeta?.bot as Record<string, unknown>),
          runtime_days: -1,
        },
      },
    }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(invalidRuntime), source(), 30)
    ).toThrow('runtime_days must be non-negative')
  })

  it('rejects duplicate identities and raw strategy/identity drift', () => {
    const duplicate = fullFuturesRows()
    duplicate[1] = { ...duplicate[1], exchangeTraderId: duplicate[0].exchangeTraderId }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(duplicate), source(), 30)
    ).toThrow('duplicate exchange_trader_id')

    const crossedRaw = fullFuturesRows()
    crossedRaw[0] = {
      ...crossedRaw[0],
      raw: { ...crossedRaw[0].raw, strategyType: 4 },
    }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(crossedRaw), source(), 30)
    ).toThrow('raw strategyType mismatch')

    const leakedRaw = fullFuturesRows()
    leakedRaw[0] = {
      ...leakedRaw[0],
      raw: { ...leakedRaw[0].raw, profitRate: '22869.74' },
    }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(leakedRaw), source(), 30)
    ).toThrow('raw fields must match the reviewed contract exactly')
  })

  it.each([
    ['headlineRoi', 123.45],
    ['headlinePnl', 678.9],
    ['headlineWinRate', 55],
  ] as const)('rejects cumulative board %s before it can reach serving stats', (field, value) => {
    const rows = fullFuturesRows()
    rows[0] = { ...rows[0], [field]: value }

    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(rows), source(), 30)
    ).toThrow('cumulative ROI/PnL/win-rate headlines must remain null')
  })

  it('requires the exact active 30D source and pagination contract', () => {
    const cases: Array<[SourceRow, number]> = [
      [source({ timeframes_native: [7, 30, 90] }), 30],
      [source({ page_size: null }), 30],
      [source({ pagination_kind: 'infinite_scroll' }), 30],
      [source({ product_type: 'spot' }), 30],
      [source({ meta: { boards: ['futures_grid'] } }), 30],
      [source(), 90],
    ]
    for (const [src, timeframe] of cases) {
      expect(() =>
        assertBitgetBotsLeaderboardPublication(publicationResult(), src, timeframe as 30 | 90)
      ).toThrow('publication contract failed')
    }
  })

  it('rejects accessor-backed metadata', () => {
    const rows = fullFuturesRows()
    const bot = { ...(rows[0].traderMeta?.bot as Record<string, unknown>) }
    Object.defineProperty(bot, 'owner_name', { enumerable: true, get: () => 'unsafe' })
    rows[0] = { ...rows[0], traderMeta: { bot } }
    expect(() =>
      assertBitgetBotsLeaderboardPublication(publicationResult(rows), source(), 30)
    ).toThrow('must be an enumerable data property')
  })
})

describe('parseBitgetBotsProfile (live-captured fixture, 2026-06-11)', () => {
  it('parses performances per TF plus an inception (timeframe 0) block', () => {
    const profile = parseBitgetBotsProfile(
      { strategyInfo: fixture('bots-strategy-info.json'), timeframe: 30 },
      ctx
    )
    const tfs = profile.stats.map((s) => s.timeframe).sort((a, b) => a - b)
    expect(tfs).toEqual([0, 7, 30, 90])

    const tf7 = profile.stats.find((s) => s.timeframe === 7)
    expect(tf7?.roi).toBeCloseTo(-56.92, 2)
    expect(tf7?.pnl).toBeCloseTo(-29.05, 2)

    const inception = profile.stats.find((s) => s.timeframe === 0)
    const fixtureRoi = Number(
      (fixture('bots-strategy-info.json') as { data: { profitRate: string } }).data.profitRate
    )
    expect(inception?.roi).toBe(fixtureRoi) // cumulative since creation
    expect(inception?.copierCount).toBeGreaterThan(0)
    expect(inception?.aum).not.toBeNull()
    expect(inception?.extras.created_at_origin).toMatch(/Z$/)
    expect(inception?.extras.runtime_days).toBeGreaterThan(100)

    // This payload carries the copier-profit trend (profitChartDto); the
    // bot's own chart (strategySelfProfitChartDto) is null in this capture.
    const copierPnl = profile.series.find((s) => s.metric === 'copier_pnl')
    expect(copierPnl?.timeframe).toBe(30)
    expect(copierPnl?.points.length).toBeGreaterThan(10)
    expect(copierPnl?.points[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(profile.nickname).toBe('RIVERUSDT')
  })

  it('handles missing payloads without throwing', () => {
    expect(parseBitgetBotsProfile(null, ctx).stats).toHaveLength(0)
    expect(parseBitgetBotsProfile({ strategyInfo: { data: null } }, ctx).stats).toHaveLength(0)
  })
})

describe('parseBitgetBotsCopiers (live-captured fixture, 2026-06-11)', () => {
  it('uses the page-disclosed lastUpdateTime as ts and parses durations', () => {
    const rows = parseBitgetBotsCopiers(fixture('bots-follow-rank.json'), ctx)
    expect(rows).toHaveLength(10)
    const first = rows[0]
    if (first.kind !== 'copiers') throw new Error('wrong kind')
    expect(first.ts).not.toBe(ctx.scrapedAt) // lastUpdateTime, not scrape time
    expect(first.ts).toMatch(/Z$/)
    expect(first.copierLabel).toMatch(/^BGUSER/)
    expect(first.copierInvested).toBe(Number(first.raw.followerInvestmentAmount))
    expect(typeof first.copyDurationDays).toBe('number')
    expect(new Set(rows.map((r) => r.dedupeHash)).size).toBe(rows.length)
  })

  it('tolerates junk payloads', () => {
    expect(parseBitgetBotsCopiers(null, ctx)).toHaveLength(0)
    expect(parseBitgetBotsCopiers({ data: {} }, ctx)).toHaveLength(0)
  })
})
