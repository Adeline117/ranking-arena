import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCanonicalSubscriptionTier, hasCurrentGlobalProEntitlement } from './server-entitlement'

describe('canonical server entitlement', () => {
  it('uses the service-only canonical database authority', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: true, error: null })

    await expect(hasCurrentGlobalProEntitlement({ rpc } as never, 'actor-1')).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('service_actor_has_current_global_pro_entitlement', {
      p_actor_id: 'actor-1',
    })
  })

  it('maps canonical false authority to free', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: false, error: null })

    await expect(getCanonicalSubscriptionTier({ rpc } as never, 'actor-2')).resolves.toBe('free')
  })

  it.each([
    [{ data: null, error: null }, 'malformed acknowledgement'],
    [{ data: true, error: { message: 'database unavailable' } }, 'RPC error'],
  ])('fails closed on %s', async (result) => {
    const rpc = jest.fn().mockResolvedValue(result)

    await expect(hasCurrentGlobalProEntitlement({ rpc } as never, 'actor-3')).rejects.toThrow(
      'Failed to verify current Pro entitlement'
    )
  })
})

describe('server Pro feature gates', () => {
  const canonicalTierRoutes = [
    'app/api/portfolio/suggestions/route.ts',
    'app/api/compare/route.ts',
    'app/api/saved-filters/route.ts',
    'app/api/traders/[handle]/percentile/route.ts',
  ]
  const canonicalBooleanRoutes = ['app/api/trader-alerts/route.ts']

  it.each(canonicalTierRoutes)(
    '%s does not authorize from a mutable subscription projection',
    (relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8')

      expect(source).toContain('getCanonicalSubscriptionTier')
      expect(source).not.toContain(".from('subscriptions')")
    }
  )

  it.each(canonicalBooleanRoutes)(
    '%s does not authorize from a mutable subscription projection',
    (relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8')

      expect(source).toContain('hasCurrentGlobalProEntitlement')
      expect(source).not.toContain(".from('subscriptions')")
    }
  )

  it('keeps trader-follow limits behind the canonical atomic database gate', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/follow/route.ts'), 'utf8')

    expect(source).toContain("'mutate_trader_follow_atomic'")
    expect(source).not.toContain(".from('subscriptions')")
  })
})
