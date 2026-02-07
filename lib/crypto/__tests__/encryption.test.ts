/**
 * Encryption Utility Tests
 */

import { encrypt, decrypt, hash, maskSensitiveData, generateRandomToken } from '../encryption'

// Mock environment variable
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-32-bytes-minimum'

describe('Encryption Utility', () => {
  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt data correctly', () => {
      const plaintext = 'my-secret-api-key-12345'
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)

      expect(decrypted).toBe(plaintext)
    })

    it('should produce different ciphertext for same plaintext', () => {
      const plaintext = 'same-data'
      const encrypted1 = encrypt(plaintext)
      const encrypted2 = encrypt(plaintext)

      // Different IVs mean different ciphertexts
      expect(encrypted1).not.toBe(encrypted2)

      // But both decrypt to same plaintext
      expect(decrypt(encrypted1)).toBe(plaintext)
      expect(decrypt(encrypted2)).toBe(plaintext)
    })

    it('should handle empty strings', () => {
      const encrypted = encrypt('')
      const decrypted = decrypt(encrypted)

      expect(decrypted).toBe('')
    })

    it('should handle long strings', () => {
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

    it('should handle unicode characters', () => {
      const plaintext = 'hello-world-test'
      const encrypted = encrypt(plaintext)
      const decrypted = decrypt(encrypted)

      expect(decrypted).toBe(plaintext)
    })

    it('should throw error for invalid encrypted data', () => {
      expect(() => decrypt('invalid-base64')).toThrow()
      expect(() => decrypt('YWJjZGVm')).toThrow() // Valid base64 but wrong format
    })
  })

  describe('hash', () => {
    it('should produce consistent hashes', () => {
      const data = 'test-data'
      const hash1 = hash(data)
      const hash2 = hash(data)

      expect(hash1).toBe(hash2)
    })

    it('should produce different hashes for different data', () => {
      const hash1 = hash('data1')
      const hash2 = hash('data2')

      expect(hash1).not.toBe(hash2)
    })

    it('should produce 64-character hex string', () => {
      const result = hash('test')

      expect(result).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  describe('maskSensitiveData', () => {
    it('should mask middle portion of data', () => {
      const data = 'abcdef123456'
      const masked = maskSensitiveData(data, 3)

      expect(masked).toBe('abc***456')
    })

    it('should handle short strings', () => {
      const data = 'abc'
      const masked = maskSensitiveData(data, 3)

      expect(masked).toBe('***')
    })

    it('should handle custom visible characters', () => {
      const data = 'abcdef123456'
      const masked = maskSensitiveData(data, 2)

      expect(masked).toBe('ab***56')
    })
  })

  describe('generateRandomToken', () => {
    it('should generate random tokens of specified length', () => {
      const token1 = generateRandomToken(16)
      const token2 = generateRandomToken(16)

      expect(token1).toHaveLength(32) // 16 bytes = 32 hex chars
      expect(token2).toHaveLength(32)
      expect(token1).not.toBe(token2)
    })

    it('should generate hex strings', () => {
      const token = generateRandomToken(8)

      expect(token).toMatch(/^[a-f0-9]+$/)
    })
  })
})
