/**
 * 交易所API统一接口
 */

export * from './binance'
export * from './encryption'

export type Exchange = 'binance' | 'bybit' | 'bitget' | 'mexc' | 'coinex'

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


