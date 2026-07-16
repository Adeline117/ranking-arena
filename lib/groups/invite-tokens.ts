import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

const INVITE_TOKEN_HKDF_INFO = 'arena-invite-token-v1'
const MAX_TOKEN_LENGTH = 512
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EXPIRY_PATTERN = /^\d{1,16}$/
const NONCE_PATTERN = /^[0-9a-f]{32}$/
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/

let cachedInviteSecret: string | null = null

function getInviteSecret(): string {
  if (cachedInviteSecret) return cachedInviteSecret

  const explicit = process.env.INVITE_SECRET
  if (explicit && explicit.length >= 32) {
    cachedInviteSecret = explicit
    return cachedInviteSecret
  }

  const root = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!root || root.length < 32) {
    throw new Error(
      'INVITE_SECRET (or SUPABASE_SERVICE_ROLE_KEY as fallback) must be set ' +
        'to a strong (>=32 char) random value'
    )
  }

  const derived = hkdfSync(
    'sha256',
    Buffer.from(root, 'utf8'),
    Buffer.alloc(0),
    Buffer.from(INVITE_TOKEN_HKDF_INFO, 'utf8'),
    32
  )
  cachedInviteSecret = Buffer.from(derived).toString('hex')
  return cachedInviteSecret
}

function sign(payload: string): string {
  return createHmac('sha256', getInviteSecret()).update(payload).digest('hex')
}

export type VerifiedInviteToken =
  | { valid: true; groupId: string; expiresAt: number }
  | { valid: false; groupId: string }

/**
 * New tokens include a random nonce, so two links created in the same
 * millisecond never share a token/hash. Verification remains compatible with
 * the legacy `groupId:expiresAt:signature` shape until those links expire.
 */
export function generateInviteToken(groupId: string, expiresAt: number): string {
  if (!UUID_PATTERN.test(groupId)) {
    throw new Error('A valid group ID is required to generate an invite token')
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('A future millisecond expiry is required to generate an invite token')
  }

  const payload = `${groupId}:${expiresAt}:${randomBytes(16).toString('hex')}`
  return Buffer.from(`${payload}:${sign(payload)}`, 'utf8').toString('base64url')
}

export function verifyInviteToken(token: string, now = Date.now()): VerifiedInviteToken {
  try {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(token) ||
      !Number.isSafeInteger(now)
    ) {
      return { groupId: '', valid: false }
    }

    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const parts = decoded.split(':')
    if (parts.length !== 3 && parts.length !== 4) {
      return { groupId: '', valid: false }
    }

    const groupId = parts[0]
    const expiresAtText = parts[1]
    const hasNonce = parts.length === 4
    const nonce = hasNonce ? parts[2] : null
    const signature = parts[hasNonce ? 3 : 2]

    if (
      !UUID_PATTERN.test(groupId) ||
      !EXPIRY_PATTERN.test(expiresAtText) ||
      (nonce !== null && !NONCE_PATTERN.test(nonce)) ||
      !SIGNATURE_PATTERN.test(signature)
    ) {
      return { groupId: '', valid: false }
    }

    const expiresAt = Number(expiresAtText)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      return { groupId, valid: false }
    }

    const payload =
      nonce === null ? `${groupId}:${expiresAtText}` : `${groupId}:${expiresAtText}:${nonce}`
    const expectedSignature = sign(payload)
    const suppliedBytes = Buffer.from(signature, 'hex')
    const expectedBytes = Buffer.from(expectedSignature, 'hex')

    if (!timingSafeEqual(suppliedBytes, expectedBytes)) {
      return { groupId, valid: false }
    }

    return { valid: true, groupId, expiresAt }
  } catch {
    return { groupId: '', valid: false }
  }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
