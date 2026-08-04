import type { ReactElement } from 'react'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockNotFound = jest.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
const mockLoggerWarn = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))

jest.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}))

jest.mock('../SnapshotViewerClient', () => ({
  __esModule: true,
  default: () => null,
}))

import SnapshotViewerPage, { generateMetadata } from '../page'

const TOKEN = '0123456789abcdef'
const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_ID,
    share_token: TOKEN,
    time_range: '90D',
    exchange: 'all',
    category: null,
    total_traders: 2,
    top_trader_handle: 'alpha',
    top_trader_roi: 12.5,
    data_captured_at: '2026-08-03T12:00:00.000Z',
    data_delay_minutes: 5,
    is_public: true,
    is_expired: false,
    view_count: 3,
    expires_at: null,
    title: null,
    description: 'Captured ranking',
    created_at: '2026-08-03T12:00:01.000Z',
    ...overrides,
  }
}

function metadata(overrides: Record<string, unknown> = {}) {
  const raw = snapshot(overrides)
  return {
    share_token: raw.share_token,
    is_public: raw.is_public,
    is_expired: raw.is_expired,
    expires_at: raw.expires_at,
    title: raw.title,
    time_range: raw.time_range,
    total_traders: raw.total_traders,
    top_trader_handle: raw.top_trader_handle,
    top_trader_roi: raw.top_trader_roi,
    data_captured_at: raw.data_captured_at,
  }
}

function trader(rank: number) {
  return {
    snapshot_id: SNAPSHOT_ID,
    rank,
    trader_id: `trader-${rank}`,
    handle: `handle-${rank}`,
    source: 'binance_futures',
    avatar_url: null,
    roi: 12 - rank,
    pnl: 1000 - rank,
    win_rate: 55,
    max_drawdown: 8,
    trades_count: 10,
    followers: 20,
    arena_score: 70,
    return_score: 60,
    drawdown_score: 65,
    stability_score: 50,
    data_availability: { roi: true },
  }
}

type Result = { data: unknown; error: { message: string } | null }

function singleQuery(result: Result, signals: AbortSignal[], hangs = false) {
  const query: Record<string, jest.Mock> = {}
  query.select = jest.fn(() => query)
  query.eq = jest.fn(() => query)
  query.abortSignal = jest.fn((signal: AbortSignal) => {
    signals.push(signal)
    return query
  })
  query.maybeSingle = jest.fn(() =>
    hangs ? new Promise<Result>(() => undefined) : Promise.resolve(result)
  )
  return query
}

function listQuery(result: Result, signals: AbortSignal[]) {
  const query: Record<string, jest.Mock> = {}
  query.select = jest.fn(() => query)
  query.eq = jest.fn(() => query)
  query.order = jest.fn(() => query)
  query.abortSignal = jest.fn((signal: AbortSignal) => {
    signals.push(signal)
    return Promise.resolve(result)
  })
  return query
}

describe('public snapshot server loading truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockReturnValue({
      abortSignal: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('renders one complete resource-bound snapshot and physically bounds both reads', async () => {
    const signals: AbortSignal[] = []
    mockFrom.mockImplementation((table: string) => {
      if (table === 'ranking_snapshots') {
        return singleQuery({ data: snapshot(), error: null }, signals)
      }
      return listQuery({ data: [trader(1), trader(2)], error: null }, signals)
    })

    const element = (await SnapshotViewerPage({
      params: Promise.resolve({ token: TOKEN }),
    })) as ReactElement<{
      snapshot: { shareToken: string; totalTraders: number }
      traders: Array<{ id: string; rank: number }>
    }>

    expect(element.props.snapshot).toEqual(
      expect.objectContaining({ shareToken: TOKEN, totalTraders: 2, isExpired: false })
    )
    expect(element.props.traders).toEqual([
      expect.objectContaining({ id: 'trader-1', rank: 1 }),
      expect.objectContaining({ id: 'trader-2', rank: 2 }),
    ])
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    expect(mockRpc).toHaveBeenCalledWith('increment_snapshot_view_count', {
      snapshot_share_token: TOKEN,
    })
  })

  it('routes a genuine absent token to not-found without querying child rows', async () => {
    const signals: AbortSignal[] = []
    mockFrom.mockReturnValue(singleQuery({ data: null, error: null }, signals))

    await expect(SnapshotViewerPage({ params: Promise.resolve({ token: TOKEN }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    )
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('propagates transient database errors to the retryable route boundary', async () => {
    const signals: AbortSignal[] = []
    mockFrom.mockReturnValue(
      singleQuery({ data: null, error: { message: 'database unavailable' } }, signals)
    )

    await expect(SnapshotViewerPage({ params: Promise.resolve({ token: TOKEN }) })).rejects.toThrow(
      'Snapshot read failed: database unavailable'
    )
    expect(mockNotFound).not.toHaveBeenCalled()
  })

  it('rejects incomplete child rows instead of rendering a fake successful empty board', async () => {
    const signals: AbortSignal[] = []
    mockFrom.mockImplementation((table: string) =>
      table === 'ranking_snapshots'
        ? singleQuery({ data: snapshot(), error: null }, signals)
        : listQuery({ data: [trader(1)], error: null }, signals)
    )

    await expect(SnapshotViewerPage({ params: Promise.resolve({ token: TOKEN }) })).rejects.toThrow(
      'Invalid public ranking snapshot trader row count'
    )
  })

  it('aborts and rejects a hung metadata read instead of leaving the route skeleton forever', async () => {
    jest.useFakeTimers()
    const signals: AbortSignal[] = []
    mockFrom.mockReturnValue(singleQuery({ data: null, error: null }, signals, true))

    const rejection = expect(
      SnapshotViewerPage({ params: Promise.resolve({ token: TOKEN }) })
    ).rejects.toThrow('Snapshot read timed out')
    await jest.advanceTimersByTimeAsync(3_000)

    await rejection
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('marks an expired share as noindex in metadata even when its row still exists', async () => {
    const signals: AbortSignal[] = []
    mockFrom.mockReturnValue(
      singleQuery({ data: metadata({ is_expired: true }), error: null }, signals)
    )

    await expect(generateMetadata({ params: Promise.resolve({ token: TOKEN }) })).resolves.toEqual({
      title: 'Snapshot Not Found',
      robots: { index: false, follow: false },
    })
  })
})
