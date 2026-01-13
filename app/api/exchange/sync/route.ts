import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  calculateTradeLevelStats,
  calculateDetailedMetrics,
  calculateHoldingTimeAnalysis,
  calculateProfitabilityAnalysis,
  calculateRiskMetrics,
  type Trade,
} from '@/lib/services/trading-metrics'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

import crypto from 'crypto'

// 简单的解密函数
function decrypt(encrypted: string, key: string): string {
  const [ivHex, encryptedHex] = encrypted.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv)
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

// 从交易所获取交易历史（示例实现，需要根据实际 API 调整）
async function fetchTradesFromExchange(
  exchange: string,
  accessToken: string,
  userId: string
): Promise<Trade[]> {
  // 这里应该调用实际的交易所 API
  // 示例：从 user_trading_history 表获取（如果已同步）
  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  
  const { data: trades } = await supabase
    .from('user_trading_history')
    .select('*')
    .eq('user_id', userId)
    .eq('exchange', exchange)
    .order('executed_at', { ascending: false })
    .limit(1000)

  return (trades || []).map(t => ({
    id: t.trade_id,
    symbol: t.symbol,
    side: t.side as 'buy' | 'sell',
    quantity: Number(t.quantity),
    price: Number(t.price),
    fee: Number(t.fee || 0),
    pnl: t.pnl ? Number(t.pnl) : undefined,
    executed_at: t.executed_at,
    holding_time_days: t.holding_time_days ? Number(t.holding_time_days) : undefined,
  }))
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userId, exchange } = body

    if (!userId || !exchange) {
      return NextResponse.json({ error: 'Missing userId or exchange' }, { status: 400 })
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 获取用户连接信息
    const { data: connection, error: connError } = await supabase
      .from('user_exchange_connections')
      .select('*')
      .eq('user_id', userId)
      .eq('exchange', exchange)
      .eq('is_active', true)
      .single()

    if (connError || !connection) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
    }

    // 解密 access_token
    const encryptionKey = process.env.ENCRYPTION_KEY || ''
    if (!encryptionKey) {
      return NextResponse.json({ error: 'Encryption key not configured' }, { status: 500 })
    }

    let accessToken: string
    try {
      accessToken = decrypt(connection.access_token_encrypted, encryptionKey)
    } catch (err) {
      return NextResponse.json({ error: 'Failed to decrypt token' }, { status: 500 })
    }

    // 获取交易历史
    const trades = await fetchTradesFromExchange(exchange, accessToken, userId)

    if (trades.length === 0) {
      return NextResponse.json({ message: 'No trades found', metrics: null })
    }

    // 计算所有指标
    const tradeLevelStats = calculateTradeLevelStats(trades)
    const detailedMetrics = calculateDetailedMetrics(trades)
    const holdingTimeAnalysis = calculateHoldingTimeAnalysis(trades)
    const profitabilityAnalysis = calculateProfitabilityAnalysis(trades)
    const riskMetrics = calculateRiskMetrics(trades)

    // 保存到数据库
    const periodStart = new Date()
    periodStart.setDate(periodStart.getDate() - 90) // 最近 90 天
    const periodEnd = new Date()

    const { error: saveError } = await supabase
      .from('user_trading_data')
      .upsert({
        user_id: userId,
        exchange,
        period_start: periodStart.toISOString().split('T')[0],
        period_end: periodEnd.toISOString().split('T')[0],
        total_trades: tradeLevelStats.total_trades,
        avg_profit: tradeLevelStats.avg_profit,
        avg_loss: tradeLevelStats.avg_loss,
        profitable_trades_pct: tradeLevelStats.profitable_trades_pct,
        avg_holding_time_days: holdingTimeAnalysis.avg_holding_time,
        profitable_holding_time_days: holdingTimeAnalysis.median_holding_time,
        profitable_weeks: Math.floor(holdingTimeAnalysis.short_term_trades_pct / 10), // 简化计算
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,exchange,period_start,period_end',
      })

    if (saveError) {
      console.error('Error saving trading data:', saveError)
    }

    // 更新连接状态
    await supabase
      .from('user_exchange_connections')
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'success',
      })
      .eq('id', connection.id)

    return NextResponse.json({
      success: true,
      metrics: {
        tradeLevelStats,
        detailedMetrics,
        holdingTimeAnalysis,
        profitabilityAnalysis,
        riskMetrics,
      },
      tradesCount: trades.length,
    })
  } catch (error: any) {
    console.error('Error syncing exchange data:', error)
    return NextResponse.json({ error: error.message || 'Sync failed' }, { status: 500 })
  }
}
