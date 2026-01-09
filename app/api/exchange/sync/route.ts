/**
 * 同步交易所数据API
 * POST /api/exchange/sync
 * 
 * 同步用户的交易数据
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/exchange/encryption'
import { getBinanceTrades, calculateTradingStats } from '@/lib/exchange/binance'
import type { BinanceConfig } from '@/lib/exchange/binance'

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

export async function POST(req: NextRequest) {
  try {
    // 1. 获取用户身份
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    // 从token中提取用户ID
    const token = authHeader.replace('Bearer ', '')
    const adminSupabase = getSupabaseAdmin()
    
    // 验证token并获取用户
    const { data: { user }, error: userError } = await adminSupabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: '未授权' }, { status: 401 })
    }

    // 2. 解析请求体
    const body = await req.json()
    const { exchange } = body

    if (!exchange) {
      return NextResponse.json(
        { error: '缺少必要参数：exchange' },
        { status: 400 }
      )
    }

    // 3. 获取用户连接
    const { data: connection, error: connError } = await adminSupabase
      .from('user_exchange_connections')
      .select('*')
      .eq('user_id', user.id)
      .eq('exchange', exchange)
      .eq('is_active', true)
      .maybeSingle()

    if (connError || !connection) {
      return NextResponse.json(
        { error: '未找到有效的交易所连接' },
        { status: 404 }
      )
    }

    // 4. 解密API凭证
    const apiKey = decrypt(connection.api_key_encrypted)
    const apiSecret = decrypt(connection.api_secret_encrypted)
    const config: BinanceConfig = { apiKey, apiSecret }

    // 5. 更新同步状态
    await adminSupabase
      .from('user_exchange_connections')
      .update({
        last_sync_status: 'pending',
        last_sync_at: new Date().toISOString(),
      })
      .eq('id', connection.id)

    try {
      // 6. 获取交易数据（最近12个月）
      const endTime = Date.now()
      const startTime = endTime - 365 * 24 * 60 * 60 * 1000 // 12个月前

      const trades = await getBinanceTrades(config, undefined, startTime, endTime, 1000)

      // 7. 计算统计数据
      const stats = calculateTradingStats(trades)

      // 8. 保存统计数据
      const periodStart = new Date(startTime)
      const periodEnd = new Date(endTime)

      const { error: dataError } = await adminSupabase
        .from('user_trading_data')
        .upsert({
          user_id: user.id,
          exchange,
          period_start: periodStart.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          total_trades: stats.totalTrades,
          avg_profit: stats.avgProfit,
          avg_loss: stats.avgLoss,
          profitable_trades_pct: stats.profitableTradesPct,
          trades_per_week: stats.tradesPerWeek,
          active_since: stats.activeSince?.toISOString().split('T')[0],
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'user_id,exchange,period_start,period_end',
        })

      if (dataError) {
        console.error('[exchange/sync] 保存数据失败:', dataError)
        throw dataError
      }

      // 9. 更新同步状态为成功
      await adminSupabase
        .from('user_exchange_connections')
        .update({
          last_sync_status: 'success',
          last_sync_at: new Date().toISOString(),
          last_sync_error: null,
        })
        .eq('id', connection.id)

      return NextResponse.json({
        success: true,
        message: '数据同步成功',
        data: {
          totalTrades: stats.totalTrades,
          tradesPerWeek: stats.tradesPerWeek,
          profitableTradesPct: stats.profitableTradesPct,
        },
      })
    } catch (syncError: any) {
      // 更新同步状态为失败
      await adminSupabase
        .from('user_exchange_connections')
        .update({
          last_sync_status: 'error',
          last_sync_error: syncError.message || '同步失败',
        })
        .eq('id', connection.id)

      throw syncError
    }
  } catch (error: any) {
    console.error('[exchange/sync] 错误:', error)
    return NextResponse.json(
      { error: error.message || '同步失败' },
      { status: 500 }
    )
  }
}

