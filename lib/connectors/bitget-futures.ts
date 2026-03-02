/**
 * Bitget Futures Connector
 * 
 * API: https://www.bitget.com/v1/trigger/trace/public/cycleData
 * Auth: None required
 * Rate Limit: 100-200ms delay recommended
 */

import { BaseExchangeConnector, TraderData, ListParams } from './base-connector'

const API_URL = 'https://www.bitget.com/v1/trigger/trace/public/cycleData'

export class BitgetFuturesConnector extends BaseExchangeConnector {
  constructor() {
    super('bitget_futures')
    this.headers = {
      ...this.headers,
      'Content-Type': 'application/json',
      'Origin': 'https://www.bitget.com',
      'Referer': 'https://www.bitget.com/copy-trading/futures',
    }
  }

  async getTraderDetail(traderId: string, params?: ListParams): Promise<TraderData | null> {
    const cycleTime = params?.period === '7d' ? 7 : params?.period === '90d' ? 90 : 30

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          languageType: 0,
          triggerUserId: traderId,
          cycleTime,
        })
      })

      if (!response.ok) return null
      const json = await response.json()
      if (json.code !== '00000') return null

      const data = json.data?.statisticsDTO
      if (!data) return null

      let winRate = this.parseNum(data.winningRate)
      let maxDrawdown = this.parseNum(data.maxRetracement)
      const roi = this.parseNum(data.roi)
      const pnl = this.parseNum(data.pnl)
      const tradesCount = parseInt(data.totalOrders) || null
      const followers = parseInt(data.followersCount) || null

      // Validate
      winRate = this.validateWinRate(winRate)
      maxDrawdown = this.validateMaxDrawdown(maxDrawdown)

      return {
        source_trader_id: traderId,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        roi,
        pnl,
        trades_count: tradesCount,
        followers,
      }
    } catch (error) {
      console.error(`Bitget API error for ${traderId}:`, error)
      return null
    }
  }

  async getTraderList(params?: ListParams): Promise<TraderData[]> {
    // Bitget doesn't have a simple list API - use detail API with known IDs
    throw new Error('Bitget Futures requires trader IDs - use getTraderDetail')
  }
}
