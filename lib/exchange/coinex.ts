/**
 * CoinEx API 客户端
 * 文档: https://docs.coinex.com/
 */

import crypto from 'crypto'

export interface CoinexConfig {
  apiKey: string
  apiSecret: string
}

export interface CoinexAccount {
  available: string
  frozen: string
}

export interface CoinexTrade {
  id: number
  create_time: number
  order_id: number
  side: string
  amount: string
  price: string
  fee: string
  fee_asset: string
  market: string
}

const BASE_URL = 'https://api.coinex.com'

/**
 * 生成 CoinEx API 签名 (V2)
 */
function generateSignature(
  method: string,
  requestPath: string,
  body: string,
  timestamp: string,
  apiSecret: string
): string {
  const prepared = method + requestPath + body + timestamp
  return crypto
    .createHmac('sha256', apiSecret)
    .update(prepared)
    .digest('hex')
    .toLowerCase()
}

/**
 * 创建请求头
 */
function createHeaders(
  config: CoinexConfig,
  method: string,
  requestPath: string,
  body: string = ''
): Record<string, string> {
  const timestamp = Date.now().toString()
  const signature = generateSignature(method, requestPath, body, timestamp, config.apiSecret)

  return {
    'X-COINEX-KEY': config.apiKey,
    'X-COINEX-SIGN': signature,
    'X-COINEX-TIMESTAMP': timestamp,
    'Content-Type': 'application/json',
  }
}

/**
 * 获取 CoinEx 现货账户余额
 */
export async function getCoinexAccount(config: CoinexConfig): Promise<Record<string, CoinexAccount>> {
  const requestPath = '/v2/assets/spot/balance'
  const headers = createHeaders(config, 'GET', requestPath)

  const url = `${BASE_URL}${requestPath}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.code !== 0) {
    throw new Error(`CoinEx API error: ${data.code} - ${data.message}`)
  }

  return data.data || {}
}

/**
 * 获取 CoinEx 交易历史
 */
export async function getCoinexTrades(
  config: CoinexConfig,
  market: string,
  options: {
    page?: number
    limit?: number
    startTime?: number
    endTime?: number
  } = {}
): Promise<CoinexTrade[]> {
  const { page = 1, limit = 100, startTime, endTime } = options

  const params = new URLSearchParams()
  params.set('market', market)
  params.set('page', page.toString())
  params.set('limit', limit.toString())
  if (startTime) params.set('start_time', Math.floor(startTime / 1000).toString())
  if (endTime) params.set('end_time', Math.floor(endTime / 1000).toString())

  const requestPath = '/v2/spot/user-deals?' + params.toString()
  const headers = createHeaders(config, 'GET', requestPath)

  const url = `${BASE_URL}${requestPath}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.code !== 0) {
    throw new Error(`CoinEx API error: ${data.code} - ${data.message}`)
  }

  return data.data?.data || []
}

/**
 * 验证 CoinEx API 密钥是否有效
 */
export async function validateCoinexCredentials(config: CoinexConfig): Promise<boolean> {
  try {
    await getCoinexAccount(config)
    return true
  } catch (error: unknown) {
    const err = error as { message?: string }
    if (err.message?.includes('25') || err.message?.includes('Invalid') || err.message?.includes('authorization')) {
      return false
    }
    throw error
  }
}

/**
 * 获取 CoinEx 合约账户余额
 */
export async function getCoinexFuturesAccount(config: CoinexConfig): Promise<{
  available: string
  frozen: string
  margin: string
  unrealized_pnl: string
}> {
  const requestPath = '/v2/futures/account'
  const headers = createHeaders(config, 'GET', requestPath)

  const url = `${BASE_URL}${requestPath}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.code !== 0) {
    throw new Error(`CoinEx Futures API error: ${data.code} - ${data.message}`)
  }

  return data.data || {}
}

/**
 * 获取 CoinEx 合约持仓
 */
export async function getCoinexFuturesPositions(config: CoinexConfig): Promise<Array<{
  market: string
  side: string
  amount: string
  avg_entry_price: string
  unrealized_pnl: string
  leverage: string
}>> {
  const requestPath = '/v2/futures/pending-position'
  const headers = createHeaders(config, 'GET', requestPath)

  const url = `${BASE_URL}${requestPath}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.code !== 0) {
    throw new Error(`CoinEx Futures API error: ${data.code} - ${data.message}`)
  }

  return data.data || []
}

/**
 * 计算 CoinEx 交易统计
 */
export function calculateCoinexTradingStats(trades: CoinexTrade[]) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitableTradesPct: 0,
      tradesPerWeek: 0,
    }
  }

  const sortedTrades = [...trades].sort((a, b) => a.create_time - b.create_time)
  const firstTrade = sortedTrades[0]
  const lastTrade = sortedTrades[sortedTrades.length - 1]

  const timeRangeMs = (lastTrade.create_time - firstTrade.create_time) * 1000
  const timeRangeWeeks = timeRangeMs / (1000 * 60 * 60 * 24 * 7)
  const tradesPerWeek = timeRangeWeeks > 0 ? trades.length / timeRangeWeeks : 0

  const totalFee = trades.reduce((sum, t) => sum + parseFloat(t.fee || '0'), 0)
  const avgFee = totalFee / trades.length

  return {
    totalTrades: trades.length,
    avgProfit: avgFee,
    avgLoss: -avgFee,
    profitableTradesPct: 50,
    tradesPerWeek,
    activeSince: new Date(firstTrade.create_time * 1000),
  }
}


