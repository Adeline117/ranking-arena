/**
 * CEX API Key Binding Service
 *
 * Handles the full flow of binding a read-only CEX key for first-party account
 * sync. An exchange account UID is not public-leaderboard claim proof.
 * 1. Validate the API key works (test call to exchange)
 * 2. Extract the exchange's private account UID for the connection record
 * 3. Encrypt credentials using AES-256-GCM
 * 4. Atomically project both credential records through a service-only RPC
 *
 * V1 public platforms: binance, bybit, bitget (exact base IDs only)
 *
 * SECURITY:
 * - API keys are NEVER logged
 * - All credentials encrypted at rest via lib/crypto/encryption
 * - Only read-only permissions required
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { encryptAuthorizationCredential } from '@/lib/exchange/authorization-credentials'
import {
  validateExchangeApiKey,
  type ExchangeCredentials,
  type ApiKeyValidationResult,
} from '@/lib/validators/api-key-validator'
import { accountConnectionExchangeForSource } from '@/lib/constants/trader-claim-platforms'
import { logger } from '@/lib/logger'

// ============================================
// Types
// ============================================

export interface BindApiKeyInput {
  platform: string
  apiKey: string
  apiSecret: string
  passphrase?: string // Required for Bitget
  label?: string // User-friendly name for this connection
  syncFrequency?: 'realtime' | '5min' | '15min' | '1hour'
}

export interface BindApiKeyResult {
  success: boolean
  authorizationId?: string
  traderId?: string // Exchange UID extracted from the key
  nickname?: string // Exchange nickname if available
  permissions?: string[]
  error?: string
  errorCode?: 'invalid_request' | 'validation_failed' | 'storage_failed'
}

interface AtomicBindingRpcError {
  code?: string
  message?: string
}

interface AtomicAccountLifecycleRpcClient {
  rpc(
    functionName: 'bind_trader_account_connection_v1',
    args: {
      p_user_id: string
      p_platform: string
      p_trader_id: string
      p_encrypted_api_key: string
      p_encrypted_api_secret: string
      p_encrypted_passphrase: string | null
      p_permissions: string[]
      p_verified_at: string
      p_label: string | null
      p_sync_frequency: 'realtime' | '5min' | '15min' | '1hour'
    }
  ): Promise<{
    data: unknown
    error: AtomicBindingRpcError | null
  }>
  rpc(
    functionName: 'revoke_trader_account_connection_v1',
    args: {
      p_user_id: string
      p_authorization_id: string | null
      p_exchange: string | null
    }
  ): Promise<{
    data: unknown
    error: AtomicBindingRpcError | null
  }>
}

/** Platforms that support API key binding */
const SUPPORTED_PLATFORMS = ['binance', 'bybit', 'bitget'] as const

/** Platforms that require a passphrase */
const PASSPHRASE_REQUIRED_PLATFORMS = ['bitget']

