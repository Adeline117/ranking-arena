import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveServerTier } from '../resolve-server-tier'

jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }))

type Result = { data: unknown; error: { message: string } | null }

function client(results: { subscriptions: Result; user_profiles?: Result }) {
  const from = jest.fn((table: 'subscriptions' | 'user_profiles') => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in']) builder[method] = jest.fn(() => builder)
    builder.maybeSingle = jest.fn(async () => results[table] ?? { data: null, error: null })
    return builder
  })
  return { supabase: { from } as unknown as SupabaseClient, from }
}

describe('resolveServerTier', () => {
  it('uses an active subscription row', async () => {
    const { supabase, from } = client({ subscriptions: { data: { tier: 'pro' }, error: null } })

    await expect(resolveServerTier(supabase, 'user-1')).resolves.toEqual({ ok: true, tier: 'pro' })
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('honours a Pro grant stored only on the profile (NFT / admin)', async () => {
    const { supabase } = client({
      subscriptions: { data: null, error: null },
      user_profiles: { data: { subscription_tier: 'pro' }, error: null },
    })

    await expect(resolveServerTier(supabase, 'user-1')).resolves.toEqual({ ok: true, tier: 'pro' })
  })

  it('is free only when both reads succeed and neither grants Pro', async () => {
    const { supabase } = client({
      subscriptions: { data: null, error: null },
      user_profiles: { data: { subscription_tier: 'free' }, error: null },
    })

    await expect(resolveServerTier(supabase, 'user-1')).resolves.toEqual({ ok: true, tier: 'free' })
  })

  it.each([
    [{ subscriptions: { data: null, error: { message: 'multiple rows' } } }],
    [
      {
        subscriptions: { data: null, error: null },
        user_profiles: { data: null, error: { message: 'db down' } },
      },
    ],
  ])('reports a failed lookup instead of answering free', async (results) => {
    const { supabase } = client(results)

    await expect(resolveServerTier(supabase, 'user-1')).resolves.toEqual({
      ok: false,
      reason: 'lookup_failed',
    })
  })
})
