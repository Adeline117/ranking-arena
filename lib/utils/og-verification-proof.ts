/**
 * Short-lived, HMAC-signed proof for a Verified mark on public OG images.
 *
 * OG image URLs are public and their rank/ROI query parameters are cosmetic.
 * A Verified mark is a trust claim, however, so it must never be enabled by a
 * caller writing `verified=1` into a URL. Server-rendered pages mint this proof
 * only after checking an active read-only trader authorization; the Edge OG
 * route verifies it without a database request.
 */

const VERSION = 'v1'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function signingSecret(): string | null {
  // Dedicated secret is preferred. ENCRYPTION_KEY is an existing production
  // server-only secret and provides a safe fail-closed fallback while the new
  // variable is rolled out.
  return process.env.OG_SIGNING_SECRET || process.env.ENCRYPTION_KEY || null
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function sameValue(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return toBase64Url(new Uint8Array(signature))
}

function payload(source: string, traderId: string, expiresAt: number): string {
  return `${VERSION}:${source.toLowerCase()}:${traderId}:${expiresAt}`
}

export async function createOgVerificationProof(
  source: string,
  traderId: string,
  options: { now?: number; ttlMs?: number } = {}
): Promise<string | null> {
  const secret = signingSecret()
  if (!secret || !source || !traderId) return null

  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? DEFAULT_TTL_MS)
  return `${expiresAt}.${await sign(payload(source, traderId, expiresAt), secret)}`
}

export async function verifyOgVerificationProof(
  source: string,
  traderId: string,
  proof: string | null,
  options: { now?: number } = {}
): Promise<boolean> {
  const secret = signingSecret()
  if (!secret || !source || !traderId || !proof) return false

  const match = proof.match(/^(\d{13})\.([A-Za-z0-9_-]{43})$/)
  if (!match) return false
  const expiresAt = Number(match[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= (options.now ?? Date.now())) return false

  const expected = await sign(payload(source, traderId, expiresAt), secret)
  return sameValue(match[2], expected)
}
