import {
  parsePublicRankingSnapshot,
  parsePublicSnapshotMetadata,
  parsePublicSnapshotTraders,
} from './public-read-contract'

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = '0123456789abcdef'

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
    expires_at: '2026-08-10T12:00:00.000Z',
    title: null,
    description: 'Captured ranking',
    created_at: '2026-08-03T12:00:01.000Z',
    ...overrides,
  }
}

function metadata(overrides: Record<string, unknown> = {}) {
  const value = snapshot(overrides)
  return {
    share_token: value.share_token,
    is_public: value.is_public,
    is_expired: false,
    expires_at: value.expires_at,
    title: value.title,
    time_range: value.time_range,
    total_traders: value.total_traders,
    top_trader_handle: value.top_trader_handle,
    top_trader_roi: value.top_trader_roi,
    data_captured_at: value.data_captured_at,
    ...overrides,
  }
}

function trader(rank: number, overrides: Record<string, unknown> = {}) {
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
    data_availability: { roi: true, pnl: true },
    ...overrides,
  }
}

describe('public ranking snapshot read contract', () => {
  it('accepts one complete snapshot bound to the requested share token', () => {
    expect(
      parsePublicRankingSnapshot(snapshot(), TOKEN, Date.parse('2026-08-03T00:00:00.000Z'))
    ).toEqual({
      id: SNAPSHOT_ID,
      shareToken: TOKEN,
      timeRange: '90D',
      exchange: 'all',
      category: null,
      totalTraders: 2,
      topTraderHandle: 'alpha',
      topTraderRoi: 12.5,
      dataCapturedAt: '2026-08-03T12:00:00.000Z',
      dataDelayMinutes: 5,
      viewCount: 3,
      expiresAt: '2026-08-10T12:00:00.000Z',
      title: null,
      description: 'Captured ranking',
      createdAt: '2026-08-03T12:00:01.000Z',
      isExpired: false,
    })
  })

  it.each([
    ['another token', { share_token: 'fedcba9876543210' }],
    ['private data', { is_public: false }],
    ['non-finite roi', { top_trader_roi: Number.NaN }],
    ['invalid capture time', { data_captured_at: 'not-a-date' }],
    ['zero traders', { total_traders: 0 }],
    ['more than the write cap', { total_traders: 101 }],
  ])('rejects %s instead of publishing a partial snapshot', (_label, override) => {
    expect(() => parsePublicRankingSnapshot(snapshot(override), TOKEN)).toThrow(
      'Invalid public ranking snapshot'
    )
  })

  it('classifies both database-expired and wall-clock-expired metadata as unavailable', () => {
    expect(
      parsePublicSnapshotMetadata(metadata({ is_expired: true }), TOKEN, Date.parse('2026-08-03'))
        .isExpired
    ).toBe(true)
    expect(
      parsePublicSnapshotMetadata(
        metadata({ expires_at: '2026-08-02T00:00:00.000Z' }),
        TOKEN,
        Date.parse('2026-08-03T00:00:00.000Z')
      ).isExpired
    ).toBe(true)
  })

  it('accepts only a complete, ordered, resource-bound trader set', () => {
    expect(parsePublicSnapshotTraders([trader(1), trader(2)], SNAPSHOT_ID, 2)).toEqual([
      expect.objectContaining({ rank: 1, id: 'trader-1', source: 'binance_futures' }),
      expect.objectContaining({ rank: 2, id: 'trader-2', source: 'binance_futures' }),
    ])
  })

  it.each([
    ['missing row', [trader(1)]],
    ['extra row', [trader(1), trader(2), trader(3)]],
    [
      'crossed snapshot id',
      [trader(1), trader(2, { snapshot_id: '22222222-2222-4222-8222-222222222222' })],
    ],
    ['out-of-order ranks', [trader(2), trader(1)]],
    ['duplicate ranks', [trader(1), trader(1, { trader_id: 'another' })]],
    ['duplicate identity', [trader(1), trader(2, { trader_id: 'trader-1' })]],
    ['malformed availability', [trader(1), trader(2, { data_availability: { roi: 1 } })]],
    ['non-finite metric', [trader(1), trader(2, { roi: Number.POSITIVE_INFINITY })]],
  ])('rejects a %s set instead of fabricating a successful board', (_label, rows) => {
    expect(() => parsePublicSnapshotTraders(rows, SNAPSHOT_ID, 2)).toThrow(
      'Invalid public ranking snapshot'
    )
  })
})
