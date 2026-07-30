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
import { encryptAuthorizationCredential } from '@/lib/exchange/authorization-credentials'
import { traderAuthorizationBindResultSchema } from '@/lib/exchange/api-key-lifecycle'
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
  passphrase?: string // Required for OKX, Bitget
  label?: string // User-friendly name for this connection
  syncFrequency?: 'realtime' | '5min' | '15min' | '1hour'
}

export interface BindApiKeyResult {
  success: boolean
  authorizationId?: string
  traderId?: string // Exchange UID extracted from the key
  nickname?: string // Exchange nickname if available
  permissions?: string[]
  reason?: 'invalid_input' | 'validation_failed' | 'account_unavailable' | 'persistence_failed'
  error?: string
}

/** Platforms that support API key binding */
const SUPPORTED_PLATFORMS = [
  'binance',
  'binance_futures',
  'binance_spot',
  'bybit',
  'bybit_spot',
  'okx',
  'okx_futures',
  'bitget',
  'bitget_futures',
  'bitget_spot',
] as const

/** Platforms that require a passphrase */
const PASSPHRASE_REQUIRED_PLATFORMS = [
  'okx',
  'okx_futures',
  'bitget',
  'bitget_futures',
  'bitget_spot',
]

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
      reason: 'invalid_input',
      error: `Platform "${platform}" is not supported for API key binding. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
    }
  }

  // 2. Check passphrase requirement
  if (requiresPassphrase(platformLower) && !passphrase) {
    return {
      success: false,
      reason: 'invalid_input',
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
      reason: 'validation_failed',
      error: 'Failed to validate API key. Please check your credentials and try again.',
    }
  }

  if (!validation.isValid || !validation.traderId) {
    return {
      success: false,
      reason: 'validation_failed',
      error: validation.error || 'API key validation failed',
    }
  }
  const traderId = validation.traderId.trim()
  if (!traderId) {
    return {
      success: false,
      reason: 'validation_failed',
      error: 'API key validation returned an invalid account ID',
    }
  }

  // 4. Encrypt credentials
  const encryptedApiKey = encryptAuthorizationCredential(apiKey)
  const encryptedApiSecret = encryptAuthorizationCredential(apiSecret)
  const encryptedPassphrase = passphrase ? encryptAuthorizationCredential(passphrase) : null

  const permissions = validation.permissions?.length ? validation.permissions : ['read']

  try {
    // The proof connection and worker authorization are one security fact.
    // Store both in one lifecycle-locked transaction so neither can survive
    // alone and a concurrent ban/delete cannot be followed by reactivation.
    const { data, error } = await supabase.rpc(
      'bind_trader_authorization_for_active_profile_atomic',
      {
        p_user_id: userId,
        p_platform: platformLower,
        p_trader_id: traderId,
        p_api_key_encrypted: encryptedApiKey,
        p_api_secret_encrypted: encryptedApiSecret,
        p_passphrase_encrypted: encryptedPassphrase,
        p_permissions: permissions,
        p_label: label?.trim() || null,
        p_sync_frequency: syncFrequency || 'realtime',
      }
    )

    if (error) {
      logger.error('[api-key-binder] Atomic bind failed', error)
      return {
        success: false,
        reason: 'persistence_failed',
        error: 'Failed to store authorization',
      }
    }

    const parsed = traderAuthorizationBindResultSchema.safeParse(data)
    if (!parsed.success) {
      logger.error('[api-key-binder] Atomic bind returned an invalid acknowledgement')
      return {
        success: false,
        reason: 'persistence_failed',
        error: 'Failed to store authorization',
      }
    }
    if (parsed.data.status === 'suspended' || parsed.data.status === 'missing_account') {
      return {
        success: false,
        reason: 'account_unavailable',
        error: 'Account unavailable',
      }
    }
    if (
      parsed.data.status !== 'bound' ||
      parsed.data.user_id !== userId ||
      parsed.data.platform !== platformLower ||
      parsed.data.trader_id !== traderId
    ) {
      logger.error('[api-key-binder] Atomic bind was rejected', {
        userId,
        platform: platformLower,
        status: parsed.data.status,
      })
      return {
        success: false,
        reason: parsed.data.status === 'invalid' ? 'invalid_input' : 'persistence_failed',
        error: 'Failed to store authorization',
      }
    }

    const authorizationId = parsed.data.authorization_id

    logger.info('[api-key-binder] API key bound successfully', {
      userId,
      platform: platformLower,
      authorizationId,
    })

    return {
      success: true,
      authorizationId,
      traderId,
      nickname: validation.nickname,
      permissions,
    }
  } catch (error) {
    logger.error('[api-key-binder] Unexpected error during bind', {}, error as Error)
    return {
      success: false,
      reason: 'persistence_failed',
      error: 'Unexpected error during API key binding',
    }
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

// ============================================
// Helpers
// ============================================

export function isSupportedPlatform(platform: string): boolean {
  return SUPPORTED_PLATFORMS.some((p) => platform.toLowerCase() === p)
}

export function requiresPassphrase(platform: string): boolean {
  return PASSPHRASE_REQUIRED_PLATFORMS.some((p) => platform.toLowerCase() === p)
}

export function getSupportedPlatforms(): readonly string[] {
  return SUPPORTED_PLATFORMS
}
