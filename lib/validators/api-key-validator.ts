/**
 * Exchange API Key Validator
 * Validates API keys by making test requests to exchange APIs
 */

import { createHmac } from 'crypto'
import { logger } from '@/lib/logger'

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
  passphrase?: string // For OKX
}

/**
 * Validate Binance API Key
 */
export async function validateBinanceApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const { apiKey, apiSecret } = credentials

    // Test endpoint: Account information
    const timestamp = Date.now()
    const queryString = `timestamp=${timestamp}`

    const signature = createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex')

    const response = await fetch(
      `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      {
        headers: {
          'X-MBX-APIKEY': apiKey,
        },
      }
    )

    if (!response.ok) {
      const error = await response.json()
      return {
        isValid: false,
        error: error.msg || 'Invalid API key',
      }
    }

    const data = await response.json()

    // Check if account has trading permissions
    const permissions = []
    if (data.canTrade) permissions.push('trade')
    if (data.canWithdraw) permissions.push('withdraw')
    if (data.canDeposit) permissions.push('deposit')

    return {
      isValid: true,
      traderId: data.uid?.toString() || apiKey.substring(0, 16),
      permissions,
      details: {
        accountType: data.accountType,
        updateTime: data.updateTime,
      },
    }
  } catch (error) {
    logger.error('[Validator] Binance API key validation failed', {}, error as Error)
    return {
      isValid: false,
      error: 'Failed to validate API key',
    }
  }
}

/**
 * Validate Bybit API Key
 */
export async function validateBybitApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const { apiKey, apiSecret } = credentials

    const timestamp = Date.now().toString()
    const recvWindow = '5000'

    // Create signature
    const paramStr = `${timestamp}${apiKey}${recvWindow}`
    const signature = createHmac('sha256', apiSecret)
      .update(paramStr)
      .digest('hex')

    // Test endpoint: Get API key information
    const response = await fetch(
      'https://api.bybit.com/v5/user/query-api',
      {
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-SIGN': signature,
          'X-BAPI-RECV-WINDOW': recvWindow,
        },
      }
    )

    const data = await response.json()

    if (data.retCode !== 0) {
      return {
        isValid: false,
        error: data.retMsg || 'Invalid API key',
      }
    }

    const result = data.result

    return {
      isValid: true,
      traderId: result.uid || result.userID || apiKey.substring(0, 16),
      permissions: result.permissions || [],
      details: {
        readOnly: result.readOnly,
        type: result.type,
        expiredAt: result.expiredAt,
      },
    }
  } catch (error) {
    logger.error('[Validator] Bybit API key validation failed', {}, error as Error)
    return {
      isValid: false,
      error: 'Failed to validate API key',
    }
  }
}

/**
 * Validate OKX API Key
 */
export async function validateOKXApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const { apiKey, apiSecret, passphrase } = credentials

    if (!passphrase) {
      return {
        isValid: false,
        error: 'Passphrase is required for OKX',
      }
    }

    const timestamp = new Date().toISOString()
    const method = 'GET'
    const requestPath = '/api/v5/account/balance'

    // Create signature
    const prehash = timestamp + method + requestPath
    const signature = createHmac('sha256', apiSecret)
      .update(prehash)
      .digest('base64')

    const response = await fetch(
      `https://www.okx.com${requestPath}`,
      {
        headers: {
          'OK-ACCESS-KEY': apiKey,
          'OK-ACCESS-SIGN': signature,
          'OK-ACCESS-TIMESTAMP': timestamp,
          'OK-ACCESS-PASSPHRASE': passphrase,
          'Content-Type': 'application/json',
        },
      }
    )

    const data = await response.json()

    if (data.code !== '0') {
      return {
        isValid: false,
        error: data.msg || 'Invalid API key',
      }
    }

    return {
      isValid: true,
      traderId: apiKey.substring(0, 16), // OKX doesn't return UID in this endpoint
      permissions: ['read_balance', 'read_positions'],
      details: {
        dataLength: data.data?.length || 0,
      },
    }
  } catch (error) {
    logger.error('[Validator] OKX API key validation failed', {}, error as Error)
    return {
      isValid: false,
      error: 'Failed to validate API key',
    }
  }
}

/**
 * Validate Bitget API Key
 */
export async function validateBitgetApiKey(
  credentials: ExchangeCredentials
): Promise<ApiKeyValidationResult> {
  try {
    const { apiKey, apiSecret, passphrase } = credentials

    if (!passphrase) {
      return {
        isValid: false,
        error: 'Passphrase is required for Bitget',
      }
    }

    const timestamp = Date.now().toString()
    const method = 'GET'
    const requestPath = '/api/v2/spot/account/info'

    // Create signature
    const prehash = timestamp + method + requestPath
    const signature = createHmac('sha256', apiSecret)
      .update(prehash)
      .digest('base64')

    const response = await fetch(
      `https://api.bitget.com${requestPath}`,
      {
        headers: {
          'ACCESS-KEY': apiKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': passphrase,
          'Content-Type': 'application/json',
        },
      }
    )

    const data = await response.json()

    if (data.code !== '00000') {
      return {
        isValid: false,
        error: data.msg || 'Invalid API key',
      }
    }

    return {
      isValid: true,
      traderId: data.data?.userId || apiKey.substring(0, 16),
      permissions: ['read_account'],
      details: data.data,
    }
  } catch (error) {
    logger.error('[Validator] Bitget API key validation failed', {}, error as Error)
    return {
      isValid: false,
      error: 'Failed to validate API key',
    }
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
