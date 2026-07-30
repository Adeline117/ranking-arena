import { getAccountDeletionProof } from '../account-deletion-proof'

function jwt(amr?: unknown): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'user-1', ...(amr === undefined ? {} : { amr }) })
  ).toString('base64url')
  return `header.${payload}.signature`
}

const emailIdentity = {
  email: 'user@example.com',
  identities: [{ provider: 'email' }],
  appMetadata: { provider: 'email', providers: ['email'] },
}

describe('account deletion proof selection', () => {
  it('requires a password for a password-authenticated email session', () => {
    expect(
      getAccountDeletionProof({
        ...emailIdentity,
        accessToken: jwt([{ method: 'password', timestamp: 123 }]),
      })
    ).toBe('password')
  })

  it.each(['otp', 'magiclink', 'oauth', 'sso/saml', 'web3'])(
    'allows typed confirmation for a %s-authenticated email identity',
    (method) => {
      expect(
        getAccountDeletionProof({
          ...emailIdentity,
          accessToken: jwt([{ method, timestamp: 123 }]),
        })
      ).toBe('typed')
    }
  )

  it('gives password proof precedence when AMR also contains a second factor', () => {
    expect(
      getAccountDeletionProof({
        ...emailIdentity,
        accessToken: jwt(['password', 'mfa/totp']),
      })
    ).toBe('password')
  })

  it('keeps legacy email tokens without AMR on the password path', () => {
    expect(getAccountDeletionProof({ ...emailIdentity, accessToken: jwt() })).toBe('password')
  })

  it('rejects missing provider evidence instead of downgrading the proof', () => {
    expect(
      getAccountDeletionProof({
        accessToken: jwt(['otp']),
        email: 'user@example.com',
        identities: [],
        appMetadata: {},
      })
    ).toBe('unavailable')
  })

  it('keeps wallet identities on typed confirmation for legacy sessions', () => {
    expect(
      getAccountDeletionProof({
        accessToken: 'opaque-wallet-token',
        email: '0x123@wallet.arena',
        identities: [{ provider: 'privy' }],
        appMetadata: {},
      })
    ).toBe('typed')
  })

  it('uses typed confirmation for OAuth-only accounts without AMR', () => {
    expect(
      getAccountDeletionProof({
        accessToken: jwt(),
        email: 'user@example.com',
        identities: [{ provider: 'google' }],
        appMetadata: { provider: 'google' },
      })
    ).toBe('typed')
  })
})
