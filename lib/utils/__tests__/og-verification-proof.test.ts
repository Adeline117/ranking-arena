import { webcrypto } from 'crypto'
import { createOgVerificationProof, verifyOgVerificationProof } from '../og-verification-proof'

describe('OG verification proof', () => {
  const original = process.env.OG_SIGNING_SECRET

  beforeAll(() => {
    // Jest's environment does not install Web Crypto, while both the Node
    // server runtime and the Edge OG runtime do. Exercise the same standard
    // implementation here rather than mocking HMAC behavior.
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  beforeEach(() => {
    process.env.OG_SIGNING_SECRET = 'test-og-signing-secret-that-is-not-production'
  })

  afterAll(() => {
    if (original === undefined) delete process.env.OG_SIGNING_SECRET
    else process.env.OG_SIGNING_SECRET = original
  })

  it('accepts a valid proof for the exact exchange account', async () => {
    const proof = await createOgVerificationProof('ByBit', 'trader-123', {
      now: 1_700_000_000_000,
      ttlMs: 60_000,
    })
    await expect(
      verifyOgVerificationProof('bybit', 'trader-123', proof, { now: 1_700_000_030_000 })
    ).resolves.toBe(true)
  })

  it('rejects a forged, expired, or account-swapped proof', async () => {
    const proof = await createOgVerificationProof('bybit', 'trader-123', {
      now: 1_700_000_000_000,
      ttlMs: 60_000,
    })
    await expect(
      verifyOgVerificationProof('bybit', 'trader-999', proof, { now: 1_700_000_030_000 })
    ).resolves.toBe(false)
    await expect(
      verifyOgVerificationProof('bybit', 'trader-123', `${proof}x`, { now: 1_700_000_030_000 })
    ).resolves.toBe(false)
    await expect(
      verifyOgVerificationProof('bybit', 'trader-123', proof, { now: 1_700_000_060_000 })
    ).resolves.toBe(false)
  })
})
