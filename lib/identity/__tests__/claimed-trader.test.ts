import type { SupabaseClient } from '@supabase/supabase-js'
import { claimedTraderCanonicalHref, findClaimedUserHandleByIdentity } from '../claimed-trader'

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult) {
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    limit: jest.fn(),
    then: (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  chain.limit.mockReturnValue(chain)
  return chain
}

describe('claimed trader composite identity', () => {
  it('looks up one approved owner by exact source and trader ID', async () => {
    const verifiedTraderQuery = query({
      data: [{ user_id: 'user-binance' }],
      error: null,
    })
    const profileQuery = query({
      data: [{ handle: 'alice' }],
      error: null,
    })
    const from = jest.fn((table: string) => {
      if (table === 'verified_traders') return verifiedTraderQuery
      if (table === 'user_profiles') return profileQuery
      throw new Error(`unexpected table ${table}`)
    })

    await expect(
      findClaimedUserHandleByIdentity({ from } as unknown as SupabaseClient, {
        source: 'binance_futures',
        traderId: 'shared-id',
      })
    ).resolves.toBe('alice')

    expect(from).toHaveBeenCalledTimes(2)
    expect(verifiedTraderQuery.eq.mock.calls).toEqual([
      ['source', 'binance_futures'],
      ['trader_id', 'shared-id'],
    ])
    expect(profileQuery.eq).toHaveBeenCalledWith('id', 'user-binance')
  })

  it.each([
    {
      name: 'no owner',
      verifiedTrader: { data: [], error: null },
    },
    {
      name: 'ambiguous owners',
      verifiedTrader: {
        data: [{ user_id: 'user-a' }, { user_id: 'user-b' }],
        error: null,
      },
    },
    {
      name: 'verified trader query error',
      verifiedTrader: { data: null, error: { message: 'database unavailable' } },
    },
  ])('fails closed for $name', async ({ verifiedTrader }) => {
    const verifiedTraderQuery = query(verifiedTrader)
    const from = jest.fn(() => verifiedTraderQuery)

    await expect(
      findClaimedUserHandleByIdentity({ from } as unknown as SupabaseClient, {
        source: 'okx_futures',
        traderId: 'shared-id',
      })
    ).resolves.toBeNull()

    expect(from).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the owning profile is missing or ambiguous', async () => {
    const verifiedTraderQuery = query({
      data: [{ user_id: 'user-okx' }],
      error: null,
    })
    const profileQuery = query({
      data: [{ handle: 'alice' }, { handle: 'duplicate' }],
      error: null,
    })
    const from = jest.fn((table: string) =>
      table === 'verified_traders' ? verifiedTraderQuery : profileQuery
    )

    await expect(
      findClaimedUserHandleByIdentity({ from } as unknown as SupabaseClient, {
        source: 'okx_futures',
        traderId: 'shared-id',
      })
    ).resolves.toBeNull()
  })
})

describe('claimed trader canonical redirect', () => {
  const claimedIdentity = {
    source: 'binance_futures',
    traderId: 'shared-id',
    userHandle: 'alice/name',
  }

  it('redirects a matching account to its encoded user profile', () => {
    expect(
      claimedTraderCanonicalHref({
        claimedIdentity,
        visibleIdentity: { source: 'binance_futures', traderId: 'shared-id' },
        requestedPlatform: 'binance_futures',
        requestedPlatformValidated: false,
      })
    ).toBe('/u/alice%2Fname')
  })

  it.each([
    {
      name: 'same raw ID on another source',
      visibleIdentity: { source: 'okx_futures', traderId: 'shared-id' },
      requestedPlatform: 'okx_futures',
      requestedPlatformValidated: true,
    },
    {
      name: 'different account on the same source',
      visibleIdentity: { source: 'binance_futures', traderId: 'other-id' },
      requestedPlatform: 'binance_futures',
      requestedPlatformValidated: false,
    },
    {
      name: 'unvalidated explicit platform variant',
      visibleIdentity: { source: 'binance_futures', traderId: 'shared-id' },
      requestedPlatform: 'legacy-binance-alias',
      requestedPlatformValidated: false,
    },
  ])(
    'does not redirect $name',
    ({ visibleIdentity, requestedPlatform, requestedPlatformValidated }) => {
      expect(
        claimedTraderCanonicalHref({
          claimedIdentity,
          visibleIdentity,
          requestedPlatform,
          requestedPlatformValidated,
        })
      ).toBeNull()
    }
  )

  it('allows a differing platform alias only after client-side account validation', () => {
    expect(
      claimedTraderCanonicalHref({
        claimedIdentity,
        visibleIdentity: { source: 'binance_futures', traderId: 'shared-id' },
        requestedPlatform: 'binance',
        requestedPlatformValidated: true,
      })
    ).toBe('/u/alice%2Fname')
  })
})
