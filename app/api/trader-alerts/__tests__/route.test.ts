/**
 * @jest-environment node
 */
const mockHasFeatureAccess = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => async (request: Request, ctx: { supabase: unknown }) => {
    const result = await handler({ user: { id: 'user-1' }, supabase: ctx.supabase, request })
    return result instanceof Response ? result : Response.json(result)
  },
}))

jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: (...args: unknown[]) => mockHasFeatureAccess(...args),
}))

import { GET } from '../route'

function chain(result: unknown) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
        }
        if (prop === 'maybeSingle') return () => Promise.resolve(result)
        return () => proxy
      },
    }
  )
  return proxy
}

function supabaseWith(tables: Record<string, unknown>) {
  return {
    from: jest.fn((table: string) => {
      if (!(table in tables)) throw new Error(`Unexpected query for ${table}`)
      return chain(tables[table])
    }),
  }
}

const call = (supabase: unknown) =>
  (GET as unknown as (r: Request, c: { supabase: unknown }) => Promise<Response>)(
    new Request('https://arena.test/api/trader-alerts'),
    { supabase }
  )

describe('GET /api/trader-alerts entitlement', () => {
  beforeEach(() => mockHasFeatureAccess.mockReset())

  it('allows access without a paid row while PRO_FREE_PROMO unlocks the feature', async () => {
    mockHasFeatureAccess.mockReturnValue(true)
    const supabase = supabaseWith({ trader_alerts: { data: [], error: null } })

    const res = await call(supabase)

    expect(res.status).toBe(200)
    expect(supabase.from).not.toHaveBeenCalledWith('subscriptions')
    expect(mockHasFeatureAccess).toHaveBeenCalledWith('free', 'trader_alerts')
  })

  it('returns 403 without an active paid subscription when the paywall is on', async () => {
    mockHasFeatureAccess.mockImplementation((tier: string) => tier === 'pro')
    const supabase = supabaseWith({ subscriptions: { data: null, error: null } })

    const res = await call(supabase)

    expect(res.status).toBe(403)
  })

  it('allows an active paid subscriber when the paywall is on', async () => {
    mockHasFeatureAccess.mockImplementation((tier: string) => tier === 'pro')
    const supabase = supabaseWith({
      subscriptions: { data: { tier: 'pro', status: 'active' }, error: null },
      trader_alerts: { data: [], error: null },
    })

    const res = await call(supabase)

    expect(res.status).toBe(200)
  })
})
