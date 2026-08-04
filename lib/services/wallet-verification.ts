/**
 * Wallet Signature Verification Service
 *
 * Extracted from /api/traders/claim/verify-wallet to allow direct
 * in-process verification without HTTP self-fetch.
 *
 * V1 supports the two EVM leaderboard sources where the public trader
 * identity is the signed wallet address: Hyperliquid and GMX.
 */

import { verifyMessage } from 'viem'
import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'
import { logger } from '@/lib/logger'
import { resolveTrader } from '@/lib/data/unified'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { canonicalizeWalletIdentity, walletIdentitiesMatch } from '@/lib/validators/wallet-identity'

const CHALLENGE_TTL_SECONDS = 5 * 60
const REPLAY_MARKER_TTL_SECONDS = 10 * 60
const CHALLENGE_DOMAIN = 'www.arenafi.org'
const CHALLENGE_KEY_PREFIX = 'wallet-claim:challenge:'
const REPLAY_KEY_PREFIX = 'wallet-claim:replay:'

const RELEASE_REPLAY_RESERVATION_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

const CONSUME_REPLAY_RESERVATION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then
  ttl = tonumber(ARGV[2])
end
redis.call('SET', KEYS[1], 'consumed', 'EX', ttl)
return 1
`

export interface WalletVerificationInput {
  wallet_address: string
  signature: string
  challenge_id: string
  platform: string
  trader_key?: string
}

export interface WalletClaimChallenge {
  challenge_id: string
  message: string
  expires_at: string
}

export interface WalletReplayReservation {
  consume: () => Promise<boolean>
  release: () => Promise<boolean>
}

/**
 * Typed audit fields accepted by submit_trader_claim_v2. These are not a
 * standalone cryptographic credential: the server creates them only after it
 * verifies the wallet signature and reserves the one-time Redis challenge.
 */
export interface WalletClaimChallengeAttestation {
  challenge_id: string
  challenge_issued_at: string
  verified_at: string
  message_sha256: string
  signature_sha256: string
}

export interface WalletVerificationResult {
  verified: boolean
  wallet_address: string
  chain: 'evm'
  message: string
  signed_message: string
  challenge_id: string
  challenge_attestation: WalletClaimChallengeAttestation
  reservation: WalletReplayReservation
}

interface StoredWalletClaimChallenge {
  version: 1
  userId: string
  source: string
  traderKey: string
  nonce: string
  domain: string
  issuedAt: number
  expiresAt: number
  message: string
}

function requireInputString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) {
    throw new Error(`${field} is too long`)
  }
  return value
}

function buildChallengeMessage(challenge: Omit<StoredWalletClaimChallenge, 'message'>): string {
  return [
    'Arena Trader Claim',
    `Domain: ${challenge.domain}`,
    `User ID: ${challenge.userId}`,
    `Source: ${challenge.source}`,
    `Trader ID: ${challenge.traderKey}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${new Date(challenge.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(challenge.expiresAt).toISOString()}`,
  ].join('\n')
}

function parseStoredChallenge(value: unknown): StoredWalletClaimChallenge | null {
  if (typeof value !== 'string') return null

  try {
    const parsed = JSON.parse(value) as Partial<StoredWalletClaimChallenge>
    if (
      parsed.version !== 1 ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.source !== 'string' ||
      typeof parsed.traderKey !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.domain !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.message !== 'string'
    ) {
      return null
    }

    const challenge = parsed as StoredWalletClaimChallenge
    if (
      challenge.domain !== CHALLENGE_DOMAIN ||
      challenge.expiresAt <= challenge.issuedAt ||
      challenge.expiresAt - challenge.issuedAt > CHALLENGE_TTL_SECONDS * 1000 ||
      buildChallengeMessage(challenge) !== challenge.message
    ) {
      return null
    }
    return challenge
  } catch {
    return null
  }
}

function walletChallengeUnavailable(): Error {
  return Object.assign(
    new Error('Wallet claim verification is temporarily unavailable. Please try again later.'),
    {
      code: 'SERVICE_UNAVAILABLE' as const,
      statusCode: 503 as const,
      retryAfter: 30 as const,
    }
  )
}

/**
 * Issue one authenticated, server-authoritative message for a single user,
 * source, and canonical trader identity. Redis is the nonce authority; there
 * is deliberately no in-memory fallback because serverless instances cannot
 * coordinate replay protection.
 */
export async function createWalletClaimChallenge(
  userId: string,
  platform: string,
  traderKey: string
): Promise<WalletClaimChallenge> {
  const source = requireInputString(platform, 'platform', 100).trim().toLowerCase()
  if (!isDexWalletPlatform(source)) {
    throw new Error(`Platform ${source} does not support wallet signature verification`)
  }

  const canonicalTraderKey = canonicalizeWalletIdentity(
    requireInputString(traderKey, 'trader_key', 512),
    source
  )
  const canonicalUserId = requireInputString(userId, 'user_id', 128)
  const redis = await getSharedRedis().catch(() => null)
  if (!redis) throw walletChallengeUnavailable()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const issuedAt = Date.now()
    const nonce = randomBytes(32).toString('hex')
    const challengeWithoutMessage = {
      version: 1 as const,
      userId: canonicalUserId,
      source,
      traderKey: canonicalTraderKey,
      nonce,
      domain: CHALLENGE_DOMAIN,
      issuedAt,
      expiresAt: issuedAt + CHALLENGE_TTL_SECONDS * 1000,
    }
    const challenge: StoredWalletClaimChallenge = {
      ...challengeWithoutMessage,
      message: buildChallengeMessage(challengeWithoutMessage),
    }

    let stored: unknown
    try {
      stored = await redis.set(`${CHALLENGE_KEY_PREFIX}${nonce}`, JSON.stringify(challenge), {
        nx: true,
        ex: CHALLENGE_TTL_SECONDS,
      })
    } catch (error) {
      logger.error('[verify-wallet] Challenge issuance failed', {}, error as Error)
      throw walletChallengeUnavailable()
    }

    if (stored === 'OK') {
      return {
        challenge_id: nonce,
        message: challenge.message,
        expires_at: new Date(challenge.expiresAt).toISOString(),
      }
    }
  }

  throw walletChallengeUnavailable()
}

async function reserveWalletClaimChallenge(
  userId: string,
  source: string,
  traderKey: string,
  challengeId: string
): Promise<{ challenge: StoredWalletClaimChallenge; reservation: WalletReplayReservation }> {
  if (!/^[a-f0-9]{64}$/.test(challengeId)) {
    throw new Error('A valid server-issued wallet challenge is required.')
  }

  const redis = await getSharedRedis().catch(() => null)
  if (!redis) throw walletChallengeUnavailable()

  let storedChallenge: unknown
  try {
    storedChallenge = await redis.get(`${CHALLENGE_KEY_PREFIX}${challengeId}`)
  } catch (error) {
    logger.error('[verify-wallet] Challenge lookup failed', {}, error as Error)
    throw walletChallengeUnavailable()
  }

  const challenge = parseStoredChallenge(storedChallenge)
  if (!challenge || challenge.nonce !== challengeId || challenge.expiresAt <= Date.now()) {
    throw new Error('Wallet claim challenge has expired. Please request a new challenge.')
  }
  if (
    challenge.userId !== userId ||
    challenge.source !== source ||
    !walletIdentitiesMatch(challenge.traderKey, traderKey, source)
  ) {
    throw new Error('Wallet claim challenge does not match this user, source, or trader.')
  }

  const replayKey = `${REPLAY_KEY_PREFIX}${challengeId}`
  const ownerToken = randomBytes(32).toString('hex')
  let acquired: unknown
  try {
    acquired = await redis.set(replayKey, ownerToken, {
      nx: true,
      ex: REPLAY_MARKER_TTL_SECONDS,
    })
  } catch (error) {
    logger.error('[verify-wallet] Challenge reservation failed', {}, error as Error)
    throw walletChallengeUnavailable()
  }

  if (acquired !== 'OK') {
    throw new Error('This wallet claim challenge is already in use or has been consumed.')
  }

  return {
    challenge,
    reservation: {
      consume: async () => {
        const consumed = await redis.eval(
          CONSUME_REPLAY_RESERVATION_SCRIPT,
          [replayKey],
          [ownerToken, REPLAY_MARKER_TTL_SECONDS.toString()]
        )
        return Number(consumed) === 1
      },
      release: async () => {
        const released = await redis.eval(
          RELEASE_REPLAY_RESERVATION_SCRIPT,
          [replayKey],
          [ownerToken]
        )
        return Number(released) === 1
      },
    },
  }
}

/**
 * Verify EVM wallet signature using viem.
 */
async function verifyEvmSignature(
  address: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    return valid
  } catch (error) {
    logger.error('[verify-wallet] EVM signature verification failed', {}, error as Error)
    return false
  }
}

/**
 * Verify wallet ownership for a DEX trader claim.
 *
 * This performs all validation steps:
 * 1. Validate platform is a DEX
 * 2. Load an authenticated server-issued challenge from Redis
 * 3. Atomically reserve its one-time replay marker
 * 4. Verify cryptographic signature
 * 5. Verify wallet matches trader's source_trader_id
 *
 * @throws Error with descriptive message on any validation failure
 */
export async function verifyWalletOwnership(
  supabase: SupabaseClient,
  userId: string,
  input: WalletVerificationInput
): Promise<WalletVerificationResult> {
  const walletAddress = requireInputString(input.wallet_address, 'wallet_address', 512)
  const signature = requireInputString(input.signature, 'signature', 2048)
  const challengeId = requireInputString(input.challenge_id, 'challenge_id', 64).toLowerCase()
  const platform = requireInputString(input.platform, 'platform', 100).trim().toLowerCase()
  const traderKey =
    input.trader_key === undefined
      ? undefined
      : requireInputString(input.trader_key, 'trader_key', 512)

  // Validate platform is a DEX
  if (!isDexWalletPlatform(platform)) {
    throw new Error(`Platform ${platform} does not support wallet signature verification`)
  }

  const canonicalWalletAddress = canonicalizeWalletIdentity(walletAddress, platform)

  const traderKeyToCheck = canonicalizeWalletIdentity(traderKey || walletAddress, platform)
  const { challenge, reservation } = await reserveWalletClaimChallenge(
    userId,
    platform,
    traderKeyToCheck,
    challengeId
  )

  try {
    // Verify the signature against the exact server-issued message.
    const isValid = await verifyEvmSignature(canonicalWalletAddress, challenge.message, signature)

    if (!isValid) {
      logger.warn('[verify-wallet] Signature verification failed', {
        userId,
        platform,
        chain: 'evm',
      })
      throw new Error('Wallet signature verification failed. Please try signing again.')
    }

    // Look up trader via unified resolveTrader()
    const resolved = await resolveTrader(supabase, {
      handle: traderKeyToCheck,
      platform,
    })

    if (!resolved) {
      throw new Error('Trader account was not found in Arena.')
    }

    if (!walletIdentitiesMatch(canonicalWalletAddress, resolved.traderKey, platform)) {
      logger.warn('[verify-wallet] Wallet address mismatch', {
        userId,
        platform,
      })
      throw new Error('Your wallet address does not match this trader account.')
    }

    logger.info('[verify-wallet] Wallet verification passed', {
      userId,
      platform,
      chain: 'evm',
    })

    const verifiedAt = new Date().toISOString()

    return {
      verified: true,
      wallet_address: canonicalWalletAddress,
      chain: 'evm',
      message: 'Wallet ownership verified successfully',
      signed_message: challenge.message,
      challenge_id: challengeId,
      challenge_attestation: {
        challenge_id: challengeId,
        challenge_issued_at: new Date(challenge.issuedAt).toISOString(),
        verified_at: verifiedAt,
        message_sha256: createHash('sha256').update(challenge.message, 'utf8').digest('hex'),
        signature_sha256: createHash('sha256').update(signature, 'utf8').digest('hex'),
      },
      reservation,
    }
  } catch (error) {
    try {
      await reservation.release()
    } catch (releaseError) {
      // Fail closed: a lost cleanup response leaves the short-lived replay
      // marker in place. Never delete a reservation without proving ownership.
      logger.error(
        '[verify-wallet] Challenge reservation cleanup failed',
        {},
        releaseError as Error
      )
    }
    throw error
  }
}
