/**
 * Exchange API Key Validator
 * Validates API keys by making test requests to exchange APIs.
 * Now properly extracts account UIDs for ownership verification.
 */

import { logger } from '@/lib/logger'
import { resolveExchangeUid } from './exchange-uid-resolver'

export interface ApiKeyValidationResult {
  isValid: boolean
  traderId?: string // UID or account ID from exchange
  nickname?: string
  permissions?: string[]
  error?: string
  details?: Record<string, unknown>
}

export interface ExchangeCredentials {
  apiKey: string
  apiSecret: string
  passphrase?: string // For OKX, Bitget
}

/**
 * Validate Binance API Key - extracts real UID
 */
export async function validateBinanceApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const uidResult = await resolveExchangeUid('binance', credentials)

    if (!uidResult.success) {
      return { isValid: false, error: uidResult.error || 'Invalid API key' }
    }

    return {
      isValid: true,
      traderId: uidResult.uid,
      nickname: uidResult.nickname,
      permissions: ['read'],
    }
  } catch (error) {
    logger.error('[Validator] Binance API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Validate Bybit API Key - extracts real UID
 */
export async function validateBybitApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const uidResult = await resolveExchangeUid('bybit', credentials)

    if (!uidResult.success) {
      return { isValid: false, error: uidResult.error || 'Invalid API key' }
    }

    return {
      isValid: true,
      traderId: uidResult.uid,
      nickname: uidResult.nickname,
      permissions: ['read'],
    }
  } catch (error) {
    logger.error('[Validator] Bybit API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Validate OKX API Key - uses /api/v5/account/config for UID
 */
export async function validateOKXApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    if (!credentials.passphrase) {
      return { isValid: false, error: 'Passphrase is required for OKX' }
    }

    const uidResult = await resolveExchangeUid('okx', credentials)

    if (!uidResult.success) {
      return { isValid: false, error: uidResult.error || 'Invalid API key' }
    }

    return {
      isValid: true,
      traderId: uidResult.uid,
      nickname: uidResult.nickname,
      permissions: ['read_balance', 'read_positions'],
    }
  } catch (error) {
    logger.error('[Validator] OKX API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Validate Bitget API Key - uses /api/v2/spot/account/info for userId
 */
export async function validateBitgetApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    if (!credentials.passphrase) {
      return { isValid: false, error: 'Passphrase is required for Bitget' }
    }

    const uidResult = await resolveExchangeUid('bitget', credentials)

    if (!uidResult.success) {
      return { isValid: false, error: uidResult.error || 'Invalid API key' }
    }

    return {
      isValid: true,
      traderId: uidResult.uid,
      permissions: ['read_account'],
    }
  } catch (error) {
    logger.error('[Validator] Bitget API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Validate Gate.io API Key
 */
export async function validateGateApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const uidResult = await resolveExchangeUid('gateio', credentials)

    if (!uidResult.success) {
      return { isValid: false, error: uidResult.error || 'Invalid API key' }
    }

    return {
      isValid: true,
      traderId: uidResult.uid,
      permissions: ['read'],
    }
  } catch (error) {
    logger.error('[Validator] Gate.io API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Validate HTX API Key
 */
export async function validateHtxApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const uidResult = await resolveExchangeUid('htx', credentials)

    if (!uidResult.success) {
      return { isValid: false, error: uidResult.error || 'Invalid API key' }
    }

    return {
      isValid: true,
      traderId: uidResult.uid,
      permissions: ['read'],
    }
  } catch (error) {
    logger.error('[Validator] HTX API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Main validation function - routes to specific exchange validator
 */
export async function validateExchangeApiKey(
  platform: string,
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  const platformLower = platform.toLowerCase()

  switch (platformLower) {
    case 'binance':
    case 'binance_futures':
    case 'binance_spot':
      return validateBinanceApiKey(credentials)

    case 'bybit':
    case 'bybit_spot':
      return validateBybitApiKey(credentials)

    case 'okx':
    case 'okx_futures':
      return validateOKXApiKey(credentials)

    case 'bitget':
    case 'bitget_futures':
    case 'bitget_spot':
      return validateBitgetApiKey(credentials)

    case 'gateio':
    case 'gate':
      return validateGateApiKey(credentials)

    case 'htx':
    case 'htx_futures':
    case 'huobi':
      return validateHtxApiKey(credentials)

    default:
      return {
        isValid: false,
        error: `Unsupported platform: ${platform}`,
      }
  }
}

/**
 * Check if API key has required permissions
 */
export function hasRequiredPermissions(
  result: ApiKeyValidationResult,
  required: string[]
): boolean {
  if (!result.isValid || !result.permissions) {
    return false
  }

  return required.every((perm) => result.permissions!.includes(perm))
}
