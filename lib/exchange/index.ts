/**
 * 交易所API统一接口
 */

export * from './binance'
export * from './bybit'
export * from './bitget'
export * from './mexc'
export * from './coinex'
export * from './encryption'

export type Exchange = 'binance' | 'bybit' | 'bitget' | 'mexc' | 'htx' | 'weex' | 'coinex' | 'okx' | 'kucoin' | 'gate'

export interface ExchangeConnection {
  id: string
  user_id: string
  exchange: Exchange
  exchange_user_id?: string
  is_active: boolean
  last_sync_at?: string
  last_sync_status?: 'success' | 'error' | 'pending'
  last_sync_error?: string
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

// 导入各交易所验证函数
import { validateBinanceCredentials } from './binance'
import { validateBybitCredentials } from './bybit'
import { validateBitgetCredentials, type BitgetConfig } from './bitget'
import { validateMexcCredentials } from './mexc'
import { validateCoinexCredentials } from './coinex'

/**
 * 统一验证交易所凭证
 */
export async function validateExchangeCredentials(
  exchange: Exchange,
  credentials: ExchangeCredentials
): Promise<boolean> {
  switch (exchange) {
    case 'binance':
      return validateBinanceCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      })
    case 'bybit':
      return validateBybitCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      })
    case 'bitget':
      return validateBitgetCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        passphrase: credentials.passphrase,
      } as BitgetConfig)
    case 'mexc':
      return validateMexcCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      })
    case 'coinex':
      return validateCoinexCredentials({
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      })
    case 'okx':
    case 'kucoin':
    case 'gate':
      // 暂未实现
      throw new Error(`暂不支持交易所: ${exchange}`)
    default:
      throw new Error(`未知交易所: ${exchange}`)
  }
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
}/**
 * 支持的交易所列表
 */
export const SUPPORTED_EXCHANGES: Exchange[] = ['binance', 'bybit', 'bitget', 'mexc', 'htx', 'weex', 'coinex']