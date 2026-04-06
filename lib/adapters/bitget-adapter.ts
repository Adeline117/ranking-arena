/**
 * Bitget Exchange Adapter
 * Uses /api/v2/mix endpoints for authorized trader data.
 *
 * Rate Limits: 10 req/s per endpoint
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

interface BitgetAdapterConfig extends AdapterConfig {
  passphrase?: string
}

export class BitgetAdapter extends BaseAdapter implements ExchangeAdapter {
  name = 'bitget'
  type = 'cex' as const

  private readonly BASE_URL = 'https://api.bitget.com'
  private passphrase: string

  constructor(config: BitgetAdapterConfig) {
    super({
      baseUrl: 'https://api.bitget.com',
      timeout: 15000,
      retries: 2,
      ...config,
    })
    this.passphrase = config.passphrase || ''
    this.validateConfig(['apiKey', 'apiSecret'])
    if (!this.passphrase) {
      throw this.createError('Passphrase is required for Bitget', 'MISSING_CONFIG')
    }
  }

  private sign(timestamp: string, method: string, path: string, body = ''): string {
    const prehash = timestamp + method + path + body
    return createHmac('sha256', this.config.apiSecret)
      .update(prehash)
      .digest('base64')
  }

  private async bitgetRequest<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET'
  ): Promise<T> {
    const timestamp = Date.now().toString()
    const signature = this.sign(timestamp, method, path)

    return this.request<T>(`${this.BASE_URL}${path}`, {
      method,
      headers: {
        'ACCESS-KEY': this.config.apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
      },
    })
  }

  async fetchLeaderboard(_query: LeaderboardQuery): Promise<LeaderboardResponse> {
    return { traders: [], total: 0, hasMore: false }
  }

  async fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null> {
    try {
      logger.info('[Bitget] Fetching trader detail via account API', { query })

      // Fetch mix (futures) account
      const accountRes = await this.bitgetRequest<{
        code: string
        data: Array<{
          marginCoin: string
          available: string
          equity: string
          unrealizedPL: string
        }>
      }>('/api/v2/mix/account/accounts?productType=USDT-FUTURES')

      if (accountRes.code !== '00000') {
        logger.error('[Bitget] Account API failed', { code: accountRes.code })
        return null
      }

      const accounts = accountRes.data || []
      const usdtAccount = accounts.find(a => a.marginCoin === 'USDT') || accounts[0]

      const equity = usdtAccount ? parseFloat(usdtAccount.equity) : 0
      const unrealizedPnl = usdtAccount ? parseFloat(usdtAccount.unrealizedPL) : 0

      // Fetch positions
      const posRes = await this.bitgetRequest<{
        code: string
        data: Array<{
          symbol: string
          total: string
          unrealizedPL: string
          leverage: string
        }>
      }>('/api/v2/mix/position/all-position?productType=USDT-FUTURES')

      const positions = posRes.code === '00000' ? posRes.data || [] : []
      const activePositions = positions.filter(p => parseFloat(p.total) !== 0)

      return {
        platform: 'bitget',
        traderId: query.traderId,
        nickname: query.traderId,
        roi: equity > 0 ? (unrealizedPnl / equity) * 100 : 0,
        pnl: unrealizedPnl,
        aum: equity,
        followers: 0,
        tradesCount: activePositions.length,
        winRate: 0,
        maxDrawdown: 0,
        periodDays: 30,
        dataSource: 'api',
        fetchedAt: new Date(),
      }
    } catch (error) {
      logger.error('[Bitget] Failed to fetch trader detail', { error, query })
      return null
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.bitgetRequest<{ code: string }>(
        '/api/v2/spot/account/info'
      )
      return res.code === '00000'
    } catch (_err) {
      /* non-critical: health check */
      return false
    }
  }

  getRateLimitInfo(): RateLimitInfo {
    return { limit: 10, period: 1 }
  }
}
