/**
 * API Key Encryption/Decryption Utility
 * Uses AES-256-GCM for secure encryption
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16 // AES block size
const AUTH_TAG_LENGTH = 16
const SALT_LENGTH = 64

/**
 * Get encryption key from environment variable
 * Must be 32 bytes (256 bits) for AES-256
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY

  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set')
  }

  // If key is hex string, convert to buffer
  if (key.length === 64) {
    return Buffer.from(key, 'hex')
  }

  // Otherwise, hash it to get 32 bytes
  return crypto.createHash('sha256').update(key).digest()
}

/**
 * Encrypt sensitive data (API keys, secrets, etc.)
 * Returns: base64 encoded string containing iv + encrypted data + auth tag
 */
export function encrypt(plaintext: string): string {
  try {
    const key = getEncryptionKey()

    // Generate random IV
    const iv = crypto.randomBytes(IV_LENGTH)

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

    // Encrypt data
    let encrypted = cipher.update(plaintext, 'utf8', 'hex')
    encrypted += cipher.final('hex')

    // Get auth tag
    const authTag = cipher.getAuthTag()

    // Combine: iv + encrypted + authTag
    const combined = Buffer.concat([
      iv,
      Buffer.from(encrypted, 'hex'),
      authTag,
    ])

    // Return as base64
    return combined.toString('base64')
  } catch (error) {
    console.error('[Encryption] Failed to encrypt:', error)
    throw new Error('Encryption failed')
  }
}

/**
 * Decrypt encrypted data
 * Input: base64 encoded string containing iv + encrypted data + auth tag
 */
export function decrypt(encryptedData: string): string {
  try {
    const key = getEncryptionKey()

    // Decode from base64
    const combined = Buffer.from(encryptedData, 'base64')

    // Extract components
    const iv = combined.subarray(0, IV_LENGTH)
    const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH)
    const encrypted = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH)

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)

    // Decrypt data
    let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  } catch (error) {
    console.error('[Encryption] Failed to decrypt:', error)
    throw new Error('Decryption failed')
  }
}

/**
 * Generate a secure random encryption key
 * Should be stored in environment variable
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Hash sensitive data (for comparison without storing plaintext)
 * Uses SHA-256
 */
export function hash(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * Generate a secure random string (for tokens, nonces, etc.)
 */
export function generateRandomToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex')
}

/**
 * Mask sensitive data for display (e.g., API keys)
 * Example: "abc123def456" -> "abc***456"
 */
export function maskSensitiveData(data: string, visibleChars: number = 3): string {
  if (!data || data.length <= visibleChars * 2) {
    return '***'
  }

  const start = data.substring(0, visibleChars)
  const end = data.substring(data.length - visibleChars)

  return `${start}***${end}`
}

/**
 * Validate encryption key format
 */
export function isValidEncryptionKey(key: string): boolean {
  // Must be 32 bytes (64 hex characters) or any string (will be hashed)
  return key.length >= 32
}

/**
 * Encrypt object fields
 * Useful for encrypting multiple fields at once
 */
export function encryptFields<T extends Record<string, any>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const encrypted = { ...obj }

  for (const field of fields) {
    if (encrypted[field] && typeof encrypted[field] === 'string') {
      encrypted[field] = encrypt(encrypted[field] as string) as any
    }
  }

  return encrypted
}

/**
 * Decrypt object fields
 */
export function decryptFields<T extends Record<string, any>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const decrypted = { ...obj }

  for (const field of fields) {
    if (decrypted[field] && typeof decrypted[field] === 'string') {
      try {
        decrypted[field] = decrypt(decrypted[field] as string) as any
      } catch (error) {
        console.error(`[Encryption] Failed to decrypt field ${String(field)}:`, error)
        // Keep encrypted value if decryption fails
      }
    }
  }

  return decrypted
}
