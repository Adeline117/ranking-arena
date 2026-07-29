import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(process.cwd(), 'lib/supabase/server.ts'), 'utf8')

describe('cross-instance account status authority', () => {
  it('never stores a positive account admission in process memory', () => {
    expect(source).not.toContain('banStatusCache')
    expect(source).not.toContain('CLEAN_STATUS_TTL_MS')
    expect(source).not.toMatch(/new Map<[^>]*account[^>]*status/i)
  })

  it('routes every verified bearer identity through the database admission RPC', () => {
    const statusBoundary = source.slice(
      source.indexOf('export async function getUserAccountStatus'),
      source.indexOf('async function getUserFromTokenWithProfilePolicy')
    )

    expect(statusBoundary).toContain(
      'return admitVerifiedAuthProfile(userId, verifiedIdentity.verifiedEmail)'
    )
    expect(statusBoundary).not.toContain('banStatusCache')
    expect(statusBoundary).not.toContain('.get(userId)')
    expect(statusBoundary).not.toContain('.set(userId')
  })
})
