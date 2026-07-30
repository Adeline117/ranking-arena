import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE_FILES = [
  'connect/route.ts',
  'connections/route.ts',
  'disconnect/route.ts',
  'sync/route.ts',
  'verify-ownership/route.ts',
] as const

function routeSource(relativePath: (typeof ROUTE_FILES)[number]): string {
  return readFileSync(join(process.cwd(), 'app/api/exchange', relativePath), 'utf8')
}

describe('exchange connection storage boundary', () => {
  it.each(ROUTE_FILES)('%s authenticates before using the service-only client', (routeFile) => {
    const source = routeSource(routeFile)

    expect(source).toMatch(/withAuth\(|withApiMiddleware\(/)
    expect(source).toContain("from '@/lib/supabase/server'")
    expect(source).toContain('getSupabaseAdmin()')
    expect(source).not.toMatch(/async \(\{[^}]*\bsupabase\b[^}]*\}\) =>/)
  })

  it('keeps direct service-role reads and updates owner-scoped', () => {
    for (const routeFile of ['connections/route.ts', 'disconnect/route.ts'] as const) {
      expect(routeSource(routeFile)).toContain(".eq('user_id', user.id)")
    }

    for (const routeFile of [
      'connect/route.ts',
      'sync/route.ts',
      'verify-ownership/route.ts',
    ] as const) {
      const source = routeSource(routeFile)
      expect(source).toContain('p_user_id: user.id')
      expect(source).not.toContain(".from('user_exchange_connections')")
    }
  })

  it('binds verified proof writes to the authenticated actor and canonical account key', () => {
    const source = routeSource('verify-ownership/route.ts')

    expect(source).toContain(
      "rpc(\n      'upsert_exchange_api_connection_for_active_profile_atomic'"
    )
    expect(source).toContain('p_user_id: user.id')
    expect(source).toContain('p_exchange: connectionExchange')
    expect(source).not.toMatch(/user_id\s*:\s*(?:body|request|input)/)
  })

  it('uses generation-fenced claim and finish authorities for live sync', () => {
    const source = routeSource('sync/route.ts')

    expect(source).toContain("'claim_exchange_api_sync_atomic'")
    expect(source).toContain("'finish_exchange_api_sync_atomic'")
    expect(source).toContain('p_generation: connection.generation')
    expect(source).not.toMatch(/\.update\(\{[\s\S]*last_sync_status/)
  })
})
