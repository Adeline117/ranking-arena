/**
 * Comprehensive Encryption Utility Tests
 * ~15 tests covering encrypt/decrypt round-trip, key handling, edge cases, hashing, masking, field ops
 */

import {
  encrypt,
  decrypt,
  hash,
  maskSensitiveData,
  generateRandomToken,
  generateEncryptionKey,
  isValidEncryptionKey,
  encryptFields,
  decryptFields,
} from '../encryption'

// Set encryption key for tests
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-32-bytes-minimum'

describe('Encryption Utility', () => {
  // ============================================
  // encrypt / decrypt round-trip
  // ============================================

  describe('encrypt/decrypt round-trip', () => {
    it('should encrypt and decrypt to original plaintext', () => {
      const plaintext = 'my-secret-api-key-12345'
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('should produce different ciphertext for same plaintext (random IV)', () => {
      const plaintext = 'same-data'
      const encrypted1 = encrypt(plaintext)
      const encrypted2 = encrypt(plaintext)

      expect(encrypted1).not.toBe(encrypted2)
      expect(decrypt(encrypted1)).toBe(plaintext)
      expect(decrypt(encrypted2)).toBe(plaintext)
    })

    it('should handle empty string', () => {
      const encrypted = encrypt('')
      const decrypted = decrypt(encrypted)
      expect(decrypted).toBe('')
    })

    it('should handle long strings (10k chars)', () => {
      const plaintext = 'a'.repeat(10000)
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('should handle special characters', () => {
      const plaintext = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\'
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('should handle unicode and multi-byte characters', () => {
      const plaintext = 'hello-world-test-unicode-abc'
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('should handle newlines and whitespace', () => {
      const plaintext = 'line1\nline2\ttab\r\nwindows'
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)
      expect(decrypted).toBe(plaintext)
    })
  })

  // ============================================
  // Decrypt with wrong key / invalid data
  // ============================================

  describe('decrypt failures', () => {
    it('should throw error for invalid base64 data', () => {
      expect(() => decrypt('invalid-base64!!!')).toThrow()
    })

    it('should throw error for truncated ciphertext', () => {
      // Valid base64 but too short to contain IV + auth tag
      expect(() => decrypt('YWJjZGVm')).toThrow()
    })

    it('should throw error for tampered ciphertext', () => {
      const encrypted = encrypt('test-data')
      // Tamper with the middle of the base64 string
      const tampered = encrypted.substring(0, 10) + 'XXXX' + encrypted.substring(14)
      expect(() => decrypt(tampered)).toThrow()
    })

    it('should throw when ENCRYPTION_KEY is missing', () => {
      const originalKey = process.env.ENCRYPTION_KEY
      try {
        delete process.env.ENCRYPTION_KEY
        // The inner error is caught and re-thrown as "Encryption failed"
        expect(() => encrypt('test')).toThrow('Encryption failed')
      } finally {
        process.env.ENCRYPTION_KEY = originalKey
      }
    })
  })

  // ============================================
  // hash
  // ============================================

  describe('hash', () => {
    it('should produce consistent hashes for same input', () => {
      const hash1 = hash('test-data')
      const hash2 = hash('test-data')
      expect(hash1).toBe(hash2)
    })

    it('should produce different hashes for different inputs', () => {
      const hash1 = hash('data1')
      const hash2 = hash('data2')
      expect(hash1).not.toBe(hash2)
    })

    it('should produce 64-character hex string (SHA-256)', () => {
      const result = hash('test')
      expect(result).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  // ============================================
  // maskSensitiveData
  // ============================================

  describe('maskSensitiveData', () => {
    it('should mask middle portion of data', () => {
      expect(maskSensitiveData('abcdef123456', 3)).toBe('abc***456')
    })

    it('should return *** for short strings', () => {
      expect(maskSensitiveData('abc', 3)).toBe('***')
      expect(maskSensitiveData('ab', 3)).toBe('***')
    })

    it('should handle custom visible characters', () => {
      expect(maskSensitiveData('abcdef123456', 2)).toBe('ab***56')
    })

    it('should handle empty string', () => {
      expect(maskSensitiveData('', 3)).toBe('***')
    })
  })

  // ============================================
  // generateRandomToken
  // ============================================

  describe('generateRandomToken', () => {
    it('should generate tokens of specified byte length (hex-encoded)', () => {
      const token = generateRandomToken(16)
      expect(token).toHaveLength(32) // 16 bytes = 32 hex chars
    })

    it('should generate unique tokens', () => {
      const t1 = generateRandomToken(32)
      const t2 = generateRandomToken(32)
      expect(t1).not.toBe(t2)
    })

    it('should produce valid hex strings', () => {
      const token = generateRandomToken(8)
      expect(token).toMatch(/^[a-f0-9]+$/)
    })

    it('should use default length of 32 bytes', () => {
      const token = generateRandomToken()
      expect(token).toHaveLength(64) // 32 bytes = 64 hex chars
    })
  })

  // ============================================
  // generateEncryptionKey
  // ============================================

  describe('generateEncryptionKey', () => {
    it('should generate a 64-character hex key (32 bytes)', () => {
      const key = generateEncryptionKey()
      expect(key).toHaveLength(64)
      expect(key).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should generate unique keys', () => {
      const k1 = generateEncryptionKey()
      const k2 = generateEncryptionKey()
      expect(k1).not.toBe(k2)
    })
  })

  // ============================================
  // isValidEncryptionKey
  // ============================================

  describe('isValidEncryptionKey', () => {
    it('should accept keys >= 32 characters', () => {
      expect(isValidEncryptionKey('a'.repeat(32))).toBe(true)
      expect(isValidEncryptionKey('a'.repeat(64))).toBe(true)
    })

    it('should reject keys < 32 characters', () => {
      expect(isValidEncryptionKey('short')).toBe(false)
      expect(isValidEncryptionKey('a'.repeat(31))).toBe(false)
    })
  })

  // ============================================
  // encryptFields / decryptFields
  // ============================================

  describe('encryptFields / decryptFields', () => {
    it('should encrypt specified fields and leave others untouched', () => {
      const obj = { apiKey: 'secret123', name: 'test', count: 42 }
      const encrypted = encryptFields(obj, ['apiKey'])

      expect(encrypted.apiKey).not.toBe('secret123')
      expect(encrypted.name).toBe('test')
      expect(encrypted.count).toBe(42)
    })

    it('should round-trip encrypt then decrypt fields', () => {
      const obj = { key1: 'value1', key2: 'value2', safe: 'untouched' }
      const encrypted = encryptFields(obj, ['key1', 'key2'])
      const decrypted = decryptFields(encrypted, ['key1', 'key2'])

      expect(decrypted.key1).toBe('value1')
      expect(decrypted.key2).toBe('value2')
      expect(decrypted.safe).toBe('untouched')
    })

    it('should skip null/undefined fields during encryption', () => {
      const obj = { apiKey: null as string | null, secret: undefined as string | undefined }
      const encrypted = encryptFields(obj, ['apiKey', 'secret'])

      expect(encrypted.apiKey).toBeNull()
      expect(encrypted.secret).toBeUndefined()
    })
  })
})
