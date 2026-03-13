/**
 * Binance Web3 Connector
 * 
 * API: https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query
 * Auth: None required
 * Multi-chain: BSC (56), ETH (1), Base (8453)
 * Multi-period: 7d, 30d, 90d
 * Rate Limit: 300-500ms delay recommended
 */

import { BaseExchangeConnector, TraderData, ListParams } from '../base-connector-enrichment'
import { dataLogger } from '../../utils/logger'

const API_URL = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query'

export class BinanceWeb3Connector extends BaseExchangeConnector {
  constructor() {
    super('binance_web3')
  }

  async getTraderDetail(traderId: string, params?: ListParams): Promise<TraderData | null> {
    const period = params?.period || '30d'
    const chainId = params?.chainId || 56 // Default BSC

    const traders = await this.getTraderList({ page: 1, pageSize: 100, period, chainId })
    const addr = traderId.toLowerCase()
    return traders.find(t => t.source_trader_id.toLowerCase() === addr) || null
  }

  async getTraderList(params?: ListParams): Promise<TraderData[]> {
    const pageNo = params?.page || 1
    const pageSize = params?.pageSize || 100
    const period = params?.period || '30d'
    const chainId = params?.chainId || 56

    const url = `${API_URL}?tag=ALL&pageNo=${pageNo}&pageSize=${pageSize}&sortBy=0&orderBy=0&period=${period}&chainId=${chainId}`

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
      if (json.code !== '000000') return []

      const items = json.data?.data || []
      return items.map((item: { address?: string; winRate?: string; realizedPnlPercent?: string; realizedPnl?: string; totalTxCnt?: string; addressLabel?: string; addressLogo?: string }) => {
        const address = (item.address || '').toLowerCase()
        let winRate = this.parseNum(item.winRate)
        let roi = this.parseNum(item.realizedPnlPercent)
        const pnl = this.parseNum(item.realizedPnl)
        const tradesCount = parseInt(item.totalTxCnt || '') || null

        // Binance returns decimals → convert to %
        if (winRate != null && winRate > 0 && winRate <= 1) {
          winRate = winRate * 100
        }
        if (roi != null) {
          roi = roi * 100
        }

        winRate = this.validateWinRate(winRate)

        return {
          source_trader_id: address,
          handle: item.addressLabel || address.slice(0, 10),
          avatar_url: item.addressLogo || null,
          win_rate: winRate,
          max_drawdown: null, // Not available from API
          roi,
          pnl,
          trades_count: tradesCount,
        }
      }).filter((t: TraderData) => t.source_trader_id)
    } catch (error) {
      dataLogger.error('Binance Web3 API error:', error)
      return []
    }
  }
}
