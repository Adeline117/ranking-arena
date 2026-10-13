jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import {
  claimedTraderBadgeKey,
  getClaimedTraderBadgeKeys,
  resetClaimedTraderBadgeCacheForTests,
} from '../claimed-trader-badges'

function client(result: { data: unknown[] | null; error: { message: string } | null }) {
  const select = jest.fn(() => Promise.resolve(result))
  const from = jest.fn(() => ({ select }))
  return { supabase: { from } as never, from }
}

describe('getClaimedTraderBadgeKeys', () => {
  beforeEach(() => resetClaimedTraderBadgeCacheForTests())

  it('caches the verified_traders set and shares concurrent cold reads', async () => {
    const { supabase, from } = client({
      data: [{ source: 'okx', trader_id: 't1' }],
      error: null,
    })
    const [a, b] = await Promise.all([
      getClaimedTraderBadgeKeys(supabase),
      getClaimedTraderBadgeKeys(supabase),
    ])
    expect(a.has(claimedTraderBadgeKey('okx', 't1'))).toBe(true)
    expect(b).toBe(a)
    await getClaimedTraderBadgeKeys(supabase)
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('fails open without caching a query error', async () => {
    const failing = client({ data: null, error: { message: 'down' } })
    expect((await getClaimedTraderBadgeKeys(failing.supabase)).size).toBe(0)

    const ok = client({ data: [{ source: 'okx', trader_id: 't1' }], error: null })
    expect((await getClaimedTraderBadgeKeys(ok.supabase)).size).toBe(1)
    expect(ok.from).toHaveBeenCalledTimes(1)
  })
})
