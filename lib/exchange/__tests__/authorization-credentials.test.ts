import { encrypt as encryptLegacy } from '@/lib/crypto/encryption'
import {
  decryptAuthorizationCredential,
  encryptAuthorizationCredential,
} from '../authorization-credentials'

describe('authorization credential encryption compatibility', () => {
  const originalKey = process.env.ENCRYPTION_KEY

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'arena-test-encryption-key-at-least-32-chars'
  })

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalKey
  })

  it('round-trips the canonical connection format', () => {
    const encrypted = encryptAuthorizationCredential('secret-value')
    expect(encrypted.split(':')).toHaveLength(3)
    expect(decryptAuthorizationCredential(encrypted)).toBe('secret-value')
  })

  it('still decrypts legacy base64 authorization rows', () => {
    const encrypted = encryptLegacy('legacy-secret')
    expect(encrypted).not.toContain(':')
    expect(decryptAuthorizationCredential(encrypted)).toBe('legacy-secret')
  })
})
