/**
 * @jest-environment node
 */

import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import { createSupabaseRestRpcClient } from '@/lib/rankings/supabase-rest-rpc-client'

const URL = 'https://example.supabase.co'
const KEY = 'service-role-key'
const COHORT_ID = '123e4567-e89b-42d3-a456-426614174000'

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createSupabaseRestRpcClient', () => {
  it('posts canonical RPC requests and attaches an abort signal before dispatch', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response([{ ok: true }]))
    const client = createSupabaseRestRpcClient(`${URL}/`, KEY, fetchImpl)
    const controller = new AbortController()

    await expect(
      client.rpc('arena_test_rpc', { p_value: 7 }).abortSignal(controller.signal)
    ).resolves.toEqual({
      data: [{ ok: true }],
      error: null,
      status: 200,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(`${URL}/rest/v1/rpc/arena_test_rpc`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_value: 7 }),
      signal: controller.signal,
    })
  })

  it('dispatches a thenable only once', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response({ ok: true }))
    const query = createSupabaseRestRpcClient(URL, KEY, fetchImpl).rpc('arena_test_rpc')

    const [first, second] = await Promise.all([Promise.resolve(query), Promise.resolve(query)])

    expect(first).toEqual(second)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns definitive HTTP and JSON errors in Supabase-shaped envelopes', async () => {
    const deniedFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(response({ code: '42501', message: 'permission denied' }, 403))
    const invalidJsonFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>', { status: 502 }))

    await expect(
      createSupabaseRestRpcClient(URL, KEY, deniedFetch).rpc('arena_test_rpc')
    ).resolves.toEqual({
      data: null,
      error: {
        code: '42501',
        message: 'permission denied',
        status: 403,
      },
      status: 403,
    })
    await expect(
      createSupabaseRestRpcClient(URL, KEY, invalidJsonFetch).rpc('arena_test_rpc')
    ).resolves.toEqual({
      data: null,
      error: {
        message: 'Supabase REST RPC returned invalid JSON',
        status: 502,
      },
      status: 502,
    })
  })

  it('propagates transport failures so proof readers can classify ambiguity', async () => {
    const failure = new TypeError('network down')
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValue(failure)

    await expect(
      createSupabaseRestRpcClient(URL, KEY, fetchImpl).rpc('arena_test_rpc')
    ).rejects.toBe(failure)
  })

  it.each([
    ['blank URL', '', KEY],
    ['credential URL', 'https://user:secret@example.com', KEY],
    ['URL query', 'https://example.com?redirect=1', KEY],
    ['non-HTTP URL', 'file:///tmp/supabase', KEY],
    ['blank key', URL, ''],
    ['whitespace key', URL, ' key'],
    ['newline key', URL, 'key\nvalue'],
  ])('rejects invalid construction input: %s', (_label, url, key) => {
    expect(() => createSupabaseRestRpcClient(url, key)).toThrow(TypeError)
  })

  it('rejects invalid calls and signal mutation after dispatch', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response([]))
    const client = createSupabaseRestRpcClient(URL, KEY, fetchImpl)

    expect(() => client.rpc('../not-safe')).toThrow(TypeError)
    expect(() => client.rpc('Uppercase')).toThrow(TypeError)
    expect(() => client.rpc('arena_test_rpc', [] as never)).toThrow(TypeError)
    expect(() => client.rpc('arena_test_rpc').abortSignal({} as AbortSignal)).toThrow(TypeError)

    const query = client.rpc('arena_test_rpc')
    const dispatched = query.then((value) => value)
    expect(() => query.abortSignal(new AbortController().signal)).toThrow(
      'Supabase REST RPC request was already dispatched'
    )
    await dispatched
  })

  it('drives the complete authority/proof/data/proof fence over REST', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ url, body })
      if (url.endsWith('/arena_freshness_expected_sources')) {
        return response([
          {
            season_id: '90D',
            registry_slug: 'binance_perps',
            filter_source: 'binance_futures',
            exchange_name: 'Binance Futures',
          },
        ])
      }
      if (url.endsWith('/arena_leaderboard_publication_proofs')) {
        return response([
          {
            season_id: '90D',
            source: 'binance_futures',
            source_as_of: '2026-07-29T10:00:00.000000Z',
            recorded_at: '2026-07-29T10:01:00.000000Z',
            score_cohort_id: COHORT_ID,
            rank_mutation_seq: 9,
            current_mutation_seq: 9,
            published_rank_count: 1,
            published_identity_sha256: 'a'.repeat(64),
            is_sealed: true,
          },
        ])
      }
      return response({ message: 'unknown RPC' }, 404)
    })
    const client = createSupabaseRestRpcClient(URL, KEY, fetchImpl)
    const reader = jest.fn().mockResolvedValue([{ rank: 1 }])

    await expect(
      readSealedRankingGeneration(
        client as never,
        { season: '90D', sources: ['binance_futures'] },
        reader,
        { now: new Date('2026-07-29T10:05:00.000Z') }
      )
    ).resolves.toMatchObject({
      value: [{ rank: 1 }],
      publication: { scoreCohortId: COHORT_ID },
      authoritySources: ['binance_futures'],
    })

    expect(reader).toHaveBeenCalledWith(
      expect.objectContaining({ scoreCohortId: COHORT_ID, state: 'sealed' })
    )
    expect(calls).toHaveLength(4)
    expect(calls.map(({ url }) => url.slice(url.lastIndexOf('/') + 1))).toEqual([
      'arena_freshness_expected_sources',
      'arena_leaderboard_publication_proofs',
      'arena_freshness_expected_sources',
      'arena_leaderboard_publication_proofs',
    ])
    expect(calls[0].body).toEqual({})
    expect(calls[1].body).toEqual({
      p_season_id: '90D',
      p_sources: ['binance_futures'],
    })
    expect(calls[2].body).toEqual({})
    expect(calls[3].body).toEqual(calls[1].body)
  })
})
