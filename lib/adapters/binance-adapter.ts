/**
 * Binance Exchange Adapter
 * Uses Futures API for copy-trade trader data.
 *
 * Rate Limits: 2400 req/min (weight-based)
 * Authentication: API Key + HMAC SHA256 signature
 */

import { createHmac } from 'crypto'
import { BaseAdapter } from './base-adapter'
import { logger } from '@/lib/logger'
import type {
  ExchangeAdapter,
  TraderData,
  LeaderboardQuery,
  LeaderboardResponse,
  TraderDetailQuery,
  RateLimitInfo,
  AdapterConfig,
} from './types'

interface BinanceFuturesAccountResponse {
  totalWalletBalance: string
  totalUnrealizedProfit: string
  totalMarginBalance: string
  totalPositionInitialMargin: string
  availableBalance: string
  maxWithdrawAmount: string
  positions: Array<{
    symbol: string
    unrealizedProfit: string
    entryPrice: string
    positionAmt: string
    leverage: string
  }>
}

export class BinanceAdapter extends BaseAdapter implements ExchangeAdapter {
  name = 'binance'
  type = 'cex' as const

  private readonly BASE_URL = 'https://fapi.binance.com'

  constructor(config?: AdapterConfig) {
    super({
      baseUrl: 'https://fapi.binance.com',
      timeout: 15000,
      retries: 2,
      ...config,
    })
    this.validateConfig(['apiKey', 'apiSecret'])
  }

  private sign(queryString: string): string {
    return createHmac('sha256', this.config.apiSecret)
      .update(queryString)
      .digest('hex')
  }

  private async binanceRequest<T>(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    params.timestamp = Date.now().toString()
    const queryString = new URLSearchParams(params).toString()
    const signature = this.sign(queryString)
    const url = `${this.BASE_URL}${endpoint}?${queryString}&signature=${signature}`

    return this.request<T>(url, {
      headers: { 'X-MBX-APIKEY': this.config.apiKey },
    })
  }

  async fetchLeaderboard(_query: LeaderboardQuery): Promise<LeaderboardResponse> {
    // Binance doesn't expose a public leaderboard API via authenticated keys
    return { traders: [], total: 0, hasMore: false }
  }

  async fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null> {
    try {
      logger.info('[Binance] Fetching trader detail via Futures account', { query })

      const account = await this.binanceRequest<BinanceFuturesAccountResponse>(
        '/fapi/v2/account'
      )

      const walletBalance = parseFloat(account.totalWalletBalance)
      const unrealizedPnl = parseFloat(account.totalUnrealizedProfit)
      const totalMargin = parseFloat(account.totalMarginBalance)

      // Count active positions
      const activePositions = account.positions.filter(
        (p) => parseFloat(p.positionAmt) !== 0
      )

      return {
        platform: 'binance_futures',
        traderId: query.traderId,
        nickname: query.traderId,
        roi: totalMargin > 0 ? (unrealizedPnl / totalMargin) * 100 : 0,
        pnl: unrealizedPnl,
        aum: walletBalance,
        followers: 0,
        tradesCount: activePositions.length,
        winRate: 0,
        maxDrawdown: 0,
        periodDays: 30,
        dataSource: 'api',
        fetchedAt: new Date(),
      }
    } catch (error) {
      logger.error('[Binance] Failed to fetch trader detail', { error, query })
      return null
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.binanceRequest<{ serverTime: number }>(
        '/fapi/v1/time'
      )
      return !!result.serverTime
    } catch {
      return false
    }
  }

  getRateLimitInfo(): RateLimitInfo {
    return { limit: 2400, period: 60 }
  }
}
