/**
 * Exchange UID Resolver
 * Extracts the account UID from exchange APIs using user-provided credentials.
 * Used to verify that an API key belongs to the trader being claimed.
 *
 * SECURITY: This is the core of claim verification.
 * The UID returned here MUST match the trader's source_trader_id in Arena DB.
 */

import { createHmac } from 'crypto'
import { logger } from '@/lib/logger'

export interface ExchangeCredentials {
  apiKey: string
  apiSecret: string
  passphrase?: string
}

export interface UidResolveResult {
  success: boolean
  uid?: string
  nickname?: string
  error?: string
}

/**
 * Resolve Binance account UID from API credentials.
 * Binance /api/v3/account does NOT return uid directly.
 * We use /fapi/v2/account (Futures) which returns uid, or /sapi/v1/account/info.
 */
async function resolveBinanceUid(credentials: ExchangeCredentials): Promise<UidResolveResult> {
  const { apiKey, apiSecret } = credentials

  // Strategy 1: Try Futures account (most Binance copy-trade traders are futures traders)
  try {
    const timestamp = Date.now()
    const queryString = `timestamp=${timestamp}`
    const signature = createHmac('sha256', apiSecret).update(queryString).digest('hex')

    const response = await fetch(
      `https://fapi.binance.com/fapi/v2/account?${queryString}&signature=${signature}`,
      {
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: AbortSignal.timeout(10000),
      }
    )

    if (response.ok) {
      const data = await response.json()
      // Futures account returns uid directly
      if (data.uid) {
        return { success: true, uid: String(data.uid) }
      }
    }
  } catch (_err) {
    // Intentionally swallowed: futures account UID lookup failed, fall through to next strategy
  }

  // Strategy 2: Try /sapi/v1/account/info (requires enable "Spot & Margin Trading" or similar)
  try {
    const timestamp = Date.now()
    const queryString = `timestamp=${timestamp}`
    const signature = createHmac('sha256', apiSecret).update(queryString).digest('hex')

    const response = await fetch(
      `https://api.binance.com/sapi/v1/account/info?${queryString}&signature=${signature}`,
      {
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: AbortSignal.timeout(10000),
      }
    )

    if (response.ok) {
      const data = await response.json()
      if (data.uid) {
        return { success: true, uid: String(data.uid) }
      }
    }
  } catch (_err) {
    // Intentionally swallowed: account info UID lookup failed, fall through to next strategy
  }

  // Strategy 3: Try spot account (basic validation - may not return uid)
  try {
    const timestamp = Date.now()
    const queryString = `timestamp=${timestamp}`
    const signature = createHmac('sha256', apiSecret).update(queryString).digest('hex')

    const response = await fetch(
      `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`,
      {
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: AbortSignal.timeout(10000),
      }
    )

    if (response.ok) {
      const data = await response.json()
      if (data.uid) {
        return { success: true, uid: String(data.uid) }
      }
      // If no uid, the API key is valid but we can't extract uid
      return {
        success: false,
        error: 'API key is valid but could not extract account UID. Please enable Futures trading permission on your API key.',
      }
    }

    const errorData = await response.json().catch(() => ({}))
    return {
      success: false,
      error: errorData.msg || `Binance API error: ${response.status}`,
    }
  } catch (error) {
    logger.error('[UidResolver] Binance resolve failed', {}, error as Error)
    return { success: false, error: 'Failed to connect to Binance API' }
  }
}

/**
 * Resolve Bybit account UID from API credentials.
 * GET /v5/user/query-api returns uid in result.
 */
