/**
 * 交易所API统一接口
 */

export * from './binance'
export * from './bybit'
export * from './bitget'
export * from './mexc'
export * from './coinex'
export * from './encryption'

export type Exchange =
  | 'binance'
  | 'bybit'
  | 'bitget'
  | 'mexc'
  | 'htx'
  | 'weex'
  | 'coinex'
  | 'okx'
  | 'kucoin'
  | 'gate'

export interface ExchangeConnection {
  id: string
  user_id: string
  exchange: Exchange
  exchange_user_id?: string
  is_active: boolean
  last_sync_at?: string | null
  last_sync_status?: 'success' | 'error' | 'pending' | null
  last_sync_error?: string | null
  created_at: string
  updated_at: string
}

export interface ExchangeCredentials {
  apiKey: string
  apiSecret: string
  passphrase?: string // Bitget 需要
}

export interface Trade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  fee: number
  pnl?: number
  executed_at: string
  holding_time_days?: number
}

export interface AccountInfo {
  totalEquity: number
  availableBalance: number
  unrealizedPnl?: number
}

import { validateExchangeReadOnlyAccess } from '@/lib/validators/api-key-validator'
import { API_KEY_CONNECTION_PLATFORMS } from './read-only-platforms'

/**
 * 统一验证交易所凭证
 */
export async function validateExchangeCredentials(
  exchange: Exchange,
  credentials: ExchangeCredentials
): Promise<boolean> {
  const result = await validateExchangeReadOnlyAccess(exchange, credentials)
  return result.isValid
}

/**
 * 获取交易所显示名称
 */
export function getExchangeName(exchange: Exchange): string {
  const names: Record<Exchange, string> = {
    binance: 'Binance',
    bybit: 'Bybit',
    bitget: 'Bitget',
    mexc: 'MEXC',
    htx: 'HTX',
    weex: 'Weex',
    coinex: 'CoinEx',
    okx: 'OKX',
    kucoin: 'KuCoin',
    gate: 'Gate.io',
  }
  return names[exchange] || exchange
}

/**
 * 支持的交易所列表
 */
// API-key connections are accepted only where the exchange exposes a permission
// endpoint and the existing sync adapter can consume the credential. Expanding
// this list requires both capabilities; format-only validation is unsafe.
export const SUPPORTED_EXCHANGES: Exchange[] = [...API_KEY_CONNECTION_PLATFORMS]
