/**
 * 用户交易数据获取函数
 * 用于获取用户绑定交易所后的详细数据
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export interface UserTradingData {
  total_trades: number | null
  avg_profit: number | null
  avg_loss: number | null
  profitable_trades_pct: number | null
  trades_per_week: number | null
  avg_holding_time_days: number | null
  profitable_holding_time_days: number | null
  active_since: string | null
  profitable_weeks: number | null
  profitable_weeks_pct: number | null
  return_ytd: number | null
  return_2y: number | null
  period_start: string
  period_end: string
  exchange: string
}

export interface UserExchangeConnection {
  id: string
  exchange: string
  is_active: boolean
  last_sync_at: string | null
  last_sync_status: 'success' | 'error' | 'pending' | null
  last_sync_error: string | null
}

/**
 * 获取用户的交易所连接
 */
export async function getUserExchangeConnections(userId: string): Promise<UserExchangeConnection[]> {
  const supabase = createClient(url, anon)
  
  const { data, error } = await supabase
    .from('user_exchange_connections')
    .select('id, exchange, is_active, last_sync_at, last_sync_status, last_sync_error')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (error) {
    return []
  }

  return data || []
}

/**
 * 获取用户交易数据（最近12个月）
 */
export async function getUserTradingData(
  userId: string,
  exchange?: string
): Promise<UserTradingData | null> {
  const supabase = createClient(url, anon)
  
  let query = supabase
    .from('user_trading_data')
    .select('*')
    .eq('user_id', userId)
    .order('period_end', { ascending: false })
    .limit(1)

  if (exchange) {
    query = query.eq('exchange', exchange)
  }

  const { data, error } = await query.maybeSingle()

  if (error) {
    return null
  }

  return data
}

/**
 * 检查用户是否已绑定交易所
 */
export async function hasExchangeConnection(userId: string): Promise<boolean> {
  const connections = await getUserExchangeConnections(userId)
  return connections.length > 0
}


