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

/**
 * Parse and validate the claim message.
 * Expected format: "I am claiming trader profile {trader_key} on Arena. Timestamp: {unix}"
 */
export function parseClaimMessage(message: string): { traderKey: string; timestamp: number } | null {
  const match = message.match(
    /^I am claiming trader profile (.+) on Arena\. Timestamp: (\d+)$/
  )
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
function verifySolanaSignature(
  address: string,
  message: string,
  signature: string
): boolean {
  try {
    const publicKey = new PublicKey(address)
    const messageBytes = new TextEncoder().encode(message)
    const signatureBytes = Buffer.from(signature, 'base64')

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey.toBytes()
    )
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
  const { wallet_address, signature, message, platform, trader_key } = input

  // Validate required fields
  if (!wallet_address || !signature || !message || !platform) {
    throw new Error('Missing required fields: wallet_address, signature, message, platform')
  }

  // Validate platform is a DEX
  if (!isDexWalletPlatform(platform)) {
    throw new Error(`Platform ${platform} does not support wallet signature verification`)
  }

  // Parse and validate the message
  const parsed = parseClaimMessage(message)
  if (!parsed) {
    throw new Error(`Invalid message format. Expected: "${MESSAGE_PREFIX} {trader_key} on Arena. Timestamp: {unix}"`)
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
  if (trader_key && parsed.traderKey !== trader_key) {
    throw new Error('Message trader key does not match the claimed trader')
  }

  // Verify the signature
  const isSolana = isSolanaPlatform(platform)
  let isValid: boolean

  if (isSolana) {
    isValid = verifySolanaSignature(wallet_address, message, signature)
  } else {
    isValid = await verifyEvmSignature(wallet_address, message, signature)
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
  const traderKeyToCheck = trader_key || parsed.traderKey

  // Look up trader via unified resolveTrader()
  const resolved = await resolveTrader(supabase, {
    handle: traderKeyToCheck,
    platform,
  })

  const knownTraderKey = resolved?.traderKey || traderKeyToCheck

  // Compare wallet address with trader key (case-insensitive for EVM addresses)
  const walletNorm = wallet_address.toLowerCase()
  const traderNorm = String(knownTraderKey).toLowerCase()

  if (walletNorm !== traderNorm) {
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
    wallet_address,
    chain: isSolana ? 'solana' : 'evm',
    message: 'Wallet ownership verified successfully',
  }
}
