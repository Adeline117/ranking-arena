/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { fetchPhase1FromArena } from '../fetch-phase1-arena'

const TEST_SOURCES = [
  'binance_futures',
  'bybit',
  'bitget_futures',
  'mexc',
  'coinex',
  'okx_futures',
  'kucoin',
  'phemex',
  'htx_futures',
  'bingx',
] as const

function rpcRow(index = 0): Record<string, unknown> {
  return {
    platform: TEST_SOURCES[index % TEST_SOURCES.length],
    trader_key: `trader_${index}`,
    board_rank: index + 1,
    roi_pct: 12.5,
    pnl_usd: 250,
    win_rate: 60,
    max_drawdown: 8,
    copiers: 4,
    trades_count: 20,
    sharpe_ratio: 1.2,
    sortino_ratio: 1.4,
    calmar_ratio: 1.1,
    volatility_pct: 15,
    trader_kind: null,
    as_of: '2026-07-17T10:00:00.000Z',
    board_as_of: '2026-07-18T11:00:00.000Z',
  }
}

function supabaseReturning(data: unknown) {
  return {
    rpc: jest.fn().mockResolvedValue({ data, error: null }),
  }
}

describe('fetchPhase1FromArena board watermark boundary', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['invalid', 'not-a-timestamp'],
  ])('fails closed before map mutation when board_as_of is %s', async (_case, boardAsOf) => {
    const row = rpcRow()
    if (boardAsOf === undefined) delete row.board_as_of
    else row.board_as_of = boardAsOf
    const supabase = supabaseReturning([row])
    const addToTraderMap = jest.fn()

    await expect(fetchPhase1FromArena(supabase as never, '30D', addToTraderMap)).rejects.toThrow(
      'invalid board_as_of'
    )

    expect(addToTraderMap).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['invalid', 'not-a-timestamp'],
  ])('fails closed before map mutation when metric as_of is %s', async (_case, asOf) => {
    const row = rpcRow()
    if (asOf === undefined) delete row.as_of
    else row.as_of = asOf
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(supabaseReturning([row]) as never, '30D', addToTraderMap)
    ).rejects.toThrow('invalid as_of')

    expect(addToTraderMap).not.toHaveBeenCalled()
  })

  it('keeps row observation time separate from the source board watermark', async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => rpcRow(index))
    const supabase = supabaseReturning(rows)
    const addToTraderMap = jest.fn()

    await expect(fetchPhase1FromArena(supabase as never, '30D', addToTraderMap)).resolves.toEqual(
      new Map(TEST_SOURCES.map((source) => [source, 300]))
    )

    expect(addToTraderMap).toHaveBeenCalledTimes(3_000)
    expect(addToTraderMap.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        captured_at: '2026-07-17T10:00:00.000Z',
        source_board_as_of: '2026-07-18T11:00:00.000Z',
      })
    )
  })

  it('keeps finite zero/loss metrics but excludes malformed ROI or PnL before counting', async () => {
    const rows = Array.from({ length: 3_012 }, (_, index) => rpcRow(index))
    rows[0].pnl_usd = null
    rows[1].pnl_usd = ''
    rows[2].pnl_usd = 'not-a-number'
    rows[3].pnl_usd = Number.NaN
    rows[4].pnl_usd = Number.POSITIVE_INFINITY
    rows[5].pnl_usd = {} as never
    rows[6].roi_pct = null
    rows[7].roi_pct = ''
    rows[8].roi_pct = 'not-a-number'
    rows[9].roi_pct = Number.NaN
    rows[10].roi_pct = Number.POSITIVE_INFINITY
    rows[11].roi_pct = {} as never
    rows[12].roi_pct = '0'
    rows[12].pnl_usd = '0'
    rows[13].roi_pct = '-10.5'
    rows[13].pnl_usd = '-250.5'
    const supabase = supabaseReturning(rows)
    const addToTraderMap = jest.fn()

    await expect(fetchPhase1FromArena(supabase as never, '30D', addToTraderMap)).resolves.toEqual(
      new Map(TEST_SOURCES.map((source) => [source, 300]))
    )

    expect(addToTraderMap).toHaveBeenCalledTimes(3_000)
    expect(addToTraderMap.mock.calls.map(([row]) => row.source_trader_id)).not.toEqual(
      expect.arrayContaining([
        'trader_0',
        'trader_1',
        'trader_2',
        'trader_3',
        'trader_4',
        'trader_5',
        'trader_6',
        'trader_7',
        'trader_8',
        'trader_9',
        'trader_10',
        'trader_11',
      ])
    )
    const mappedRows = addToTraderMap.mock.calls.map(([row]) => row)
    expect(mappedRows.find((row) => row.source_trader_id === 'trader_12')).toEqual(
      expect.objectContaining({ roi: 0, pnl: 0 })
    )
    expect(mappedRows.find((row) => row.source_trader_id === 'trader_13')).toEqual(
      expect.objectContaining({ roi: -10.5, pnl: -250.5 })
    )
  })

  it('rejects a full-sized response with no rank-eligible ROI before map mutation', async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => ({
      ...rpcRow(index),
      roi_pct: null,
    }))
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(supabaseReturning(rows) as never, '30D', addToTraderMap)
    ).rejects.toThrow('arena read implausibly small')

    expect(addToTraderMap).not.toHaveBeenCalled()
  })

  it('rejects 2,999 otherwise valid rows before map mutation', async () => {
    const rows = Array.from({ length: 2_999 }, (_, index) => rpcRow(index))
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(supabaseReturning(rows) as never, '30D', addToTraderMap)
    ).rejects.toThrow('floor 3000 rows / 10 platforms')

    expect(addToTraderMap).not.toHaveBeenCalled()
  })

  it('omits a source whose core-metric coverage collapses while preserving healthy sources', async () => {
    const healthyRows = Array.from({ length: 3_000 }, (_, index) => rpcRow(index))
    const degradedRows = Array.from({ length: 300 }, (_, index) => ({
      ...rpcRow(3_000 + index),
      platform: 'gmx',
      trader_key: `degraded_${index}`,
      roi_pct: index === 0 ? 12.5 : null,
    }))
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(
        supabaseReturning([...healthyRows, ...degradedRows]) as never,
        '30D',
        addToTraderMap
      )
    ).resolves.toEqual(new Map(TEST_SOURCES.map((source) => [source, 300])))

    expect(addToTraderMap).toHaveBeenCalledTimes(3_000)
    expect(addToTraderMap.mock.calls.some(([row]) => row.source === 'gmx')).toBe(false)
  })

  it.each([
    [180, true],
    [179, false],
  ])('treats %i/300 source coverage as included=%s', async (eligibleCount, included) => {
    const healthyRows = Array.from({ length: 3_000 }, (_, index) => rpcRow(index))
    const candidateRows = Array.from({ length: 300 }, (_, index) => ({
      ...rpcRow(4_000 + index),
      platform: 'gmx',
      trader_key: `gmx_${index}`,
      roi_pct: index < eligibleCount ? 12.5 : null,
    }))
    const addToTraderMap = jest.fn()

    const counts = await fetchPhase1FromArena(
      supabaseReturning([...healthyRows, ...candidateRows]) as never,
      '30D',
      addToTraderMap
    )

    expect(counts.get('gmx')).toBe(included ? eligibleCount : undefined)
    expect(addToTraderMap).toHaveBeenCalledTimes(3_000 + (included ? eligibleCount : 0))
  })

  it('applies period ROI and source-aware PnL bounds before staging', async () => {
    const rows = Array.from({ length: 3_005 }, (_, index) => rpcRow(index))
    rows[0].roi_pct = 5_000.01
    rows[1].roi_pct = 10_000
    rows[2].roi_pct = -10_000
    rows[3].pnl_usd = 100_000_001
    rows[4].pnl_usd = -10_000_001
    rows.push(
      { ...rpcRow(3_005), platform: 'hyperliquid', pnl_usd: 1_000_000_001 },
      { ...rpcRow(3_006), platform: 'hyperliquid', pnl_usd: 500_000_000 },
      { ...rpcRow(3_007), platform: 'hyperliquid', pnl_usd: 1_000_000_000 }
    )
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(supabaseReturning(rows) as never, '30D', addToTraderMap)
    ).resolves.toEqual(
      new Map([...TEST_SOURCES.map((source) => [source, 300] as const), ['hyperliquid', 2]])
    )

    const mappedIds = addToTraderMap.mock.calls.map(([row]) => row.source_trader_id)
    expect(addToTraderMap).toHaveBeenCalledTimes(3_002)
    expect(mappedIds).not.toEqual(
      expect.arrayContaining(['trader_0', 'trader_1', 'trader_2', 'trader_3', 'trader_4'])
    )
    expect(mappedIds).not.toContain('trader_3005')
    expect(mappedIds).toEqual(expect.arrayContaining(['trader_3006', 'trader_3007']))
  })

  it('counts unique source identities so duplicate payload rows cannot satisfy the floor', async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => ({
      ...rpcRow(index),
      trader_key: `duplicate_${index % TEST_SOURCES.length}`,
    }))
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(supabaseReturning(rows) as never, '30D', addToTraderMap)
    ).rejects.toThrow('arena read implausibly small')

    expect(addToTraderMap).not.toHaveBeenCalled()
  })

  it('case-folds EVM identities before the unique-row floor', async () => {
    const rows = Array.from({ length: 3_000 }, (_, index) => rpcRow(index))
    rows[0].trader_key = '0xAbCd'
    rows[10].trader_key = '0xabcd'
    const addToTraderMap = jest.fn()

    await expect(
      fetchPhase1FromArena(supabaseReturning(rows) as never, '30D', addToTraderMap)
    ).rejects.toThrow('2998 rank-eligible rows / 10 platforms')

    expect(addToTraderMap).not.toHaveBeenCalled()
  })
})
