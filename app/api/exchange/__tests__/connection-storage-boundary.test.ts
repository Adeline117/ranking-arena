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

  it('keeps every service-role read and update owner-scoped', () => {
    for (const routeFile of [
      'connect/route.ts',
      'connections/route.ts',
      'disconnect/route.ts',
      'sync/route.ts',
    ] as const) {
      expect(routeSource(routeFile)).toContain(".eq('user_id', user.id)")
    }

    expect(routeSource('connect/route.ts').match(/\.eq\('user_id', user\.id\)/g)).toHaveLength(2)
    expect(routeSource('sync/route.ts').match(/\.eq\('user_id', user\.id\)/g)).toHaveLength(3)
  })

  it('binds verified proof writes to the authenticated actor and canonical account key', () => {
    const source = routeSource('verify-ownership/route.ts')

    expect(source).toContain('user_id: user.id')
    expect(source).toContain("onConflict: 'user_id,exchange'")
    expect(source).not.toMatch(/user_id\s*:\s*(?:body|request|input)/)
  })
})
