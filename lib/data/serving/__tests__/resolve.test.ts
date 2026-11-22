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
    })
  })

  it('preserves warm identity but disables Tier-C routing for an invalid region', async () => {
    await expect(
      resolveServingTrader(client({ ...base, fetchRegion: 'unknown' }), {
        handle: 'trader-42',
      })
    ).resolves.toEqual({
      ...base,
      fetchRegion: null,
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
