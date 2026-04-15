/**
 * TOTP Service Tests
 *
 * Tests backup code generation and hashing. TOTP secret/verification
 * tests are kept light since they delegate to the otpauth library.
 */

import {
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
  generateTotpSecret,
  verifyTotpCode,
} from '../totp'

describe('generateBackupCodes', () => {
  it('generates the requested number of codes', () => {
    const codes = generateBackupCodes(8)
    expect(codes).toHaveLength(8)
  })

  it('default count is 8', () => {
    const codes = generateBackupCodes()
    expect(codes).toHaveLength(8)
  })

  it('generates unique codes', () => {
    const codes = generateBackupCodes(8)
    const unique = new Set(codes)
    expect(unique.size).toBe(8)
  })

  it('codes have XXXX-XXXX format', () => {
    const codes = generateBackupCodes(4)
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/)
    }
  })

  it('generates 0 codes when count is 0', () => {
    const codes = generateBackupCodes(0)
    expect(codes).toHaveLength(0)
  })
})

describe('hashBackupCode', () => {
  it('produces consistent hash for same input', () => {
    const code = 'ABCD-1234'
    const hash1 = hashBackupCode(code)
    const hash2 = hashBackupCode(code)
    expect(hash1).toBe(hash2)
  })

  it('produces a 64-char hex string (SHA-256)', () => {
    const hash = hashBackupCode('DEAD-BEEF')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different codes produce different hashes', () => {
    const hash1 = hashBackupCode('AAAA-BBBB')
    const hash2 = hashBackupCode('CCCC-DDDD')
    expect(hash1).not.toBe(hash2)
  })

  it('is case-insensitive (normalizes to lowercase)', () => {
    const hash1 = hashBackupCode('ABCD-1234')
    const hash2 = hashBackupCode('abcd-1234')
    expect(hash1).toBe(hash2)
  })
})

describe('verifyBackupCode', () => {
  it('returns true for matching code + hash', () => {
    const code = 'FACE-CAFE'
    const hash = hashBackupCode(code)
    expect(verifyBackupCode(code, hash)).toBe(true)
  })

  it('returns false for non-matching code', () => {
    const hash = hashBackupCode('FACE-CAFE')
    expect(verifyBackupCode('DEAD-BEEF', hash)).toBe(false)
  })
})

describe('generateTotpSecret', () => {
  it('returns a base32 secret and URI', () => {
    const result = generateTotpSecret('user@example.com')
    expect(result.secret).toBeTruthy()
    expect(typeof result.secret).toBe('string')
    expect(result.uri).toContain('otpauth://totp/')
    expect(result.uri).toContain('user%40example.com')
    expect(result.uri).toContain('RankingArena')
  })

  it('generates different secrets each time', () => {
    const r1 = generateTotpSecret('a@b.com')
    const r2 = generateTotpSecret('a@b.com')
    expect(r1.secret).not.toBe(r2.secret)
  })
})

describe('verifyTotpCode', () => {
  it('rejects a clearly wrong code', () => {
    const { secret } = generateTotpSecret('test@test.com')
    expect(verifyTotpCode(secret, '000000')).toBe(false)
  })
})
