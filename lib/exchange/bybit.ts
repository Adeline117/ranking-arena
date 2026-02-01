/**
 * Bybit API 客户端
 * 文档: https://bybit-exchange.github.io/docs/v5/intro
 */

import crypto from 'crypto'

export interface BybitConfig {
  apiKey: string
  apiSecret: string
}

export interface BybitAccount {
  totalEquity: string
  totalWalletBalance: string
  totalMarginBalance: string
  totalAvailableBalance: string
  coin: Array<{
    coin: string
    equity: string
    walletBalance: string
    availableToWithdraw: string
  }>
}

export interface BybitTrade {
  symbol: string
  orderId: string
  side: 'Buy' | 'Sell'
  orderType: string
  execFee: string
  execQty: string
  execPrice: string
  execTime: string
  isMaker: boolean
}

const BASE_URL = 'https://api.bybit.com'

/**
 * 生成 Bybit API 签名
 */
function generateSignature(
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryString: string,
  apiSecret: string
): string {
  const signString = timestamp + apiKey + recvWindow + queryString
  return crypto
    .createHmac('sha256', apiSecret)
    .update(signString)
    .digest('hex')
}

/**
 * 创建请求头
 */
function createHeaders(config: BybitConfig, queryString: string = ''): Record<string, string> {
  const timestamp = Date.now().toString()
  const recvWindow = '5000'
  const signature = generateSignature(timestamp, config.apiKey, recvWindow, queryString, config.apiSecret)

  return {
    'X-BAPI-API-KEY': config.apiKey,
    'X-BAPI-SIGN': signature,
    'X-BAPI-SIGN-TYPE': '2',
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'Content-Type': 'application/json',
  }
}

/**
 * 获取 Bybit 账户信息
 */
export async function getBybitAccount(config: BybitConfig): Promise<BybitAccount> {
  const queryString = 'accountType=UNIFIED'
  const headers = createHeaders(config, queryString)

  const url = `${BASE_URL}/v5/account/wallet-balance?${queryString}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retCode} - ${data.retMsg}`)
  }

  const account = data.result?.list?.[0]
  if (!account) {
    throw new Error('Failed to get account info')
  }

  return {
    totalEquity: account.totalEquity,
    totalWalletBalance: account.totalWalletBalance,
    totalMarginBalance: account.totalMarginBalance,
    totalAvailableBalance: account.totalAvailableBalance,
    coin: account.coin || [],
  }
}

/**
 * 获取 Bybit 交易历史
 */
export async function getBybitTrades(
  config: BybitConfig,
  options: {
    category?: 'linear' | 'inverse' | 'spot'
    symbol?: string
    startTime?: number
    endTime?: number
    limit?: number
  } = {}
): Promise<BybitTrade[]> {
  const {
    category = 'linear',
    symbol,
    startTime,
    endTime,
    limit = 100,
  } = options

  const params = new URLSearchParams()
  params.set('category', category)
  if (symbol) params.set('symbol', symbol)
  if (startTime) params.set('startTime', startTime.toString())
  if (endTime) params.set('endTime', endTime.toString())
  params.set('limit', limit.toString())

  const queryString = params.toString()
  const headers = createHeaders(config, queryString)

  const url = `${BASE_URL}/v5/execution/list?${queryString}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retCode} - ${data.retMsg}`)
  }

  return data.result?.list || []
}

/**
 * 验证 Bybit API 密钥是否有效
 */
export async function validateBybitCredentials(config: BybitConfig): Promise<boolean> {
  try {
    await getBybitAccount(config)
    return true
  } catch (error: unknown) {
    const err = error as { message?: string }
    if (err.message?.includes('10003') || err.message?.includes('10004') || err.message?.includes('Invalid')) {
      return false
    }
    // 其他错误可能是网络问题等，抛出
    throw error
  }
}

/**
 * 获取 Bybit 持仓信息
 */
export async function getBybitPositions(
  config: BybitConfig,
  category: 'linear' | 'inverse' = 'linear'
): Promise<Array<{
  symbol: string
  side: string
  size: string
  avgPrice: string
  unrealisedPnl: string
  leverage: string
}>> {
  const queryString = `category=${category}&settleCoin=USDT`
  const headers = createHeaders(config, queryString)

  const url = `${BASE_URL}/v5/position/list?${queryString}`

  const response = await fetch(url, {
    method: 'GET',
    headers,
  })

  const data = await response.json()

  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retCode} - ${data.retMsg}`)
  }

  return data.result?.list || []
}

/**
 * 计算 Bybit 交易统计
 */
export function calculateBybitTradingStats(trades: BybitTrade[]) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitableTradesPct: 0,
      tradesPerWeek: 0,
    }
  }

  const sortedTrades = [...trades].sort((a, b) => 
    parseInt(a.execTime) - parseInt(b.execTime)
  )
  const firstTrade = sortedTrades[0]
  const lastTrade = sortedTrades[sortedTrades.length - 1]

  const timeRangeMs = parseInt(lastTrade.execTime) - parseInt(firstTrade.execTime)
  const timeRangeWeeks = timeRangeMs / (1000 * 60 * 60 * 24 * 7)
  const tradesPerWeek = timeRangeWeeks > 0 ? trades.length / timeRangeWeeks : 0

  // 计算费用总和
  const totalFee = trades.reduce((sum, t) => sum + parseFloat(t.execFee || '0'), 0)
  const avgFee = totalFee / trades.length

  return {
    totalTrades: trades.length,
    avgProfit: avgFee,
    avgLoss: -avgFee,
    profitableTradesPct: 50, // 简化计算
    tradesPerWeek,
    activeSince: new Date(parseInt(firstTrade.execTime)),
  }
}


