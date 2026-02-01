/**
 * Binance API 客户端
 * 用于获取用户的交易数据
 */

import crypto from 'crypto'

export interface BinanceConfig {
  apiKey: string
  apiSecret: string
}

export interface BinanceTrade {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: string
  price: string
  fee: string
  feeAsset: string
  time: number
}

export interface BinanceAccount {
  balances: Array<{
    asset: string
    free: string
    locked: string
  }>
}

/**
 * 生成Binance API签名
 */
function generateSignature(queryString: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(queryString)
    .digest('hex')
}

/**
 * 获取Binance账户信息
 */
export async function getBinanceAccount(config: BinanceConfig): Promise<BinanceAccount> {
  const timestamp = Date.now()
  const queryString = `timestamp=${timestamp}`
  const signature = generateSignature(queryString, config.apiSecret)

  const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': config.apiKey,
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Binance API error: ${response.status} - ${error}`)
  }

  return await response.json()
}

/**
 * 获取Binance交易历史
 */
export async function getBinanceTrades(
  config: BinanceConfig,
  symbol?: string,
  startTime?: number,
  endTime?: number,
  limit: number = 1000
): Promise<BinanceTrade[]> {
  const timestamp = Date.now()
  let queryString = `timestamp=${timestamp}&limit=${limit}`

  if (symbol) {
    queryString += `&symbol=${symbol}`
  }
  if (startTime) {
    queryString += `&startTime=${startTime}`
  }
  if (endTime) {
    queryString += `&endTime=${endTime}`
  }

  const signature = generateSignature(queryString, config.apiSecret)

  const url = `https://api.binance.com/api/v3/myTrades?${queryString}&signature=${signature}`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': config.apiKey,
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Binance API error: ${response.status} - ${error}`)
  }

  return await response.json()
}

/**
 * 验证Binance API Key和Secret是否有效
 */
export async function validateBinanceCredentials(config: BinanceConfig): Promise<boolean> {
  try {
    await getBinanceAccount(config)
    return true
  } catch (error: unknown) {
    const err = error as { message?: string }
    if (err.message?.includes('401') || err.message?.includes('Invalid API-key')) {
      return false
    }
    throw error
  }
}

/**
 * 计算交易统计数据
 */
export function calculateTradingStats(trades: BinanceTrade[]) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitableTradesPct: 0,
      tradesPerWeek: 0,
    }
  }

  // 按时间排序
  const sortedTrades = [...trades].sort((a, b) => a.time - b.time)
  const firstTrade = sortedTrades[0]
  const lastTrade = sortedTrades[sortedTrades.length - 1]

  // 计算时间范围（周）
  const timeRangeMs = lastTrade.time - firstTrade.time
  const timeRangeWeeks = timeRangeMs / (1000 * 60 * 60 * 24 * 7)
  const tradesPerWeek = timeRangeWeeks > 0 ? trades.length / timeRangeWeeks : 0

  // 计算盈亏（简化：使用fee作为盈亏指标，实际应该计算每笔交易的PnL）
  const profitableTrades = trades.filter(t => parseFloat(t.fee) >= 0)
  const profitableTradesPct = (profitableTrades.length / trades.length) * 100

  // 计算平均盈亏（简化）
  const totalFee = trades.reduce((sum, t) => sum + parseFloat(t.fee), 0)
  const _avgProfit = totalFee / trades.length

  // 分离盈利和亏损交易
  const profitTrades = trades.filter(t => parseFloat(t.fee) > 0)
  const lossTrades = trades.filter(t => parseFloat(t.fee) < 0)

  const avgProfitAmount = profitTrades.length > 0
    ? profitTrades.reduce((sum, t) => sum + parseFloat(t.fee), 0) / profitTrades.length
    : 0

  const avgLossAmount = lossTrades.length > 0
    ? lossTrades.reduce((sum, t) => sum + parseFloat(t.fee), 0) / lossTrades.length
    : 0

  return {
    totalTrades: trades.length,
    avgProfit: avgProfitAmount,
    avgLoss: avgLossAmount,
    profitableTradesPct,
    tradesPerWeek,
    activeSince: new Date(firstTrade.time),
  }
}