// The first eleven are the exact canonical/product keys written by the current
// and historical account binders. The final four are exact base keys written
// by the retired connection endpoint. They remain disconnectable for cleanup;
// wallet/DEx and unproven guessed aliases do not enter the credential RPC.
const DISCONNECTABLE_ACCOUNT_EXCHANGES = [
  'binance',
  'binance_futures',
  'binance_spot',
  'bybit',
  'bybit_spot',
  'okx',
  'okx_futures',
  'okx_spot',
  'bitget',
  'bitget_futures',
  'bitget_spot',
  'mexc',
  'htx',
  'weex',
  'coinex',
] as const

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
  const platformLower = platform.trim().toLowerCase()

  // 1. Validate platform is supported
  if (!isSupportedPlatform(platformLower)) {
    return {
      success: false,
      error: `Platform "${platform}" is not supported for API key binding. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
      errorCode: 'invalid_request',
    }
  }

  // `trader_authorizations.platform` retains the requested account-data
  // variant, while user_exchange_connections uses one canonical connection
  // key per exchange. Neither identity is treated as a leaderboard claim.
  if (!accountConnectionExchangeForSource(platformLower)) {
    return {
      success: false,
      error: `Platform "${platform}" cannot be mapped to an account connection`,
      errorCode: 'invalid_request',
    }
  }

  // 2. Check passphrase requirement
  if (requiresPassphrase(platformLower) && !passphrase) {
    return {
      success: false,
      error: `Passphrase is required for ${platform}`,
      errorCode: 'invalid_request',
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
      errorCode: 'validation_failed',
    }
  }

  if (!validation.isValid || !validation.traderId?.trim()) {
    return {
      success: false,
      error: validation.error || 'API key validation failed',
      errorCode: 'validation_failed',
    }
  }
  const traderId = validation.traderId.trim()

  // 4. Encrypt credentials
  const encryptedApiKey = encryptAuthorizationCredential(apiKey)
  const encryptedApiSecret = encryptAuthorizationCredential(apiSecret)
  const encryptedPassphrase = passphrase ? encryptAuthorizationCredential(passphrase) : null
  const permissions = (validation.permissions ?? [])
    .filter((permission): permission is string => typeof permission === 'string')
    .map((permission) => permission.trim())
    .filter((permission) => permission.length > 0)
  if (permissions.length === 0) {
    return {
      success: false,
      error: 'Exchange did not return auditable read-only permission evidence.',
      errorCode: 'validation_failed',
    }
  }

  // 5. Project both credential records in one database transaction. This RPC
  // is intentionally schema-ahead of generated production types; keep the
  // narrow cast local until the migration is live and types are regenerated.
  const now = new Date().toISOString()
  const rpcClient = supabase as unknown as AtomicAccountLifecycleRpcClient

  try {
    const { data: authorizationId, error: bindingError } = await rpcClient.rpc(
      'bind_trader_account_connection_v1',
      {
        p_user_id: userId,
        p_platform: platformLower,
        p_trader_id: traderId,
        p_encrypted_api_key: encryptedApiKey,
        p_encrypted_api_secret: encryptedApiSecret,
        p_encrypted_passphrase: encryptedPassphrase,
        p_permissions: permissions,
        p_verified_at: now,
        p_label: label?.trim() || null,
        p_sync_frequency: syncFrequency || 'realtime',
      }
    )

    if (bindingError || typeof authorizationId !== 'string' || authorizationId.length === 0) {
      logger.error('[api-key-binder] Atomic account binding failed', {
        code: bindingError?.code,
        message: bindingError?.message,
        returnedAuthorizationId: typeof authorizationId === 'string',
      })
      return {
        success: false,
        error: 'Failed to store API key binding. Please try again.',
        errorCode: 'storage_failed',
      }
    }

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
      error: 'Unexpected error during API key binding',
      errorCode: 'storage_failed',
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
): Promise<{ success: boolean; error?: string; errorCode?: 'not_found' | 'storage_failed' }> {
  return revokeAccountConnection(supabase, userId, {
    authorizationId,
    exchange: null,
  })
}

/** Disconnect by canonical exchange while closing every credential projection. */
export async function disconnectApiKey(
  supabase: SupabaseClient,
  userId: string,
  exchange: string
): Promise<{ success: boolean; error?: string; errorCode?: 'not_found' | 'storage_failed' }> {
  const normalizedExchange = exchange.trim().toLowerCase()
  if (!isDisconnectableAccountExchange(normalizedExchange)) {
    return {
      success: false,
      error: 'Account connection not found',
      errorCode: 'not_found',
    }
  }

  return revokeAccountConnection(supabase, userId, {
    authorizationId: null,
    exchange: normalizedExchange,
  })
}

async function revokeAccountConnection(
  supabase: SupabaseClient,
  userId: string,
  selector: { authorizationId: string | null; exchange: string | null }
): Promise<{ success: boolean; error?: string; errorCode?: 'not_found' | 'storage_failed' }> {
  const rpcClient = supabase as unknown as AtomicAccountLifecycleRpcClient

  try {
    const { data, error } = await rpcClient.rpc('revoke_trader_account_connection_v1', {
      p_user_id: userId,
      p_authorization_id: selector.authorizationId,
      p_exchange: selector.exchange,
    })

    if (error) {
      logger.error('[api-key-binder] Atomic account revocation failed', {
        code: error.code,
        message: error.message,
      })
      return {
        success: false,
        error: 'Failed to revoke API key',
        errorCode: 'storage_failed',
      }
    }

    if (data !== true) {
      return {
        success: false,
        error: 'Account connection not found',
        errorCode: 'not_found',
      }
    }

    return { success: true }
  } catch (error) {
    logger.error('[api-key-binder] Unexpected account revocation failure', {}, error as Error)
    return {
      success: false,
      error: 'Failed to revoke API key',
      errorCode: 'storage_failed',
    }
  }
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

export function isDisconnectableAccountExchange(exchange: string): boolean {
  const normalizedExchange = exchange.trim().toLowerCase()
  return DISCONNECTABLE_ACCOUNT_EXCHANGES.some(
    (supportedExchange) => supportedExchange === normalizedExchange
  )
}