async function resolveBybitUid(credentials: ExchangeCredentials): Promise<UidResolveResult> {
  const { apiKey, apiSecret } = credentials
  const timestamp = Date.now().toString()
  const recvWindow = '5000'

  const paramStr = `${timestamp}${apiKey}${recvWindow}`
  const signature = createHmac('sha256', apiSecret).update(paramStr).digest('hex')

  try {
    const response = await fetch('https://api.bybit.com/v5/user/query-api', {
      headers: {
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      signal: AbortSignal.timeout(10000),
    })

    const data = await response.json()

    if (data.retCode !== 0) {
      return { success: false, error: data.retMsg || 'Invalid API key' }
    }

    const uid = data.result?.uid || data.result?.userID
    if (!uid) {
      return { success: false, error: 'Could not extract UID from Bybit API response' }
    }

    return { success: true, uid: String(uid), nickname: data.result?.note }
  } catch (error) {
    logger.error('[UidResolver] Bybit resolve failed', {}, error as Error)
    return { success: false, error: 'Failed to connect to Bybit API' }
  }
}

/**
 * Resolve OKX account UID from API credentials.
 * GET /api/v5/account/config returns uid.
 */
async function resolveOkxUid(credentials: ExchangeCredentials): Promise<UidResolveResult> {
  const { apiKey, apiSecret, passphrase } = credentials

  if (!passphrase) {
    return { success: false, error: 'Passphrase is required for OKX' }
  }

  const timestamp = new Date().toISOString()
  const method = 'GET'
  const requestPath = '/api/v5/account/config'

  const prehash = timestamp + method + requestPath
  const signature = createHmac('sha256', apiSecret).update(prehash).digest('base64')

  try {
    const response = await fetch(`https://www.okx.com${requestPath}`, {
      headers: {
        'OK-ACCESS-KEY': apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': passphrase,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })

    const data = await response.json()

    if (data.code !== '0') {
      return { success: false, error: data.msg || 'Invalid API key' }
    }

    const uid = data.data?.[0]?.uid
    if (!uid) {
      return { success: false, error: 'Could not extract UID from OKX API response' }
    }

    return { success: true, uid: String(uid), nickname: data.data?.[0]?.label }
  } catch (error) {
    logger.error('[UidResolver] OKX resolve failed', {}, error as Error)
    return { success: false, error: 'Failed to connect to OKX API' }
  }
}

/**
 * Resolve Bitget account UID from API credentials.
 * GET /api/v2/spot/account/info returns userId.
 */
async function resolveBitgetUid(credentials: ExchangeCredentials): Promise<UidResolveResult> {
  const { apiKey, apiSecret, passphrase } = credentials

  if (!passphrase) {
    return { success: false, error: 'Passphrase is required for Bitget' }
  }

  const timestamp = Date.now().toString()
  const method = 'GET'
  const requestPath = '/api/v2/spot/account/info'

  const prehash = timestamp + method + requestPath
  const signature = createHmac('sha256', apiSecret).update(prehash).digest('base64')

  try {
    const response = await fetch(`https://api.bitget.com${requestPath}`, {
      headers: {
        'ACCESS-KEY': apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': passphrase,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })

    const data = await response.json()

    if (data.code !== '00000') {
      return { success: false, error: data.msg || 'Invalid API key' }
    }

    const userId = data.data?.userId
    if (!userId) {
      return { success: false, error: 'Could not extract userId from Bitget API response' }
    }

    return { success: true, uid: String(userId) }
  } catch (error) {
    logger.error('[UidResolver] Bitget resolve failed', {}, error as Error)
    return { success: false, error: 'Failed to connect to Bitget API' }
  }
}

/**
 * Resolve Gate.io account UID from API credentials.
 * GET /api/v4/spot/accounts uses different auth scheme (HMAC of entire request).
 */
async function resolveGateUid(credentials: ExchangeCredentials): Promise<UidResolveResult> {
  const { apiKey, apiSecret } = credentials
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const method = 'GET'
  const url = '/api/v4/account/detail'
  const queryString = ''
  const hashedBody = createHmac('sha512', '').update('').digest('hex')

  const signString = `${method}\n${url}\n${queryString}\n${hashedBody}\n${timestamp}`
  const signature = createHmac('sha512', apiSecret).update(signString).digest('hex')

  try {
    const response = await fetch(`https://api.gateio.ws${url}`, {
      headers: {
        KEY: apiKey,
        SIGN: signature,
        Timestamp: timestamp,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })

    const data = await response.json()

    if (data.user_id) {
      return { success: true, uid: String(data.user_id) }
    }

    // If /account/detail doesn't work, the key is invalid or insufficient permissions
    return { success: false, error: data.message || 'Could not extract user_id from Gate.io API' }
  } catch (error) {
    logger.error('[UidResolver] Gate.io resolve failed', {}, error as Error)
    return { success: false, error: 'Failed to connect to Gate.io API' }
  }
}

/**
 * Resolve HTX account UID from API credentials.
 * GET /v2/account/accounts returns data with id.
 */
async function resolveHtxUid(credentials: ExchangeCredentials): Promise<UidResolveResult> {
  const { apiKey, apiSecret } = credentials

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '')
  const method = 'GET'
  const host = 'api.huobi.pro'
  const path = '/v1/account/uid'

  const params = new URLSearchParams({
    AccessKeyId: apiKey,
    SignatureMethod: 'HmacSHA256',
    SignatureVersion: '2',
    Timestamp: timestamp,
  })

  // Sort params for signing
  params.sort()
  const signPayload = `${method}\n${host}\n${path}\n${params.toString()}`
  const signature = createHmac('sha256', apiSecret).update(signPayload).digest('base64')
  params.append('Signature', signature)

  try {
    const response = await fetch(`https://${host}${path}?${params.toString()}`, {
      signal: AbortSignal.timeout(10000),
    })

    const data = await response.json()

    if (data.status === 'ok' && data.data) {
      return { success: true, uid: String(data.data) }
    }

    return { success: false, error: data['err-msg'] || 'Could not extract UID from HTX API' }
  } catch (error) {
    logger.error('[UidResolver] HTX resolve failed', {}, error as Error)
    return { success: false, error: 'Failed to connect to HTX API' }
  }
}

/**
 * Main resolver function - routes to specific exchange resolver.
 */
export async function resolveExchangeUid(
  platform: string,
  credentials: ExchangeCredentials
): Promise<UidResolveResult> {
  const p = platform.toLowerCase()

  if (p.startsWith('binance')) {
    return resolveBinanceUid(credentials)
  }
  if (p.startsWith('bybit')) {
    return resolveBybitUid(credentials)
  }
  if (p === 'okx' || p.startsWith('okx_')) {
    return resolveOkxUid(credentials)
  }
  if (p.startsWith('bitget')) {
    return resolveBitgetUid(credentials)
  }
  if (p.startsWith('gate') || p === 'gateio') {
    return resolveGateUid(credentials)
  }
  if (p === 'htx' || p.startsWith('htx_') || p === 'huobi') {
    return resolveHtxUid(credentials)
  }

  return { success: false, error: `Unsupported platform for UID resolution: ${platform}` }
}

/**
 * List of CEX platforms that support API key verification.
 */
export const CEX_VERIFIABLE_PLATFORMS = [
  'binance', 'binance_futures', 'binance_spot',
  'bybit', 'bybit_spot',
  'okx', 'okx_futures',
  'bitget', 'bitget_futures',
  'gateio', 'gate',
  'htx', 'htx_futures',
] as const

/**
 * List of DEX platforms that support wallet signature verification.
 * These traders' source_trader_id IS their wallet address.
 */
export const DEX_WALLET_PLATFORMS = [
  'hyperliquid',
  'gmx',
  'gains',
  'aevo',
  'dydx',
  // kwenta: dead (Copin API stopped, 2026-03-11)
  // vertex: never had active connector
] as const

/**
 * Solana-based DEX platforms (use ed25519 signature verification).
 */
export const SOLANA_DEX_PLATFORMS = [
  'jupiter_perps',
  'drift',
] as const

/**
 * Check if a platform supports CEX API key verification.
 */
export function isCexVerifiable(platform: string): boolean {
  const p = platform.toLowerCase()
  return CEX_VERIFIABLE_PLATFORMS.some(cp => p === cp || p.startsWith(cp.split('_')[0]))
}

/**
 * Check if a platform uses wallet-based verification (EVM or Solana).
 */
export function isDexWalletPlatform(platform: string): boolean {
  const p = platform.toLowerCase()
  return [...DEX_WALLET_PLATFORMS, ...SOLANA_DEX_PLATFORMS].some(dp => p === dp)
}

/**
 * Check if a platform is Solana-based.
 */
export function isSolanaPlatform(platform: string): boolean {
  const p = platform.toLowerCase()
  return SOLANA_DEX_PLATFORMS.some(sp => p === sp)
}
