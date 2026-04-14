/**
 * Wallet Signature Verification for DEX Trader Claims
 * POST /api/traders/claim/verify-wallet
 *
 * Verifies that the user owns the wallet address that matches
 * the trader's source_trader_id on DEX platforms.
 *
 * Supports:
 * - EVM chains (Ethereum, Arbitrum, etc.): Hyperliquid, GMX, Gains, Aevo, Kwenta, Vertex, dYdX
 * - Solana: Jupiter Perps, Drift
 */

import { NextRequest } from 'next/server'
import { verifyMessage } from 'viem'
import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'
import {
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  getSupabaseAdmin,
} from '@/lib/api'
import { ApiError } from '@/lib/api/errors'
import { isSolanaPlatform, isDexWalletPlatform } from '@/lib/validators/exchange-uid-resolver'
import { logger } from '@/lib/logger'
import { resolveTrader } from '@/lib/data/unified'
import { getSharedRedis } from '@/lib/cache/redis-client'

/** Maximum age of a signature message (5 minutes) */
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000

/** Expected message format prefix */
const MESSAGE_PREFIX = 'I am claiming trader profile'

/**
 * Parse and validate the claim message.
 * Expected format: "I am claiming trader profile {trader_key} on Arena. Timestamp: {unix}"
 */
function parseClaimMessage(message: string): { traderKey: string; timestamp: number } | null {
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

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)

    const body = await request.json()
    const { wallet_address, signature, message, platform, trader_key } = body

    // Validate required fields
    if (!wallet_address || !signature || !message || !platform) {
      throw ApiError.validation('Missing required fields: wallet_address, signature, message, platform')
    }

    // Validate platform is a DEX
    if (!isDexWalletPlatform(platform)) {
      throw ApiError.validation(`Platform ${platform} does not support wallet signature verification`)
    }

    // Parse and validate the message
    const parsed = parseClaimMessage(message)
    if (!parsed) {
      throw ApiError.validation(`Invalid message format. Expected: "${MESSAGE_PREFIX} {trader_key} on Arena. Timestamp: {unix}"`)
    }

    // Check message freshness (prevent replay attacks)
    const messageAge = Date.now() - parsed.timestamp
    if (messageAge > MAX_MESSAGE_AGE_MS || messageAge < -60000) {
      throw ApiError.validation('Signature message has expired. Please sign a new message.')
    }

    // Replay prevention: check if this exact signature was already used (Redis dedup, 10min TTL)
    try {
      const redis = await getSharedRedis()
      if (redis) {
        const sigKey = `wallet-sig:${signature.slice(0, 32)}`
        const existing = await redis.get(sigKey)
        if (existing) {
          throw ApiError.validation('This signature has already been used. Please sign a new message.')
        }
        await redis.set(sigKey, '1', { ex: 600 }) // 10min TTL (covers the 5min message age window + buffer)
      }
    } catch (err) {
      logger.warn('[verify-wallet] Redis nonce check failed, continuing without dedup:', err)
    }

    // If trader_key is provided, validate it matches the message
    if (trader_key && parsed.traderKey !== trader_key) {
      throw ApiError.validation('Message trader key does not match the claimed trader')
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
        userId: user.id,
        platform,
        chain: isSolana ? 'solana' : 'evm',
      })
      throw ApiError.validation('Wallet signature verification failed. Please try signing again.')
    }

    // Verify wallet_address matches the trader's source_trader_id (unified data layer)
    const supabase = getSupabaseAdmin()

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
        userId: user.id,
        platform,
      })
      throw ApiError.validation('Your wallet address does not match this trader account.')
    }

    logger.info('[verify-wallet] Wallet verification passed', {
      userId: user.id,
      platform,
      chain: isSolana ? 'solana' : 'evm',
    })

    return success({
      verified: true,
      wallet_address,
      chain: isSolana ? 'solana' : 'evm',
      message: 'Wallet ownership verified successfully',
    })
  } catch (error: unknown) {
    return handleError(error, 'verify-wallet')
  }
}
