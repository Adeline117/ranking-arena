import { safeInternalReturnPath } from '@/lib/auth/safe-return-path'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,512}$/
const EXPIRY_PATTERN = /^\d{1,16}$/
const NONCE_PATTERN = /^[0-9a-f]{32}$/
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/
const OFFSET_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export type GroupInviteAcknowledgement = {
  expiresAt: string
  invitePath: string
  inviteUrl: string
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function decodeInviteToken(token: string): string[] | null {
  if (!INVITE_TOKEN_PATTERN.test(token) || typeof globalThis.atob !== 'function') return null

  const base64 = token.replace(/-/g, '+').replace(/_/g, '/')
  const paddingLength = (4 - (base64.length % 4)) % 4
  try {
    return globalThis.atob(`${base64}${'='.repeat(paddingLength)}`).split(':')
  } catch {
    return null
  }
}

/**
 * Accept only the exact invite-creation ACK emitted by the bound group route.
 * The server still owns signature verification; the client decodes the public
 * token payload only to prevent copying a valid-looking link for another group.
 */
export function readGroupInviteAcknowledgement(
  value: unknown,
  expectedGroupId: string,
  baseOrigin = typeof window === 'undefined' ? 'https://arena.invalid' : window.location.origin
): GroupInviteAcknowledgement | null {
  const groupId = expectedGroupId.trim().toLowerCase()
  if (!UUID_PATTERN.test(groupId) || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const acknowledgement = value as Record<string, unknown>
  if (
    !hasExactKeys(acknowledgement, ['expires_at', 'invite_url', 'success']) ||
    acknowledgement.success !== true ||
    typeof acknowledgement.invite_url !== 'string' ||
    typeof acknowledgement.expires_at !== 'string'
  ) {
    return null
  }

  const invitePath = acknowledgement.invite_url
  const safePath = safeInternalReturnPath(invitePath, baseOrigin)
  const prefix = `/groups/${groupId}?invite=`
  if (safePath !== invitePath || !invitePath.startsWith(prefix)) return null

  const token = invitePath.slice(prefix.length)
  if (!INVITE_TOKEN_PATTERN.test(token) || invitePath !== `${prefix}${token}`) return null

  const tokenParts = decodeInviteToken(token)
  if (!tokenParts || tokenParts.length !== 4) return null
  const [tokenGroupId, expiresAtText, nonce, signature] = tokenParts
  if (
    tokenGroupId.toLowerCase() !== groupId ||
    !EXPIRY_PATTERN.test(expiresAtText) ||
    !NONCE_PATTERN.test(nonce) ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    return null
  }

  const expiresAtMs = Number(expiresAtText)
  const acknowledgedExpiresAtMs = OFFSET_TIMESTAMP_PATTERN.test(acknowledgement.expires_at)
    ? Date.parse(acknowledgement.expires_at)
    : Number.NaN
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    !Number.isFinite(acknowledgedExpiresAtMs) ||
    expiresAtMs !== acknowledgedExpiresAtMs
  ) {
    return null
  }

  try {
    const resolved = new URL(invitePath, baseOrigin)
    const base = new URL(baseOrigin)
    if (
      resolved.origin !== base.origin ||
      resolved.username !== '' ||
      resolved.password !== '' ||
      resolved.hash !== '' ||
      resolved.pathname !== `/groups/${groupId}` ||
      resolved.searchParams.getAll('invite').length !== 1 ||
      [...resolved.searchParams.keys()].some((key) => key !== 'invite')
    ) {
      return null
    }
    return {
      expiresAt: acknowledgement.expires_at,
      invitePath,
      inviteUrl: resolved.href,
    }
  } catch {
    return null
  }
}
