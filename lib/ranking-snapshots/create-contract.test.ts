import {
  AtomicRankingSnapshotCreateAckSchema,
  RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES,
  RankingSnapshotCreateRequestSchema,
  acknowledgementMatchesSnapshotRequest,
  readBoundedRankingSnapshotJson,
} from './create-contract'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = 'a'.repeat(32)

function trader(rank: number, overrides: Record<string, unknown> = {}) {
  return {
    rank,
    trader_id: `trader-${rank}`,
    handle: `handle-${rank}`,
    source: 'binance_futures',
    avatar_url: null,
    roi: 20 - rank,
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

function request(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'create_snapshot',
    request_id: REQUEST_ID,
    exchange: 'all',
    time_range: '90D',
    traders: [trader(1), trader(2)],
    ...overrides,
  }
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    status: 'created',
    applied: true,
    operation: 'create_snapshot',
    actor_id: ACTOR_ID,
    request_id: REQUEST_ID,
    snapshot: {
      id: SNAPSHOT_ID,
      share_token: 'b'.repeat(32),
      created_by: ACTOR_ID,
      exchange: 'all',
      time_range: '90D',
      total_traders: 2,
      top_trader_handle: 'handle-1',
      top_trader_roi: 19,
      data_captured_at: '2026-08-03T12:00:00.000Z',
      expires_at: '2026-08-10T12:00:00.000Z',
    },
    ...overrides,
  }
}

describe('ranking snapshot create contract', () => {
  it('accepts one exact complete, contiguous and ordered trader set', () => {
    expect(RankingSnapshotCreateRequestSchema.safeParse(request()).success).toBe(true)
  })

  it.each([
    ['an empty set', { traders: [] }],
    ['more than 100 rows', { traders: Array.from({ length: 101 }, (_, i) => trader(i + 1)) }],
    ['a missing trader field', { traders: [{ ...trader(1), roi: undefined }] }],
    ['an extra body field', { invented: true }],
    ['an extra trader field', { traders: [{ ...trader(1), invented: true }] }],
    ['a non-contiguous rank', { traders: [trader(1), trader(3)] }],
    ['a duplicate identity', { traders: [trader(1), trader(2, { trader_id: 'trader-1' })] }],
    ['a missing top handle', { traders: [trader(1, { handle: null })] }],
    ['a missing top ROI', { traders: [trader(1, { roi: null })] }],
    ['an unbounded metric', { traders: [trader(1, { roi: 1_000_000_000_001 })] }],
    ['a noncanonical request nonce', { request_id: 'A'.repeat(32) }],
    ['another operation', { operation: 'share' }],
  ])('rejects %s', (_label, override) => {
    expect(RankingSnapshotCreateRequestSchema.safeParse(request(override)).success).toBe(false)
  })

  it('physically rejects an oversized streamed body without trusting Content-Length', async () => {
    const bytes = new Uint8Array(RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES + 1)
    const cancel = jest.fn().mockResolvedValue(undefined)
    const requestDouble = {
      headers: new Headers(),
      body: {
        getReader: () => {
          let read = false
          return {
            cancel,
            read: async () => {
              if (read) return { done: true as const, value: undefined }
              read = true
              return { done: false as const, value: bytes }
            },
          }
        },
      },
    } as unknown as Request

    await expect(readBoundedRankingSnapshotJson(requestDouble)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a declared oversized body before consuming it', async () => {
    const getReader = jest.fn()
    const requestDouble = {
      headers: new Headers({
        'content-length': String(RANKING_SNAPSHOT_CREATE_MAX_REQUEST_BYTES + 1),
      }),
      body: { getReader },
    } as unknown as Request

    await expect(readBoundedRankingSnapshotJson(requestDouble)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(getReader).not.toHaveBeenCalled()
  })

  it('accepts only an exact actor/request/resource-bound acknowledgement', () => {
    const input = RankingSnapshotCreateRequestSchema.parse(request())
    const parsed = AtomicRankingSnapshotCreateAckSchema.parse(acknowledgement())

    expect(acknowledgementMatchesSnapshotRequest(parsed, ACTOR_ID, input)).toBe(true)
  })

  it.each([
    ['another actor', { actor_id: '33333333-3333-4333-8333-333333333333' }],
    ['another request', { request_id: 'c'.repeat(32) }],
    [
      'another resource owner',
      {
        snapshot: {
          ...acknowledgement().snapshot,
          created_by: '33333333-3333-4333-8333-333333333333',
        },
      },
    ],
    ['a partial resource count', { snapshot: { ...acknowledgement().snapshot, total_traders: 1 } }],
    [
      'a fabricated top trader',
      { snapshot: { ...acknowledgement().snapshot, top_trader_handle: 'other' } },
    ],
    [
      'a generated expiry outside the seven-day contract',
      { snapshot: { ...acknowledgement().snapshot, expires_at: '2026-08-11T12:00:00.000Z' } },
    ],
  ])('does not accept %s', (_label, override) => {
    const input = RankingSnapshotCreateRequestSchema.parse(request())
    const parsed = AtomicRankingSnapshotCreateAckSchema.parse(acknowledgement(override))
    expect(acknowledgementMatchesSnapshotRequest(parsed, ACTOR_ID, input)).toBe(false)
  })

  it.each([
    ['an extra acknowledgement field', { invented: true }],
    ['an inconsistent replay flag', { status: 'replayed', applied: true }],
    [
      'an invalid share token',
      { snapshot: { ...acknowledgement().snapshot, share_token: 'not-a-token' } },
    ],
  ])('rejects %s structurally', (_label, override) => {
    expect(AtomicRankingSnapshotCreateAckSchema.safeParse(acknowledgement(override)).success).toBe(
      false
    )
  })
})
