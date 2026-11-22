import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveServingTrader,
  resolveServingTraderOutcome,
  SERVING_RESOLVE_ERRORED,
} from '../resolve'

function client(data: Record<string, unknown>) {
  return {
    rpc: jest.fn(async () => ({ data, error: null })),
  } as unknown as SupabaseClient
}

describe('resolveServingTrader fetch region contract', () => {
  const base = {
    source: 'binance_futures',
    exchangeTraderId: 'trader-42',
    nickname: 'Forty Two',
    avatarMirrorUrl: null,
    avatarOriginUrl: null,
  }

  it('carries the database fetch region into the serving result', async () => {
    await expect(
      resolveServingTrader(client({ ...base, fetchRegion: 'vps_sg' }), {
        handle: 'trader-42',
        source: 'binance_futures',
      })
    ).resolves.toEqual({
      ...base,
      fetchRegion: 'vps_sg',
      publicSource: null,
    })
  })

  it('passes through the public source name when the resolver reports one', async () => {
    const resolved = await resolveServingTrader(
      client({ ...base, source: 'blofin_futures', fetchRegion: 'vps_sg', publicSource: 'blofin' }),
      { handle: 'trader-42', source: 'blofin_futures' }
    )
    expect(resolved).toMatchObject({ source: 'blofin_futures', publicSource: 'blofin' })
  })

  it('treats a missing or malformed public source name as unknown', async () => {
    for (const publicSource of [undefined, '', 7, null]) {
      const resolved = await resolveServingTrader(
        client({ ...base, fetchRegion: 'vps_sg', publicSource }),
        { handle: 'trader-42' }
      )
      expect(resolved?.publicSource).toBeNull()
    }
  })

  it('preserves warm identity but disables Tier-C routing for an invalid region', async () => {
    await expect(
      resolveServingTrader(client({ ...base, fetchRegion: 'unknown' }), {
        handle: 'trader-42',
      })
    ).resolves.toEqual({
      ...base,
      fetchRegion: null,
      publicSource: null,
    })
  })
})

describe('resolveServingTraderOutcome', () => {
  it('reports a genuine not-found as null', async () => {
    const supabase = {
      rpc: jest.fn(async () => ({ data: null, error: null })),
    } as unknown as SupabaseClient
    await expect(resolveServingTraderOutcome(supabase, { handle: 'nobody' })).resolves.toBeNull()
  })

  it('keeps "every attempt errored" distinct from not-found', async () => {
    const rpc = jest.fn(async () => ({ data: null, error: { message: 'fetch failed' } }))
    const supabase = { rpc } as unknown as SupabaseClient
    await expect(resolveServingTraderOutcome(supabase, { handle: 'someone' })).resolves.toBe(
      SERVING_RESOLVE_ERRORED
    )
    expect(rpc).toHaveBeenCalledTimes(3)
    // The plain resolver keeps its null contract for callers that only need the row.
    await expect(resolveServingTrader(supabase, { handle: 'someone' })).resolves.toBeNull()
  })
})
