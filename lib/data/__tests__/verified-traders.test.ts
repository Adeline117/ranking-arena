import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getVerifiedTraderKeys,
  resetVerifiedTraderCacheForTests,
  verifiedDataCutoffIso,
  verifiedTraderKey,
} from '../verified-traders'

function clientWith(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'not', 'gte']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return builder
    }
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
  const from = jest.fn(() => builder)
  return { client: { from } as unknown as SupabaseClient, calls, from }
}

describe('Verified Data eligibility', () => {
  beforeEach(() => resetVerifiedTraderCacheForTests())

  it('requires active, proven-read-only, successful and fresh authorization rows', async () => {
    const { client, calls, from } = clientWith({
      data: [{ platform: 'ByBit', trader_id: 'u1' }],
      error: null,
    })
    const keys = await getVerifiedTraderKeys(client)
    expect(keys.has('bybit:u1')).toBe(true)
    expect(calls).toContainEqual(['select', 'platform, trader_id'])
    expect(from).toHaveBeenCalledWith('verified_data_authorizations')
  })

  it('fails closed when the eligibility query fails', async () => {
    const { client } = clientWith({ data: null, error: { message: 'db unavailable' } })
    expect(await getVerifiedTraderKeys(client)).toEqual(new Set())
  })

  it('normalizes keys and exposes an exact 48-hour cutoff', () => {
    expect(verifiedTraderKey('OKX_FUTURES', '42')).toBe('okx_futures:42')
    expect(verifiedDataCutoffIso(Date.parse('2026-07-15T00:00:00.000Z'))).toBe(
      '2026-07-13T00:00:00.000Z'
    )
  })
})
