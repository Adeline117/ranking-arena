/**
 * Bybit Exchange Adapter
 * Official API: https://bybit-exchange.github.io/docs/v5/copy-trading/trader-list
 *
 * Rate Limits: 120 requests/second
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

interface BybitTraderResponse {
  retCode: number
  retMsg: string
  result: {
    list: Array<{
      userId: string
      nickname: string
      profileImage?: string
      pnl: string
      roi: string
      aum: string
      followerCount: number
      winRate: string
      maxDrawDown: string
      totalTrades: number
      description?: string
      verified?: boolean
      createdTime: number
      lastTradeTime?: number
    }>
    nextPageCursor?: string
  }
  time: number
}

interface BybitDetailResponse {
  retCode: number
  retMsg: string
  result: {
    userId: string
    nickname: string
    profileImage?: string
    pnl: string
    roi: string
    aum: string
    followerCount: number
    winRate: string
    maxDrawDown: string
    totalTrades: number
    description?: string
    statistics: {
      dailyPnl?: string
      weeklyPnl?: string
      monthlyPnl?: string
      sharpeRatio?: string
    }
    verified?: boolean
    createdTime: number
    lastTradeTime?: number
  }
  time: number
}

export class BybitAdapter extends BaseAdapter implements ExchangeAdapter {
  name = 'bybit'
  type = 'cex' as const

  private readonly BASE_URL = 'https://api.bybit.com'

  constructor(config?: AdapterConfig) {
    super({
      baseUrl: 'https://api.bybit.com',
      timeout: 30000,
      retries: 3,
      ...config,
    })

    // Validate required config
    this.validateConfig(['apiKey', 'apiSecret'])
  }

  /**
   * Generate HMAC SHA256 signature for Bybit API
   */
  private generateSignature(params: Record<string, string>): string {
    const timestamp = Date.now().toString()
    const paramStr = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&')

    const signStr = timestamp + this.config.apiKey + paramStr

    const signature = createHmac('sha256', this.config.apiSecret)
      .update(signStr)
      .digest('hex')

    return signature
  }

  /**
   * Make authenticated request to Bybit API
   */
  private async bybitRequest<T>(
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const timestamp = Date.now().toString()
    const signature = this.generateSignature(params)

    const queryString = new URLSearchParams(params).toString()
    const url = `${this.BASE_URL}${endpoint}${queryString ? `?${queryString}` : ''}`

    const response = await this.request<T>(url, {
      method: 'GET',
      headers: {
        'X-BAPI-API-KEY': this.config.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-SIGN': signature,
        'Content-Type': 'application/json',
      },
    })

    return response
  }

  /**
   * Fetch leaderboard traders
   */
  async fetchLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResponse> {
    try {
      logger.info(`[Bybit] Fetching leaderboard`, { query })

      const params: Record<string, string> = {
        limit: (query.limit || 100).toString(),
      }

      // Map sortBy to Bybit's sort field
      if (query.sortBy) {
        const sortMap: Record<string, string> = {
          roi: 'roi',
          pnl: 'pnl',
          followers: 'followerCount',
          aum: 'aum',
        }
        params.sortType = sortMap[query.sortBy] || 'roi'
      }

      // Add period filter if specified
      if (query.periodDays) {
        params.period = this.mapPeriodToDays(query.periodDays)
      }

      const response = await this.bybitRequest<BybitTraderResponse>(
        '/v5/copytrading/trader/list',
        params
      )

      if (response.retCode !== 0) {
        throw this.createError(
          `Bybit API error: ${response.retMsg}`,
          'API_ERROR'
        )
      }

      const traders = response.result.list
        .map((trader) => this.normalizeTraderData(trader))
        .filter((trader) => {
          // Apply client-side filters
          if (query.minFollowers && trader.followers < query.minFollowers) {
            return false
          }
          return true
        })

      return {
        traders,
        total: traders.length,
        hasMore: !!response.result.nextPageCursor,
        nextCursor: response.result.nextPageCursor,
      }
    } catch (error) {
      logger.error('[Bybit] Failed to fetch leaderboard', { error, query })
      throw error instanceof Error
        ? error
        : this.createError('Unknown error', 'UNKNOWN_ERROR')
    }
  }

  /**
   * Fetch trader detail
   */
  async fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null> {
    try {
      logger.info(`[Bybit] Fetching trader detail`, { query })

      const params = {
        userId: query.traderId,
      }

      const response = await this.bybitRequest<BybitDetailResponse>(
        '/v5/copytrading/trader/detail',
        params
      )

      if (response.retCode !== 0) {
        if (response.retCode === 10001) {
          // Trader not found
          return null
        }
        throw this.createError(
          `Bybit API error: ${response.retMsg}`,
          'API_ERROR'
        )
      }

      return this.normalizeDetailData(response.result)
    } catch (error) {
      logger.error('[Bybit] Failed to fetch trader detail', { error, query })
      return null
    }
  }

  /**
   * Normalize Bybit trader data to standard format
   */
  private normalizeTraderData(
    trader: BybitTraderResponse['result']['list'][0]
  ): TraderData {
    return {
      platform: 'bybit',
      traderId: trader.userId,
      nickname: trader.nickname,
      avatar: trader.profileImage,
      roi: parseFloat(trader.roi),
      pnl: parseFloat(trader.pnl),
      aum: parseFloat(trader.aum),
      followers: trader.followerCount,
      tradesCount: trader.totalTrades,
      winRate: parseFloat(trader.winRate),
      maxDrawdown: parseFloat(trader.maxDrawDown),
      verified: trader.verified,
      description: trader.description,
      lastTradeAt: trader.lastTradeTime
        ? new Date(trader.lastTradeTime)
        : undefined,
      createdAt: new Date(trader.createdTime),
      periodDays: 30, // Default, Bybit uses 30 days
      dataSource: 'api',
      fetchedAt: new Date(),
    }
  }

  /**
   * Normalize Bybit trader detail data
   */
  private normalizeDetailData(trader: BybitDetailResponse['result']): TraderData {
    return {
      platform: 'bybit',
      traderId: trader.userId,
      nickname: trader.nickname,
      avatar: trader.profileImage,
      roi: parseFloat(trader.roi),
      pnl: parseFloat(trader.pnl),
      aum: parseFloat(trader.aum),
      followers: trader.followerCount,
      tradesCount: trader.totalTrades,
      winRate: parseFloat(trader.winRate),
      maxDrawdown: parseFloat(trader.maxDrawDown),
      sharpeRatio: trader.statistics.sharpeRatio
        ? parseFloat(trader.statistics.sharpeRatio)
        : undefined,
      dailyPnl: trader.statistics.dailyPnl
        ? parseFloat(trader.statistics.dailyPnl)
        : undefined,
      weeklyPnl: trader.statistics.weeklyPnl
        ? parseFloat(trader.statistics.weeklyPnl)
        : undefined,
      monthlyPnl: trader.statistics.monthlyPnl
        ? parseFloat(trader.statistics.monthlyPnl)
        : undefined,
      verified: trader.verified,
      description: trader.description,
      lastTradeAt: trader.lastTradeTime
        ? new Date(trader.lastTradeTime)
        : undefined,
      createdAt: new Date(trader.createdTime),
      periodDays: 30,
      dataSource: 'api',
      fetchedAt: new Date(),
    }
  }

  /**
   * Map period days to Bybit period string
   */
  private mapPeriodToDays(period: 7 | 30 | 90 | 365 | 'all'): string {
    if (period === 'all') return '365'
    return period.toString()
  }

  /**
   * Health check - verify API credentials and connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.bybitRequest<{ retCode: number }>(
        '/v5/user/query-api',
        {}
      )
      return response.retCode === 0
    } catch (error) {
      logger.error('[Bybit] Health check failed', { error })
      return false
    }
  }

  /**
   * Get rate limit info
   */
  getRateLimitInfo(): RateLimitInfo {
    return {
      limit: 120, // 120 requests per second
      period: 1,
    }
  }
}
