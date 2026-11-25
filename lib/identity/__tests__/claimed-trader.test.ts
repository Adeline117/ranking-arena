import type { SupabaseClient } from '@supabase/supabase-js'
import {
  claimedTraderCanonicalHref,
  findClaimedUserHandleByIdentity,
  urlPlatformIsServerAccount,
} from '../claimed-trader'

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

// The account the server resolved and rendered: arena slug plus the public
// alias it verified through the resolver. The client composes exactly these two
// functions to decide a mismatch and a claimed-account redirect.
describe('a ?platform= that names the server-rendered account', () => {
  const serverAccount = { source: 'bybit_copytrade', source_aliases: ['bybit'] }
  const claimedIdentity = { source: 'bybit_copytrade', traderId: 'acct-1', userHandle: 'alice' }
  const visibleIdentity = { source: 'bybit_copytrade', traderId: 'acct-1' }

  const redirectFor = (requestedPlatform: string | undefined) =>
    claimedTraderCanonicalHref({
      claimedIdentity,
      visibleIdentity,
      requestedPlatform,
      // No client override happened: only the server-account check can validate.
      requestedPlatformValidated: urlPlatformIsServerAccount(requestedPlatform, serverAccount),
    })

  it('accepts the source itself and a server-verified alias, nothing else', () => {
    expect(urlPlatformIsServerAccount('bybit_copytrade', serverAccount)).toBe(true)
    expect(urlPlatformIsServerAccount('bybit', serverAccount)).toBe(true)
    for (const forged of ['okx', 'bybit_spot', 'BYBIT', 'bybit ', '', null, undefined]) {
      expect(urlPlatformIsServerAccount(forged, serverAccount)).toBe(false)
    }
  })

  it('has no aliases to accept when the server sent none', () => {
    expect(urlPlatformIsServerAccount('bybit', { source: 'bybit_copytrade' })).toBe(false)
  })

  it('redirects a claimed account opened by its alias URL', () => {
    expect(redirectFor('bybit')).toBe('/u/alice')
    expect(redirectFor('bybit_copytrade')).toBe('/u/alice')
    expect(redirectFor(undefined)).toBe('/u/alice')
  })

  it('does not redirect for a forged platform, which stays unvalidated', () => {
    expect(redirectFor('okx')).toBeNull()
    expect(redirectFor('bybit_spot')).toBeNull()
  })

  it('never redirects when the visible account is not the claimed one, alias or not', () => {
    expect(
      claimedTraderCanonicalHref({
        claimedIdentity,
        visibleIdentity: { source: 'bybit_copytrade', traderId: 'someone-else' },
        requestedPlatform: 'bybit',
        requestedPlatformValidated: urlPlatformIsServerAccount('bybit', serverAccount),
      })
    ).toBeNull()
  })
})
