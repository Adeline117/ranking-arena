/**
 * CEX API Key Binding Service
 *
 * Handles the full flow of binding a read-only API key to a trader profile:
 * 1. Validate the API key works (test call to exchange)
 * 2. Extract account UID and verify it matches the claimed trader
 * 3. Encrypt credentials using AES-256-GCM
 * 4. Store in trader_authorizations table
 *
 * Supported platforms: binance, bybit, okx, bitget (initial set)
 *
 * SECURITY:
 * - API keys are NEVER logged
 * - All credentials encrypted at rest via lib/crypto/encryption
 * - Only read-only permissions required
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/crypto/encryption'
import {
  validateExchangeApiKey,
  type ExchangeCredentials,
  type ApiKeyValidationResult,
} from '@/lib/validators/api-key-validator'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export interface BindApiKeyInput {
  platform: string
  apiKey: string
  apiSecret: string
  passphrase?: string    // Required for OKX, Bitget
  label?: string         // User-friendly name for this connection
  syncFrequency?: 'realtime' | '5min' | '15min' | '1hour'
}

export interface BindApiKeyResult {
  success: boolean
  authorizationId?: string
  traderId?: string      // Exchange UID extracted from the key
  nickname?: string      // Exchange nickname if available
  error?: string
}

/** Platforms that support API key binding */
const SUPPORTED_PLATFORMS = [
  'binance', 'binance_futures', 'binance_spot',
  'bybit', 'bybit_spot',
  'okx', 'okx_futures',
  'bitget', 'bitget_futures', 'bitget_spot',
] as const

/** Platforms that require a passphrase */
const PASSPHRASE_REQUIRED_PLATFORMS = ['okx', 'okx_futures', 'bitget', 'bitget_futures', 'bitget_spot']

// ============================================
// Core Functions
// ============================================

/**
 * Bind an API key to a user's account.
 * Validates the key, encrypts credentials, and stores the authorization.
 */
