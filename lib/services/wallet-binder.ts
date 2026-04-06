/**
 * DEX Wallet Binding Service
 *
 * Handles wallet-based trader verification for DEX platforms:
 * 1. Accept wallet address + signed message
 * 2. Verify signature (EIP-191 for EVM, ed25519 for Solana)
 * 3. Verify wallet address matches the trader's source_trader_id
 * 4. Store wallet association in trader_authorizations
 *
 * Supported chains:
 * - EVM (Ethereum/Arbitrum): Hyperliquid, GMX, dYdX, Gains, Aevo
 * - Solana: Drift, Jupiter Perps
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { verifyMessage } from 'viem'
import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { logger } from '@/lib/logger'
import {
  isDexWalletPlatform,
  isSolanaPlatform,
} from '@/lib/validators/exchange-uid-resolver'

// ============================================
// Types
// ============================================

export interface BindWalletInput {
  platform: string
  walletAddress: string
  signature: string
  message: string
}

export interface BindWalletResult {
  success: boolean
  authorizationId?: string
  chain?: 'evm' | 'solana'
  error?: string
}

// ============================================
// Core Functions
// ============================================

/**
 * Bind a wallet to a trader profile by verifying signature ownership.
 *
 * Flow:
 * 1. Validate platform supports wallet binding
 * 2. Verify the signature matches the wallet address
 * 3. Verify the wallet address matches the trader (traderKey = wallet address for DEX)
 * 4. Store in trader_authorizations as a wallet-type authorization
 */
