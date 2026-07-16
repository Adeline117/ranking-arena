import fs from 'node:fs'
import path from 'node:path'
import { syncPrivyUserToSupabase } from '../sync-user'

const BRIDGE_ERROR = 'verified Privy-to-Supabase bridge unavailable'

describe('Privy authentication boundary', () => {
  it.each([
    [{ privyId: 'did:privy:user-only' }, 'Privy id only'],
    [{ privyId: 'did:privy:email', email: 'person@example.com' }, 'email-bearing identity'],
    [
      {
        privyId: 'did:privy:wallet',
        walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      },
      'wallet-bearing identity',
    ],
  ])('rejects %s (%s) instead of returning a synthetic sync result', async (info) => {
    await expect(syncPrivyUserToSupabase(info)).rejects.toThrow(BRIDGE_ERROR)
  })

  it('contains no browser profile write or PII-derived handle path', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/privy/sync-user.ts'), 'utf8')

    expect(source).not.toMatch(/@\/lib\/supabase\//)
    expect(source).not.toMatch(/@supabase\/supabase-js/)
    expect(source).not.toMatch(/\.from\s*\(/)
    expect(source).not.toMatch(/\.insert\s*\(/)
    expect(source).not.toMatch(/info\.(?:email|walletAddress|privyId)/)
  })

  it('keeps the unfinished login entry point closed', () => {
    const config = fs.readFileSync(path.join(process.cwd(), 'lib/privy/config.ts'), 'utf8')
    const socialLogin = fs.readFileSync(
      path.join(process.cwd(), 'app/(app)/login/components/SocialLogin.tsx'),
      'utf8'
    )

    expect(config).toMatch(/PRIVY_SUPABASE_BRIDGE_READY\s*=\s*false/)
    expect(socialLogin).toContain('PRIVY_SUPABASE_BRIDGE_READY && showOtherOptions')
  })
})
