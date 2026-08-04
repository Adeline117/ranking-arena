/**
 * Exchange API Key Validator
 * Validates API keys by making test requests to exchange APIs.
 * Extracts account UIDs for first-party connection and sync. These UIDs are
 * not public-leaderboard profile claim identifiers.
 */

import { logger } from '@/lib/logger'
import { resolveExchangeUid, type UidResolveResult } from './exchange-uid-resolver'

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

function validatedReadOnlyResult(
  result: UidResolveResult,
  fallbackError: string
): ApiKeyValidationResult {
  if (!result.success || !result.uid) {
    return { isValid: false, error: result.error || fallbackError }
  }
  if (result.isReadOnly !== true) {
    return {
      isValid: false,
      error:
        'API key must be read-only. Disable trading, withdrawal, and transfer permissions before connecting it.',
    }
  }
  const permissions = (result.permissions ?? [])
    .filter((permission): permission is string => typeof permission === 'string')
    .map((permission) => permission.trim())
    .filter(Boolean)
  if (permissions.length === 0) {
    return {
      isValid: false,
      error: 'Exchange did not return auditable read-only permission evidence.',
    }
  }
  return {
    isValid: true,
    traderId: result.uid,
    nickname: result.nickname,
    permissions,
  }
}

/**
 * Validate Binance API Key - extracts real UID
 */
export async function validateBinanceApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const uidResult = await resolveExchangeUid('binance', credentials)

    return validatedReadOnlyResult(uidResult, 'Invalid API key')
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

    return validatedReadOnlyResult(uidResult, 'Invalid API key')
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

    return validatedReadOnlyResult(uidResult, 'Invalid API key')
  } catch (error) {
    logger.error('[Validator] OKX API key validation failed', {}, error as Error)
    return { isValid: false, error: 'Failed to validate API key' }
  }
}

/**
 * Validate Bitget API Key - uses /api/v3/account/info for userId and permType
 */
export async function validateBitgetApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    if (!credentials.passphrase) {
      return { isValid: false, error: 'Passphrase is required for Bitget' }
    }

    const uidResult = await resolveExchangeUid('bitget', credentials)

    return validatedReadOnlyResult(uidResult, 'Invalid API key')
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

    return validatedReadOnlyResult(uidResult, 'Invalid API key')
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

    return validatedReadOnlyResult(uidResult, 'Invalid API key')
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
    case 'okx_spot':
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
