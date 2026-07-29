import crypto from 'crypto'

const KEY_HEX_LENGTH = 64
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const LEGACY_CBC_IV_BYTES = 16
const VERSION = 'v2'

export type OAuthTokenContext = {
  viewerId: string
  exchange: string
  purpose: 'access' | 'refresh'
}

function additionalAuthenticatedData(context: OAuthTokenContext): Buffer {
  if (!context.viewerId || !context.exchange) {
    throw new Error('OAuth token encryption context is invalid')
  }
  return Buffer.from(
    JSON.stringify([
      'ranking-arena:exchange-oauth-token',
      VERSION,
      context.viewerId,
      context.exchange,
      context.purpose,
    ]),
    'utf8'
  )
}

function encryptionKey(key: string): Buffer {
  if (!new RegExp(`^[0-9a-fA-F]{${KEY_HEX_LENGTH}}$`).test(key)) {
    throw new Error('OAuth token encryption key is invalid')
  }
  return Buffer.from(key, 'hex')
}

function hexBuffer(value: string, expectedBytes?: number): Buffer {
  if (
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value) ||
    (expectedBytes !== undefined && value.length !== expectedBytes * 2)
  ) {
    throw new Error('OAuth token ciphertext is invalid')
  }
  return Buffer.from(value, 'hex')
}

/**
 * Encrypt OAuth credentials with authenticated AES-256-GCM.
 *
 * v2 is deliberately self-describing so refresh can read legacy CBC rows
 * during migration and every successful refresh can rewrite them as GCM.
 */
export function encryptOAuthToken(
  plaintext: string,
  key: string,
  context: OAuthTokenContext
): string {
  if (!plaintext) throw new Error('OAuth token plaintext is empty')
  const iv = crypto.randomBytes(GCM_IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(key), iv)
  cipher.setAAD(additionalAuthenticatedData(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`
}

/**
 * Decrypt v2 GCM credentials, with read-only compatibility for the original
 * `iv:ciphertext` AES-256-CBC format. Callers must rewrite a successful legacy
 * read with encryptOAuthToken; this function never creates new CBC values.
 */
export function decryptOAuthToken(
  ciphertext: string,
  key: string,
  context: OAuthTokenContext
): string {
  const keyBytes = encryptionKey(key)
  const parts = ciphertext.split(':')

  try {
    if (parts.length === 4 && parts[0] === VERSION) {
      const iv = hexBuffer(parts[1], GCM_IV_BYTES)
      const tag = hexBuffer(parts[2], GCM_TAG_BYTES)
      const encrypted = hexBuffer(parts[3])
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv)
      decipher.setAAD(additionalAuthenticatedData(context))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    }

    if (parts.length === 2) {
      const iv = hexBuffer(parts[0], LEGACY_CBC_IV_BYTES)
      const encrypted = hexBuffer(parts[1])
      const decipher = crypto.createDecipheriv('aes-256-cbc', keyBytes, iv)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    }
  } catch {
    throw new Error('OAuth token ciphertext authentication failed')
  }

  throw new Error('OAuth token ciphertext is invalid')
}
