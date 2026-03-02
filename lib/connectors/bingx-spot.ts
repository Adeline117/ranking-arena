/**
 * BingX Spot Connector
 * 
 * API: https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search
 * Auth: CloudFlare protected - requires Playwright to capture signed headers
 * Rate Limit: 200-500ms delay recommended
 * 
 * ⚠️ This connector requires browser headers from Playwright
 *    Use the enrichment script for production data fetching
 */

import { BaseExchangeConnector, TraderData, ListParams } from './base-connector'

const API_URL = 'https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search'

export class BingXSpotConnector extends BaseExchangeConnector {
  private capturedHeaders: Record<string, string> | null = null

  constructor(capturedHeaders?: Record<string, string>) {
    super('bingx_spot')
    if (capturedHeaders) {
      this.capturedHeaders = capturedHeaders
    }
  }

  /**
   * Set browser-captured headers (must be called before API requests)
   */
  setHeaders(headers: Record<string, string>) {
    this.capturedHeaders = headers
  }

  async getTraderDetail(traderId: string, params?: ListParams): Promise<TraderData | null> {
    if (!this.capturedHeaders) {
      throw new Error('BingX requires browser headers - call setHeaders() first or use enrichment script')
    }

    // Use search API with nickname
    const traders = await this.getTraderList({ page: 0, pageSize: 20, sortType: params?.sortType || 0 })
    return traders.find(t => t.source_trader_id === traderId || t.handle === traderId) || null
  }

  async getTraderList(params?: ListParams): Promise<TraderData[]> {
    if (!this.capturedHeaders) {
      throw new Error('BingX requires browser headers - use enrichment script with Playwright')
    }

    const pageId = params?.page || 0
    const pageSize = params?.pageSize || 20
    const sortType = params?.sortType

    const body: any = { pageId, pageSize }
    if (sortType !== undefined) body.sortType = sortType

    try {
      const response = await fetch(`${API_URL}?pageId=${pageId}&pageSize=${pageSize}`, {
        method: 'POST',
        headers: this.capturedHeaders,
        body: JSON.stringify(body),
      })

      if (!response.ok) return []
      const json = await response.json()
      const items = json.data?.result || []

      return items.map((item: any) => {
        const traderInfo = item.trader || {}
        const rankStat = item.rankStat || {}
        
        const nickName = traderInfo.nickName || traderInfo.traderName || ''
        const uid = String(traderInfo.uid || '')
        
        let winRate = this.parseNum(rankStat.winRate || rankStat.winRate90d)
        let maxDrawdown = this.parseNum(rankStat.maxDrawdown || rankStat.maxDrawdown90d)
        const tradesCount = parseInt(rankStat.totalTransactions || rankStat.totalOrders || 0) || null

        // Calculate MDD from equity curve if available
        if (!maxDrawdown && rankStat.chart && rankStat.chart.length > 1) {
          maxDrawdown = this.calcMddFromChart(rankStat.chart)
        }

        winRate = this.validateWinRate(winRate)
        maxDrawdown = this.validateMaxDrawdown(maxDrawdown)

        return {
          source_trader_id: uid || nickName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          handle: nickName,
          win_rate: winRate,
          max_drawdown: maxDrawdown,
          trades_count: tradesCount,
          roi: null, // Not available from search API
          pnl: null,
        }
      }).filter((t: TraderData) => t.source_trader_id)
    } catch (error) {
      console.error('BingX API error:', error)
      return []
    }
  }

  /**
   * Calculate max drawdown from equity curve
   */
  private calcMddFromChart(chart: any[]): number | null {
    if (!chart || chart.length < 2) return null
    const equities = chart.map((p: any) => 1 + parseFloat(p.cumulativePnlRate || 0))
    let peak = equities[0]
    let maxDD = 0

    for (const eq of equities) {
      if (eq > peak) peak = eq
      if (peak > 0) {
        const dd = (peak - eq) / peak
        if (dd > maxDD) maxDD = dd
      }
    }

    return maxDD > 0.0001 ? Math.round(maxDD * 10000) / 100 : null
  }
}
