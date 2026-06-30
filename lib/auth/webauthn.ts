/**
 * WebAuthn / Passkey shared helpers
 *
 * - RP ID + expected origin are resolved against a fixed ALLOWLIST (prod www/apex
 *   share rpID arenafi.org; localhost allowed for dev) — request headers only
 *   SELECT among known-good origins, never define them (phishing defense).
 * - Challenges are stored in Redis with a short TTL, consumed atomically (GETDEL).
 *
 * Registration challenges are keyed by the authenticated user id.
 * Authentication challenges are keyed by a random opaque `challengeKey`
 * (there is no user yet at the start of a passwordless login).
 */

import type { NextRequest } from 'next/server'
import { getSharedRedis } from '@/lib/cache/redis-client'

export const RP_NAME = 'Arena'

/** Challenges expire after 5 minutes — matches the SIWE nonce TTL. */
const CHALLENGE_TTL_SECONDS = 300

export interface WebAuthnConfig {
  /** Effective Relying Party ID — the registrable domain (no scheme, no port). */
  rpID: string
  /** Full expected origin, e.g. `https://www.arenafi.org` or `http://localhost:3000`. */
  origin: string
  rpName: string
}

/**
 * Resolve the RP ID + expected origin for the incoming request against a fixed
 * ALLOWLIST — never trust the request headers blindly (that would delete
 * WebAuthn's server-side phishing/origin defense; see security review).
 *
 * Production hosts (www + apex) share rpID `arenafi.org` (the registrable
 * domain) so a passkey works on both. The request's host only SELECTS among
 * known-good origins; anything unrecognized is rejected. localhost is allowed
 * with a header-derived origin (dev convenience — not a phishing boundary).
 */
const PROD_ORIGINS: Record<string, string> = {
  'www.arenafi.org': 'https://www.arenafi.org',
  'arenafi.org': 'https://arenafi.org',
}
/** Canonical RP ID for production (registrable suffix of both www + apex). */
const PROD_RP_ID = 'arenafi.org'

export function getWebAuthnConfig(request: NextRequest): WebAuthnConfig {
  const headerOrigin = request.headers.get('origin') || ''
  let host = ''
  try {
    host = headerOrigin
      ? new URL(headerOrigin).hostname
      : request.headers.get('host')?.split(':')[0] || ''
  } catch {
    host = ''
  }

  // Production: strict allowlist, constant rpID across www/apex.
  if (PROD_ORIGINS[host]) {
    return { rpID: PROD_RP_ID, origin: PROD_ORIGINS[host], rpName: RP_NAME }
  }

  // Dev only: localhost/127.0.0.1 (any port) — not a phishing boundary.
  if (host === 'localhost' || host === '127.0.0.1') {
    const origin = headerOrigin || `http://${host}:3000`
    return { rpID: host, origin, rpName: RP_NAME }
  }

  // Unrecognized origin — refuse rather than echo an attacker-controlled host.
  throw new Error('Unrecognized WebAuthn origin')
}

// ============================================================
// Challenge store (Redis, single-use, short TTL)
// ============================================================

function regKey(userId: string): string {
  return `webauthn:reg:${userId}`
}

function authKey(challengeKey: string): string {
  return `webauthn:auth:${challengeKey}`
}

/** Store a registration challenge keyed by the authenticated user id. */
export async function storeRegistrationChallenge(userId: string, challenge: string): Promise<void> {
  const redis = await getSharedRedis()
  if (!redis) throw new Error('Challenge store unavailable')
  await redis.set(regKey(userId), challenge, { ex: CHALLENGE_TTL_SECONDS })
}

/** Read + consume a registration challenge atomically (GETDEL → replay-safe). */
export async function consumeRegistrationChallenge(userId: string): Promise<string | null> {
  const redis = await getSharedRedis()
  if (!redis) throw new Error('Challenge store unavailable')
  const challenge = await redis.getdel<string>(regKey(userId))
  return challenge ?? null
}

/** Store an authentication challenge keyed by an opaque random id. */
export async function storeAuthenticationChallenge(
  challengeKey: string,
  challenge: string
): Promise<void> {
  const redis = await getSharedRedis()
  if (!redis) throw new Error('Challenge store unavailable')
  await redis.set(authKey(challengeKey), challenge, { ex: CHALLENGE_TTL_SECONDS })
}

/** Read + consume an authentication challenge atomically (GETDEL → replay-safe). */
export async function consumeAuthenticationChallenge(challengeKey: string): Promise<string | null> {
  const redis = await getSharedRedis()
  if (!redis) throw new Error('Challenge store unavailable')
  const challenge = await redis.getdel<string>(authKey(challengeKey))
  return challenge ?? null
}
