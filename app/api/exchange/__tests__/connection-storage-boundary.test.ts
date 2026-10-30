import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE_FILES = [
  'connect/route.ts',
  'connections/route.ts',
  'disconnect/route.ts',
  'sync/route.ts',
] as const

function routeSource(
  relativePath: (typeof ROUTE_FILES)[number] | 'verify-ownership/route.ts'
): string {
  return readFileSync(join(process.cwd(), 'app/api/exchange', relativePath), 'utf8')
}

describe('exchange connection storage boundary', () => {
  it.each(['connections/route.ts', 'disconnect/route.ts', 'sync/route.ts'] as const)(
    '%s authenticates before using the service-only client',
    (routeFile) => {
      const source = routeSource(routeFile)

      expect(source).toMatch(/withAuth\(|withApiMiddleware\(/)
      expect(source).toContain("from '@/lib/supabase/server'")
      expect(source).toContain('getSupabaseAdmin()')
      expect(source).not.toMatch(/async \(\{[^}]*\bsupabase\b[^}]*\}\) =>/)
    }
  )

  it('keeps direct service-role table reads and updates owner-scoped', () => {
    for (const routeFile of ['connections/route.ts', 'sync/route.ts'] as const) {
      expect(routeSource(routeFile)).toContain(".eq('user_id', user.id)")
    }

    expect(routeSource('sync/route.ts').match(/\.eq\('user_id', user\.id\)/g)).toHaveLength(3)
  })

  it('keeps private refresh on the three implemented V1 exchanges and never caches it', () => {
    const source = routeSource('sync/route.ts')

    expect(source).toContain("const V1_SYNC_EXCHANGES = ['binance', 'bybit', 'bitget'] as const")
    expect(source).not.toMatch(/getMexc|calculateMexc|getCoinex|calculateCoinex/)
    expect(source).toContain('successStatusError')
    expect(source).toContain("'Cache-Control': 'private, no-store, max-age=0'")
    expect(source).toContain("'Vercel-CDN-Cache-Control': 'no-store'")
  })

  it('retires the legacy connection writer with one fixed successor', () => {
    const source = routeSource('connect/route.ts')

    expect(source).toContain('status: 410')
    expect(source).toContain("successor: '/api/trader/authorize'")
    expect(source).toContain('no-store')
    expect(source).not.toMatch(/withAuth\(|withApiMiddleware\(|getSupabaseAdmin|\.from\(|\.rpc\(/)
  })

  it('disconnects only through the shared atomic lifecycle service', () => {
    const source = routeSource('disconnect/route.ts')

    expect(source).toContain('disconnectApiKey(getSupabaseAdmin()')
    expect(source).toContain('isDisconnectableAccountExchange(normalizedExchange)')
    expect(source).not.toContain("from('user_exchange_connections')")
    expect(source).not.toContain("from('trader_authorizations')")
    expect(source).not.toContain('.update(')
  })

  it('retires CEX leaderboard ownership proof without reading credentials or writing state', () => {
    const source = routeSource('verify-ownership/route.ts')

    expect(source).toContain('withAuth(')
    expect(source).toContain('status: 410')
    expect(source).toContain('CEX_LEADERBOARD_OWNERSHIP_VERIFICATION_RETIRED')
    expect(source).not.toContain('getSupabaseAdmin')
    expect(source).not.toContain("from('user_exchange_connections')")
    expect(source).not.toContain('apiKey')
  })
})
