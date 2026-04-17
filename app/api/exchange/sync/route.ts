/**
 * 同步交易所数据 API
 * POST /api/exchange/sync
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, notFound } from '@/lib/api/response'
import { validateEnum } from '@/lib/api/validation'
import { decrypt } from '@/lib/exchange/encryption'
import { type Exchange, SUPPORTED_EXCHANGES } from '@/lib/exchange'
import { createLogger } from '@/lib/utils/logger'

// 导入各交易所客户端
import {
  getBinanceAccount,
  getBinanceTrades,
  calculateTradingStats as calculateBinanceTradingStats,
} from '@/lib/exchange/binance'
import {
  getBybitAccount,
  getBybitTrades,
  calculateBybitTradingStats,
} from '@/lib/exchange/bybit'
import {
  getBitgetAccount,
  getBitgetTrades,
  calculateBitgetTradingStats,
} from '@/lib/exchange/bitget'
import {
  getMexcAccount,
  getMexcTrades,
  calculateMexcTradingStats,
} from '@/lib/exchange/mexc'
import {
  getCoinexAccount,
  getCoinexTrades,
  calculateCoinexTradingStats,
} from '@/lib/exchange/coinex'

const logger = createLogger('exchange-sync')

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const exchange = validateEnum(body.exchange, SUPPORTED_EXCHANGES, {
      required: true,
      fieldName: 'exchange',
    })!

    // 获取用户连接信息
    const { data: connection, error: connError } = await supabase
      .from('user_exchange_connections')
      .select('id, api_key_encrypted, api_secret_encrypted, access_token_encrypted')
      .eq('user_id', user.id)
      .eq('exchange', exchange)
      .eq('is_active', true)
      .single()

    if (connError || !connection) {
      return notFound('No active exchange connection found')
    }

    // 解密凭证
    let apiKey: string
    let apiSecret: string
    let passphrase: string | undefined

    try {
      apiKey = decrypt(connection.api_key_encrypted)
      apiSecret = decrypt(connection.api_secret_encrypted)
      if (connection.access_token_encrypted && exchange === 'bitget') {
        passphrase = decrypt(connection.access_token_encrypted)
      }
    } catch (err: unknown) {
      logger.error('Decryption failed', { error: String(err) })
      throw new Error('Failed to decrypt credentials')
    }

    // 根据交易所类型获取数据
    // 定义通用统计类型
    interface TradingStats {
      totalTrades: number
      avgProfit: number
      avgLoss: number
      profitableTradesPct: number
      tradesPerWeek: number
      activeSince?: Date | null
    }
    let stats: TradingStats | null = null

    try {
      switch (exchange as Exchange) {
        case 'binance': {
          await getBinanceAccount({ apiKey, apiSecret })
          const binanceTrades = await getBinanceTrades({ apiKey, apiSecret })
          stats = calculateBinanceTradingStats(binanceTrades)
          break
        }

        case 'bybit': {
          await getBybitAccount({ apiKey, apiSecret })
          const bybitTrades = await getBybitTrades({ apiKey, apiSecret })
          stats = calculateBybitTradingStats(bybitTrades)
          break
        }

        case 'bitget': {
          await getBitgetAccount({ apiKey, apiSecret, passphrase })
          const bitgetTrades = await getBitgetTrades({ apiKey, apiSecret, passphrase })
          stats = calculateBitgetTradingStats(bitgetTrades)
          break
        }

        case 'mexc': {
          await getMexcAccount({ apiKey, apiSecret })
          const mexcTrades = await getMexcTrades({ apiKey, apiSecret }, 'BTCUSDT')
          stats = calculateMexcTradingStats(mexcTrades)
          break
        }

        case 'coinex': {
          await getCoinexAccount({ apiKey, apiSecret })
          const coinexTrades = await getCoinexTrades({ apiKey, apiSecret }, 'BTCUSDT')
          stats = calculateCoinexTradingStats(coinexTrades)
          break
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Sync failed'
      logger.error(`${exchange} sync failed`, { error: errorMessage })

      // 更新连接状态为失败
      await supabase
        .from('user_exchange_connections')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'error',
          last_sync_error: errorMessage,
        })
        .eq('id', connection.id)

      throw err
    }

    // 保存交易统计数据
    if (stats && stats.totalTrades > 0) {
      const periodStart = new Date()
      periodStart.setDate(periodStart.getDate() - 90)
      const periodEnd = new Date()

      await supabase
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
    }

    // 更新连接状态为成功
    await supabase
      .from('user_exchange_connections')
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'success',
        last_sync_error: null,
      })
      .eq('id', connection.id)

    return NextResponse.json({
      success: true,
      data: {
        message: 'Sync successful',
        tradesCount: stats?.totalTrades ?? 0,
        stats,
      },
    })
  },
  {
    name: 'exchange-sync',
    rateLimit: 'sensitive',
  }
)
