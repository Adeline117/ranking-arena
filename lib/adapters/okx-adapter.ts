/**
 * OKX Exchange Adapter
 * Uses /api/v5/account endpoints for authorized trader data.
 *
 * Rate Limits: 10 req/2s per endpoint
 * Authentication: API Key + HMAC SHA256 (Base64) + Passphrase
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

interface OkxAdapterConfig extends AdapterConfig {
  passphrase?: string
}

export class OkxAdapter extends BaseAdapter implements ExchangeAdapter {
  name = 'okx'
  type = 'cex' as const

  private readonly BASE_URL = 'https://www.okx.com'
  private passphrase: string

  constructor(config: OkxAdapterConfig) {
    super({
      baseUrl: 'https://www.okx.com',
      timeout: 15000,
      retries: 2,
      ...config,
    })
    this.passphrase = config.passphrase || ''
    this.validateConfig(['apiKey', 'apiSecret'])
    if (!this.passphrase) {
      throw this.createError('Passphrase is required for OKX', 'MISSING_CONFIG')
    }
  }

  private sign(timestamp: string, method: string, path: string, body = ''): string {
    const prehash = timestamp + method + path + body
    return createHmac('sha256', this.config.apiSecret)
      .update(prehash)
      .digest('base64')
  }

  private async okxRequest<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET'
  ): Promise<T> {
    const timestamp = new Date().toISOString()
    const signature = this.sign(timestamp, method, path)

    return this.request<T>(`${this.BASE_URL}${path}`, {
      method,
      headers: {
        'OK-ACCESS-KEY': this.config.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
      },
    })
  }

  async fetchLeaderboard(_query: LeaderboardQuery): Promise<LeaderboardResponse> {
    return { traders: [], total: 0, hasMore: false }
  }

  async fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null> {
    try {
      logger.info('[OKX] Fetching trader detail via account API', { query })

      // Fetch account balance
      const balanceRes = await this.okxRequest<{
        code: string
        data: Array<{
          totalEq: string
          upl: string
        }>
      }>('/api/v5/account/balance')

      if (balanceRes.code !== '0' || !balanceRes.data?.[0]) {
        logger.error('[OKX] Balance API failed', { code: balanceRes.code })
        return null
      }

      const balance = balanceRes.data[0]
      const totalEq = parseFloat(balance.totalEq)
      const unrealizedPnl = parseFloat(balance.upl)

      // Fetch positions
      const posRes = await this.okxRequest<{
        code: string
        data: Array<{
          instId: string
          pos: string
          upl: string
          lever: string
        }>
      }>('/api/v5/account/positions')

      const positions = posRes.code === '0' ? posRes.data || [] : []
      const activePositions = positions.filter(p => parseFloat(p.pos) !== 0)

      return {
        platform: 'okx',
        traderId: query.traderId,
        nickname: query.traderId,
        roi: totalEq > 0 ? (unrealizedPnl / totalEq) * 100 : 0,
        pnl: unrealizedPnl,
        aum: totalEq,
        followers: 0,
        tradesCount: activePositions.length,
        winRate: 0,
        maxDrawdown: 0,
        periodDays: 30,
        dataSource: 'api',
        fetchedAt: new Date(),
      }
    } catch (error) {
      logger.error('[OKX] Failed to fetch trader detail', { error, query })
      return null
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.okxRequest<{ code: string }>('/api/v5/account/config')
      return res.code === '0'
    } catch (_err) {
      /* non-critical: health check */
      return false
    }
  }

  getRateLimitInfo(): RateLimitInfo {
    return { limit: 10, period: 2 }
  }
}
