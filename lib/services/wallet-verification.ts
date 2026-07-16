/**
 * Wallet Signature Verification Service
 *
 * Extracted from /api/traders/claim/verify-wallet to allow direct
 * in-process verification without HTTP self-fetch.
 *
 * Supports:
 * - EVM chains (Ethereum, Arbitrum, etc.): Hyperliquid, GMX, Gains, Aevo, Kwenta, Vertex, dYdX
 * - Solana: Jupiter Perps, Drift
 */

import { verifyMessage } from 'viem'
import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isSolanaPlatform, isDexWalletPlatform } from '@/lib/validators/exchange-uid-resolver'
import { logger } from '@/lib/logger'
import { resolveTrader } from '@/lib/data/unified'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { canonicalizeWalletIdentity, walletIdentitiesMatch } from '@/lib/validators/wallet-identity'

/** Maximum age of a signature message (5 minutes) */
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000

/** Expected message format prefix */
const MESSAGE_PREFIX = 'I am claiming trader profile'

export interface WalletVerificationInput {
  wallet_address: string
  signature: string
  message: string
  platform: string
  trader_key?: string
}

export interface WalletVerificationResult {
  verified: boolean
  wallet_address: string
  chain: 'solana' | 'evm'
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

/**
 * Parse and validate the claim message.
 * Expected format: "I am claiming trader profile {trader_key} on Arena. Timestamp: {unix}"
 */
export function parseClaimMessage(
  message: string
): { traderKey: string; timestamp: number } | null {
  const match = message.match(/^I am claiming trader profile (.+) on Arena\. Timestamp: (\d+)$/)
  if (!match) return null

  return {
    traderKey: match[1],
    timestamp: parseInt(match[2], 10),
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
 * Verify Solana wallet signature using tweetnacl.
 */
function verifySolanaSignature(address: string, message: string, signature: string): boolean {
  try {
    const publicKey = new PublicKey(address)
    const messageBytes = new TextEncoder().encode(message)
    const signatureBytes = Buffer.from(signature, 'base64')

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey.toBytes())
  } catch (error) {
    logger.error('[verify-wallet] Solana signature verification failed', {}, error as Error)
    return false
  }
}

/**
 * Verify wallet ownership for a DEX trader claim.
 *
 * This performs all validation steps:
 * 1. Validate platform is a DEX
 * 2. Parse and validate message format
 * 3. Check message freshness (replay prevention)
 * 4. Check signature dedup via Redis
 * 5. Verify cryptographic signature (EVM or Solana)
 * 6. Verify wallet matches trader's source_trader_id
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
  const message = requireInputString(input.message, 'message', 2048)
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

  // Parse and validate the message
  const parsed = parseClaimMessage(message)
  if (!parsed) {
    throw new Error(
      `Invalid message format. Expected: "${MESSAGE_PREFIX} {trader_key} on Arena. Timestamp: {unix}"`
    )
  }

  // Check message freshness (prevent replay attacks)
  const messageAge = Date.now() - parsed.timestamp
  if (messageAge > MAX_MESSAGE_AGE_MS || messageAge < -60000) {
    throw new Error('Signature message has expired. Please sign a new message.')
  }

  // Replay prevention: check if this exact signature was already used (Redis dedup, 10min TTL)
  try {
    const redis = await getSharedRedis()
    if (redis) {
      const sigKey = `wallet-sig:${signature.slice(0, 32)}`
      const existing = await redis.get(sigKey)
      if (existing) {
        throw new Error('This signature has already been used. Please sign a new message.')
      }
      await redis.set(sigKey, '1', { ex: 600 }) // 10min TTL (covers the 5min message age window + buffer)
    }
  } catch (err) {
    // Re-throw our own errors (signature already used)
    if (err instanceof Error && err.message.includes('already been used')) {
      throw err
    }
    logger.warn('[verify-wallet] Redis nonce check failed, continuing without dedup:', err)
  }

  // If trader_key is provided, validate it matches the message
  if (traderKey && !walletIdentitiesMatch(parsed.traderKey, traderKey, platform)) {
    throw new Error('Message trader key does not match the claimed trader')
  }

  // Verify the signature
  const isSolana = isSolanaPlatform(platform)
  let isValid: boolean

  if (isSolana) {
    isValid = verifySolanaSignature(canonicalWalletAddress, message, signature)
  } else {
    isValid = await verifyEvmSignature(canonicalWalletAddress, message, signature)
  }

  if (!isValid) {
    logger.warn('[verify-wallet] Signature verification failed', {
      userId,
      platform,
      chain: isSolana ? 'solana' : 'evm',
    })
    throw new Error('Wallet signature verification failed. Please try signing again.')
  }

  // Verify wallet_address matches the trader's source_trader_id (unified data layer)
  const traderKeyToCheck = canonicalizeWalletIdentity(traderKey || parsed.traderKey, platform)

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
    chain: isSolana ? 'solana' : 'evm',
  })

  return {
    verified: true,
    wallet_address: canonicalWalletAddress,
    chain: isSolana ? 'solana' : 'evm',
    message: 'Wallet ownership verified successfully',
  }
}