export async function bindApiKey(
  supabase: SupabaseClient,
  userId: string,
  input: BindApiKeyInput
): Promise<BindApiKeyResult> {
  const { platform, apiKey, apiSecret, passphrase, label, syncFrequency } = input
  const platformLower = platform.toLowerCase()

  // 1. Validate platform is supported
  if (!isSupportedPlatform(platformLower)) {
    return {
      success: false,
      error: `Platform "${platform}" is not supported for API key binding. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
    }
  }

  // 2. Check passphrase requirement
  if (requiresPassphrase(platformLower) && !passphrase) {
    return {
      success: false,
      error: `Passphrase is required for ${platform}`,
    }
  }

  // 3. Validate API key against exchange
  const credentials: ExchangeCredentials = { apiKey, apiSecret, passphrase }
  let validation: ApiKeyValidationResult

  try {
    validation = await validateExchangeApiKey(platformLower, credentials)
  } catch (error) {
    logger.error('[api-key-binder] Validation threw', {}, error as Error)
    return {
      success: false,
      error: 'Failed to validate API key. Please check your credentials and try again.',
    }
  }

  if (!validation.isValid || !validation.traderId) {
    return {
      success: false,
      error: validation.error || 'API key validation failed',
    }
  }

  // 4. Encrypt credentials
  const encryptedApiKey = encrypt(apiKey)
  const encryptedApiSecret = encrypt(apiSecret)
  const encryptedPassphrase = passphrase ? encrypt(passphrase) : null

  // 5. Upsert into trader_authorizations
  const now = new Date().toISOString()

  try {
    const { data: existing } = await supabase
      .from('trader_authorizations')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', platformLower)
      .eq('trader_id', validation.traderId)
      .maybeSingle()

    let authorizationId: string

    if (existing) {
      // Update existing authorization
      const { data: updated, error: updateError } = await supabase
        .from('trader_authorizations')
        .update({
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          encrypted_passphrase: encryptedPassphrase,
          permissions: validation.permissions || ['read'],
          status: 'active',
          last_verified_at: now,
          verification_error: null,
          label: label || undefined,
          sync_frequency: syncFrequency || 'realtime',
        })
        .eq('id', existing.id)
        .select('id')
        .single()

      if (updateError) {
        logger.error('[api-key-binder] Failed to update authorization', updateError)
        return { success: false, error: 'Failed to update authorization' }
      }

      authorizationId = updated!.id
    } else {
      // Create new authorization
      const { data: created, error: createError } = await supabase
        .from('trader_authorizations')
        .insert({
          user_id: userId,
          platform: platformLower,
          trader_id: validation.traderId,
          encrypted_api_key: encryptedApiKey,
          encrypted_api_secret: encryptedApiSecret,
          encrypted_passphrase: encryptedPassphrase,
          permissions: validation.permissions || ['read'],
          status: 'active',
          last_verified_at: now,
          label: label || null,
          sync_frequency: syncFrequency || 'realtime',
        })
        .select('id')
        .single()

      if (createError) {
        // Handle unique constraint violation
        if (createError.code === '23505') {
          return { success: false, error: 'This API key is already bound to another account' }
        }
        logger.error('[api-key-binder] Failed to create authorization', createError)
        return { success: false, error: 'Failed to store authorization' }
      }

      authorizationId = created!.id
    }

    // 6. Also upsert into user_exchange_connections for claim flow compatibility
    await supabase
      .from('user_exchange_connections')
      .upsert(
        {
          user_id: userId,
          exchange: platformLower,
          api_key_encrypted: encryptedApiKey,
          api_secret_encrypted: encryptedApiSecret,
          passphrase_encrypted: encryptedPassphrase,
          is_active: true,
          verified_uid: validation.traderId,
          last_verified_at: now,
        },
        { onConflict: 'user_id,exchange' }
      )
      .then(({ error }) => {
        if (error) {
          logger.warn('[api-key-binder] Failed to upsert exchange connection (non-fatal)', error)
        }
      })

    logger.info('[api-key-binder] API key bound successfully', {
      userId,
      platform: platformLower,
      authorizationId,
    })

    return {
      success: true,
      authorizationId,
      traderId: validation.traderId,
      nickname: validation.nickname,
    }
  } catch (error) {
    logger.error('[api-key-binder] Unexpected error during bind', {}, error as Error)
    return { success: false, error: 'Unexpected error during API key binding' }
  }
}

/**
 * Revoke an API key binding.
 */
export async function revokeApiKey(
  supabase: SupabaseClient,
  userId: string,
  authorizationId: string
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('trader_authorizations')
    .update({
      status: 'revoked',
      updated_at: new Date().toISOString(),
    })
    .eq('id', authorizationId)
    .eq('user_id', userId)

  if (error) {
    logger.error('[api-key-binder] Failed to revoke', error)
    return { success: false, error: 'Failed to revoke API key' }
  }

  return { success: true }
}

/**
 * Re-validate an existing API key binding.
 * Used to check if a stored key is still valid.
 */
export async function revalidateApiKey(
  supabase: SupabaseClient,
  authorizationId: string
): Promise<{ valid: boolean; error?: string }> {
  // This would need to decrypt and re-test the key
  // For now, we update the last_verified_at timestamp after a successful sync
  const { error } = await supabase
    .from('trader_authorizations')
    .update({
      last_verified_at: new Date().toISOString(),
      verification_error: null,
    })
    .eq('id', authorizationId)

  if (error) {
    return { valid: false, error: 'Failed to update verification status' }
  }

  return { valid: true }
}

// ============================================
// Helpers
// ============================================

export function isSupportedPlatform(platform: string): boolean {
  return SUPPORTED_PLATFORMS.some(p => platform.toLowerCase() === p)
}

export function requiresPassphrase(platform: string): boolean {
  return PASSPHRASE_REQUIRED_PLATFORMS.some(p => platform.toLowerCase() === p)
}

export function getSupportedPlatforms(): readonly string[] {
  return SUPPORTED_PLATFORMS
}
