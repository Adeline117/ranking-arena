/**
 * HTX Futures Connector
 * 
 * API: https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 * Auth: None required
 * Rate Limit: 200-300ms delay recommended
 */

import { BaseExchangeConnector, TraderData, ListParams } from './base-connector-enrichment'
import { dataLogger } from '../utils/logger'

const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'

export class HTXFuturesConnector extends BaseExchangeConnector {
  constructor() {
    super('htx_futures')
    this.headers = {
      ...this.headers,
      'Referer': 'https://futures.htx.com',
    }
  }

  async getTraderDetail(traderId: string, _params?: ListParams): Promise<TraderData | null> {
    // HTX ranking API returns all traders, so we fetch and filter
    const traders = await this.getTraderList({ page: 1, pageSize: 50 })
    return traders.find(t => t.source_trader_id === traderId) || null
  }

  async getTraderList(params?: ListParams): Promise<TraderData[]> {
    const pageNo = params?.page || 1
    const pageSize = params?.pageSize || 50
    const rankType = params?.sortType || 1

    const url = `${API_URL}?rankType=${rankType}&pageNo=${pageNo}&pageSize=${pageSize}`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)
      let response: Response
      try {
        response = await fetch(url, { headers: this.headers, signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) return []

      const json = await response.json()
      if (json.code !== 200) return []

      const items = json.data?.itemList || []
      return items.map((item: { userSign?: string; winRate?: string; mdd?: string; roi?: string; pnl?: string; imgUrl?: string }) => {
        const userSign = (item.userSign || '').replace(/=+$/, '') // Strip trailing =
        let winRate = this.parseNum(item.winRate)
        let maxDrawdown = this.parseNum(item.mdd)
        const roi = this.parseNum(item.roi)
        const pnl = this.parseNum(item.pnl)

        // HTX returns decimal (0.685) → convert to %
        if (winRate != null && winRate > 0 && winRate <= 1) {
          winRate = winRate * 100
        }
        winRate = this.validateWinRate(winRate)
        maxDrawdown = this.validateMaxDrawdown(maxDrawdown)

        return {
          source_trader_id: userSign,
          avatar_url: item.imgUrl || null,
          win_rate: winRate,
          max_drawdown: maxDrawdown,
          roi,
          pnl,
          trades_count: null, // Not available from ranking API
        }
      }).filter((t: TraderData) => t.source_trader_id) // Filter out invalid entries
    } catch (error) {
      dataLogger.error('HTX API error:', error)
      return []
    }
  }
}