export async function bindWallet(
  supabase: SupabaseClient,
  userId: string,
  input: BindWalletInput
): Promise<BindWalletResult> {
  const { platform, walletAddress, signature, message } = input
  const platformLower = platform.toLowerCase()

  // 1. Validate platform supports wallet binding
  if (!isDexWalletPlatform(platformLower)) {
    return {
      success: false,
      error: `Platform "${platform}" does not support wallet binding. Supported: hyperliquid, gmx, dydx, gains, aevo, drift, jupiter_perps`,
    }
  }

  // 2. Determine chain type
  const isSolana = isSolanaPlatform(platformLower)
  const chain: 'evm' | 'solana' = isSolana ? 'solana' : 'evm'

  // 3. Validate wallet address format
  if (!isValidWalletAddress(walletAddress, chain)) {
    return {
      success: false,
      error: `Invalid ${chain.toUpperCase()} wallet address format`,
    }
  }

  // 4. Verify signature
  let signatureValid: boolean
  try {
    if (isSolana) {
      signatureValid = verifySolanaSignature(walletAddress, message, signature)
    } else {
      signatureValid = await verifyEvmSignature(walletAddress, message, signature)
    }
  } catch (error) {
    logger.error('[wallet-binder] Signature verification threw', {}, error as Error)
    return {
      success: false,
      error: 'Signature verification failed. Please try signing again.',
    }
  }

  if (!signatureValid) {
    return {
      success: false,
      error: 'Invalid signature. The signed message does not match your wallet.',
    }
  }

  // 5. Parse and validate the message (replay prevention)
  const parsed = parseClaimMessage(message)
  if (!parsed) {
    return {
      success: false,
      error: 'Invalid message format. Please use the signing flow provided by Arena.',
    }
  }

  // Check message freshness (5 minute window)
  const messageAge = Date.now() - parsed.timestamp
  if (messageAge > 5 * 60 * 1000 || messageAge < -60000) {
    return {
      success: false,
      error: 'Signature message has expired. Please sign a new message.',
    }
  }

  // 6. The wallet address IS the trader key for DEX platforms
  const traderKey = walletAddress.toLowerCase()

  // 7. Verify trader exists in our database
  const { data: traderExists } = await supabase
    .from('trader_sources')
    .select('source_trader_id')
    .eq('source', platformLower)
    .ilike('source_trader_id', traderKey)
    .limit(1)
    .maybeSingle()

  if (!traderExists) {
    // Also check leaderboard_ranks as fallback
    const { data: lrExists } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id')
      .eq('source', platformLower)
      .ilike('source_trader_id', traderKey)
      .limit(1)
      .maybeSingle()

    if (!lrExists) {
      return {
        success: false,
        error: 'This wallet address is not found as a trader on the specified platform in Arena.',
      }
    }
  }

  // 8. Store authorization (wallet type — no encrypted keys needed)
  const now = new Date().toISOString()

  try {
    const { data: existing } = await supabase
      .from('trader_authorizations')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', platformLower)
      .eq('trader_id', traderKey)
      .maybeSingle()

    let authorizationId: string

    if (existing) {
      const { data: updated, error: updateError } = await supabase
        .from('trader_authorizations')
        .update({
          // For wallet bindings, we store a placeholder in encrypted fields
          // since the actual credential is the wallet signature (one-time use)
          encrypted_api_key: `wallet:${chain}:${walletAddress}`,
          encrypted_api_secret: `signature_verified:${now}`,
          permissions: ['wallet_owner'],
          status: 'active',
          last_verified_at: now,
          verification_error: null,
          data_source: 'authorized',
        })
        .eq('id', existing.id)
        .select('id')
        .single()

      if (updateError) {
        logger.error('[wallet-binder] Failed to update authorization', updateError)
        return { success: false, error: 'Failed to update wallet binding' }
      }

      authorizationId = updated!.id
    } else {
      const { data: created, error: createError } = await supabase
        .from('trader_authorizations')
        .insert({
          user_id: userId,
          platform: platformLower,
          trader_id: traderKey,
          encrypted_api_key: `wallet:${chain}:${walletAddress}`,
          encrypted_api_secret: `signature_verified:${now}`,
          permissions: ['wallet_owner'],
          status: 'active',
          last_verified_at: now,
          data_source: 'authorized',
        })
        .select('id')
        .single()

      if (createError) {
        if (createError.code === '23505') {
          return { success: false, error: 'This wallet is already bound to another account' }
        }
        logger.error('[wallet-binder] Failed to create authorization', createError)
        return { success: false, error: 'Failed to store wallet binding' }
      }

      authorizationId = created!.id
    }

    logger.info('[wallet-binder] Wallet bound successfully', {
      userId,
      platform: platformLower,
      chain,
      authorizationId,
    })

    return {
      success: true,
      authorizationId,
      chain,
    }
  } catch (error) {
    logger.error('[wallet-binder] Unexpected error', {}, error as Error)
    return { success: false, error: 'Unexpected error during wallet binding' }
  }
}

// ============================================
// Signature Verification
// ============================================

async function verifyEvmSignature(
  address: string,
  message: string,
  signature: string
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch (error) {
    logger.error('[wallet-binder] EVM verification error', {}, error as Error)
    return false
  }
}

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
    logger.error('[wallet-binder] Solana verification error', {}, error as Error)
    return false
  }
}

// ============================================
// Helpers
// ============================================

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

function isValidWalletAddress(address: string, chain: 'evm' | 'solana'): boolean {
  if (chain === 'evm') {
    return /^0x[a-fA-F0-9]{40}$/.test(address)
  }
  // Solana: base58 encoded, 32-44 characters
  try {
    new PublicKey(address)
    return true
  } catch (_err) {
    // Solana PublicKey validation failed — address is invalid
    return false
  }
}

/**
 * Get all supported DEX platforms for wallet binding.
 */
export function getWalletBindablePlatforms(): { platform: string; chain: 'evm' | 'solana' }[] {
  return [
    { platform: 'hyperliquid', chain: 'evm' },
    { platform: 'gmx', chain: 'evm' },
    { platform: 'dydx', chain: 'evm' },
    { platform: 'gains', chain: 'evm' },
    { platform: 'aevo', chain: 'evm' },
    { platform: 'drift', chain: 'solana' },
    { platform: 'jupiter_perps', chain: 'solana' },
  ]
}
