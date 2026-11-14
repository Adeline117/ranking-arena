/**
 * Unsubscribe token utilities
 *
 * Generates and verifies HMAC-signed tokens for email unsubscribe links.
 * Tokens encode user_id + type so users can unsubscribe without logging in.
 *
 * Format: base64url(user_id:type:timestamp) + "." + base64url(hmac)
 */

import crypto from 'crypto'

/**
 * The signing key comes only from the environment. There is deliberately no
 * fallback: a constant in source would let anyone who can read the code forge
 * an unsubscribe link for any user. Without the key, tokens are neither issued
 * nor accepted.
 */
function signingSecret(): string | null {
  const secret = process.env.CRON_SECRET
  return secret && secret.length > 0 ? secret : null
}

// Tokens expire after 90 days
const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export type UnsubscribeType = 'digest' | 'all'

interface UnsubscribePayload {
  userId: string
  type: UnsubscribeType
}

function toBase64Url(data: string): string {
  return Buffer.from(data).toString('base64url')
}

function fromBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8')
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

/**
 * Generate an unsubscribe token for a user
 */
export function generateUnsubscribeToken(userId: string, type: UnsubscribeType): string {
  const secret = signingSecret()
  if (!secret) throw new Error('CRON_SECRET is not configured; cannot sign unsubscribe token')
  const timestamp = Date.now().toString()
  const payload = `${userId}:${type}:${timestamp}`
  const signature = sign(payload, secret)
  return `${toBase64Url(payload)}.${signature}`
}

/**
 * Verify and decode an unsubscribe token
 * Returns the payload if valid, null if invalid or expired
 */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const secret = signingSecret()
  if (!secret) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 2) return null

    const [encodedPayload, signature] = parts
    const payload = fromBase64Url(encodedPayload)

    // Verify HMAC signature
    const expectedSignature = sign(payload, secret)
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null
    }

    // Parse payload
    const segments = payload.split(':')
    if (segments.length !== 3) return null

    const [userId, type, timestampStr] = segments
    const timestamp = parseInt(timestampStr, 10)

    // Check expiration
    if (isNaN(timestamp) || Date.now() - timestamp > TOKEN_MAX_AGE_MS) {
      return null
    }

    // Validate type
    if (type !== 'digest' && type !== 'all') {
      return null
    }

    return { userId, type }
  } catch (_err) {
    /* token verification failed */
    return null
  }
}
