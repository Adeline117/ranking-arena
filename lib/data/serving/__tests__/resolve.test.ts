import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveServingTrader } from '../resolve'

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
