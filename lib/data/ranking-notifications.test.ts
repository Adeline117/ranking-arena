import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createRankingNotificationsBatch,
  RankingNotificationBatchError,
  type RankingNotificationBatchInput,
} from './ranking-notifications'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

type RpcRequest = {
  request_id: string
  recipient_id: string
  title: string
  message: string
  link: string | null
  reference_id: string
}

function clientWithRpc(rpc: jest.Mock): SupabaseClient {
  return { rpc } as unknown as SupabaseClient
}

function acknowledgement(
  rows: RpcRequest[],
  outcomeFor: (
    row: RpcRequest,
    index: number
  ) => 'CREATED' | 'DEDUPLICATED' | 'RECIPIENT_UNAVAILABLE' = () => 'CREATED'
) {
  const results = rows.map((row, index) => {
    const outcome = outcomeFor(row, index)
    const unavailable = outcome === 'RECIPIENT_UNAVAILABLE'
    return {
      ...row,
      type: 'ranking_change',
      outcome,
      notification_id: unavailable
        ? null
        : `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
      created_at: unavailable ? null : '2026-07-30T10:55:00.123456+00:00',
    }
  })
  return {
    success: true,
    type: 'ranking_change',
    requested_count: rows.length,
    created_count: results.filter((result) => result.outcome === 'CREATED').length,
    deduplicated_count: results.filter((result) => result.outcome === 'DEDUPLICATED').length,
    skipped_count: results.filter((result) => result.outcome === 'RECIPIENT_UNAVAILABLE').length,
    results,
  }
}

describe('createRankingNotificationsBatch', () => {
  it('does not call the authority for an empty batch', async () => {
    const rpc = jest.fn()

    await expect(createRankingNotificationsBatch(clientWithRpc(rpc), [])).resolves.toEqual({
      requestedCount: 0,
      createdCount: 0,
      deduplicatedCount: 0,
      skippedCount: 0,
      created: [],
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('binds every result and returns only newly created rows', async () => {
    const rpc = jest.fn(async (_name: string, args: { p_rows: RpcRequest[] }) => ({
      data: acknowledgement(args.p_rows, (_row, index) =>
        index === 0 ? 'CREATED' : 'DEDUPLICATED'
      ),
      error: null,
    }))
    const rows: RankingNotificationBatchInput[] = [
      {
        userId: USER_ID.toUpperCase(),
        title: 'Rank up',
        message: 'Now #1',
        link: '/trader/one',
        referenceId: 'rank:one',
      },
      {
        userId: OTHER_USER_ID,
        title: 'Rank down',
        message: 'Now #2',
        referenceId: 'rank:two',
      },
    ]

    const result = await createRankingNotificationsBatch(clientWithRpc(rpc), rows)

    expect(rpc).toHaveBeenCalledWith('create_ranking_notifications_batch_atomic', {
      p_rows: [
        expect.objectContaining({
          recipient_id: USER_ID,
          link: '/trader/one',
          reference_id: 'rank:one',
        }),
        expect.objectContaining({
          recipient_id: OTHER_USER_ID,
          link: null,
          reference_id: 'rank:two',
        }),
      ],
    })
    expect(result).toMatchObject({
      requestedCount: 2,
      createdCount: 1,
      deduplicatedCount: 1,
      skippedCount: 0,
    })
    expect(result.created).toHaveLength(1)
    expect(result.created[0]).toMatchObject({
      userId: USER_ID,
      title: 'Rank up',
      referenceId: 'rank:one',
    })
  })

  it('chunks 501 rows and preserves an exact aggregate', async () => {
    const rpc = jest.fn(async (_name: string, args: { p_rows: RpcRequest[] }) => ({
      data: acknowledgement(args.p_rows),
      error: null,
    }))
    const rows = Array.from({ length: 501 }, (_, index) => ({
      userId: USER_ID,
      title: `Rank ${index}`,
      message: 'Changed',
      referenceId: `rank:${index}`,
    }))

    const result = await createRankingNotificationsBatch(clientWithRpc(rpc), rows)

    expect(rpc).toHaveBeenCalledTimes(2)
    expect((rpc.mock.calls[0][1] as { p_rows: unknown[] }).p_rows).toHaveLength(500)
    expect((rpc.mock.calls[1][1] as { p_rows: unknown[] }).p_rows).toHaveLength(1)
    expect(result).toMatchObject({
      requestedCount: 501,
      createdCount: 501,
      deduplicatedCount: 0,
      skippedCount: 0,
    })
    expect(result.created).toHaveLength(501)
  })

  it('rejects duplicate identities before calling the authority', async () => {
    const rpc = jest.fn()
    const row = {
      userId: USER_ID,
      title: 'Rank up',
      message: 'Now #1',
      referenceId: 'same-event',
    }

    await expect(
      createRankingNotificationsBatch(clientWithRpc(rpc), [row, row])
    ).rejects.toMatchObject<Partial<RankingNotificationBatchError>>({
      code: 'INVALID_REQUEST',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails closed on RPC errors, rejections, and non-exact acknowledgements', async () => {
    const row = {
      userId: USER_ID,
      title: 'Rank up',
      message: 'Now #1',
      referenceId: 'rank:error',
    }
    const cases: Array<[unknown, unknown, RankingNotificationBatchError['code']]> = [
      [null, { message: 'database unavailable' }, 'RPC_ERROR'],
      [{ success: false, reason: 'IDENTITY_CONFLICT' }, null, 'RPC_REJECTED'],
      [
        {
          success: true,
          type: 'ranking_change',
          requested_count: 1,
          created_count: 1,
          deduplicated_count: 0,
          skipped_count: 0,
          results: [],
        },
        null,
        'INVALID_ACKNOWLEDGEMENT',
      ],
    ]

    for (const [data, error, code] of cases) {
      const rpc = jest.fn(async () => ({ data, error }))
      await expect(
        createRankingNotificationsBatch(clientWithRpc(rpc), [row])
      ).rejects.toMatchObject<Partial<RankingNotificationBatchError>>({ code })
    }
  })
})
