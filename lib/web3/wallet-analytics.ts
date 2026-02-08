/**
 * 钱包分析工具函数
 * 基于链上交易数据计算 PnL 曲线、胜率、持仓时间等指标
 * 参考 crypto_wallet_analyzer 项目的分析思路:
 *   - 按代币聚合交易 (买入/卖出配对)
 *   - 计算每笔交易的盈亏
 *   - 统计胜率、平均持仓时间、最常交易代币
 */

import type { Transaction, TokenHolding } from './on-chain-tracker'

// --- 类型定义 ---

export interface TradeRecord {
  tokenSymbol: string
  tokenAddress: string
  buyTimestamp: number
  sellTimestamp: number | null
  buyValue: number
  sellValue: number | null
  pnl: number | null
  holdTimeSeconds: number | null
  closed: boolean
}

export interface PnlDataPoint {
  timestamp: number
  cumulativePnl: number
}

export interface WalletAnalyticsResult {
  totalTrades: number
  closedTrades: number
  profitableTrades: number
  unprofitableTrades: number
  winRate: number
  totalPnl: number
  averageHoldTimeSeconds: number
  pnlCurve: PnlDataPoint[]
  mostTradedTokens: Array<{ symbol: string; address: string; count: number; totalVolume: number }>
  tokenDistribution: Array<{ symbol: string; balance: number; percentage: number }>
}

/**
 * 从交易列表中提取简化的交易记录。
 * 注意: 这是基于原生代币流入/流出的粗略估算。
 * 真正精确的 PnL 需要解析 ERC20 Transfer 事件日志。
 */
export function analyzeTransactions(
  transactions: Transaction[],
  walletAddress: string,
): Omit<WalletAnalyticsResult, 'tokenDistribution'> {
  const addr = walletAddress.toLowerCase()

  // 按时间排序 (从旧到新)
  const sorted = [...transactions]
    .filter((tx) => tx.timestamp !== null)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

  // 简单模型: 每笔流出视为 "买入" (花费原生代币买代币), 每笔流入视为 "卖出" (卖代币收到原生代币)
  const outflows: Array<{ timestamp: number; value: number }> = []
  const inflows: Array<{ timestamp: number; value: number }> = []

  for (const tx of sorted) {
    const value = parseFloat(tx.value)
    if (value === 0 || tx.status === 'reverted') continue

    if (tx.from.toLowerCase() === addr && tx.to) {
      outflows.push({ timestamp: tx.timestamp!, value })
    }
    if (tx.to?.toLowerCase() === addr) {
      inflows.push({ timestamp: tx.timestamp!, value })
    }
  }

  // 配对: FIFO 匹配买入和卖出
  const trades: TradeRecord[] = []
  const pendingBuys = [...outflows]

  for (const sell of inflows) {
    if (pendingBuys.length > 0) {
      const buy = pendingBuys.shift()!
      trades.push({
        tokenSymbol: 'NATIVE',
        tokenAddress: '0x0',
        buyTimestamp: buy.timestamp,
        sellTimestamp: sell.timestamp,
        buyValue: buy.value,
        sellValue: sell.value,
        pnl: sell.value - buy.value,
        holdTimeSeconds: sell.timestamp - buy.timestamp,
        closed: true,
      })
    }
  }

  // 剩余未配对的买入
  for (const buy of pendingBuys) {
    trades.push({
      tokenSymbol: 'NATIVE',
      tokenAddress: '0x0',
      buyTimestamp: buy.timestamp,
      sellTimestamp: null,
      buyValue: buy.value,
      sellValue: null,
      pnl: null,
      holdTimeSeconds: null,
      closed: false,
    })
  }

  const closedTrades = trades.filter((t) => t.closed)
  const profitableTrades = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length
  const unprofitableTrades = closedTrades.filter((t) => (t.pnl ?? 0) <= 0).length
  const winRate = closedTrades.length > 0 ? profitableTrades / closedTrades.length : 0
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)

  const holdTimes = closedTrades
    .map((t) => t.holdTimeSeconds)
    .filter((h): h is number => h !== null && h > 0)
  const averageHoldTimeSeconds =
    holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0

  // 累积 PnL 曲线
  let cumPnl = 0
  const pnlCurve: PnlDataPoint[] = closedTrades.map((t) => {
    cumPnl += t.pnl ?? 0
    return { timestamp: t.sellTimestamp!, cumulativePnl: cumPnl }
  })

  // 最常交易的代币 (聚合目标地址作为 "代币" 代理)
  const tokenCounts = new Map<string, { count: number; volume: number }>()
  for (const tx of sorted) {
    const value = parseFloat(tx.value)
    if (value === 0 || tx.status === 'reverted') continue
    const target = tx.from.toLowerCase() === addr ? (tx.to ?? 'unknown') : tx.from
    const key = target.toLowerCase()
    const prev = tokenCounts.get(key) ?? { count: 0, volume: 0 }
    prev.count += 1
    prev.volume += value
    tokenCounts.set(key, prev)
  }

  const mostTradedTokens = Array.from(tokenCounts.entries())
    .map(([address, d]) => ({
      symbol: `${address.slice(0, 6)}...${address.slice(-4)}`,
      address,
      count: d.count,
      totalVolume: d.volume,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    totalTrades: trades.length,
    closedTrades: closedTrades.length,
    profitableTrades,
    unprofitableTrades,
    winRate,
    totalPnl,
    averageHoldTimeSeconds,
    pnlCurve,
    mostTradedTokens,
  }
}

/**
 * 计算代币持仓分布比例
 */
export function computeTokenDistribution(
  holdings: TokenHolding[],
): Array<{ symbol: string; balance: number; percentage: number }> {
  const parsed = holdings.map((h) => ({
    symbol: h.symbol,
    balance: parseFloat(h.balance),
  }))

  const total = parsed.reduce((sum, h) => sum + h.balance, 0)

  return parsed
    .map((h) => ({
      symbol: h.symbol,
      balance: h.balance,
      percentage: total > 0 ? (h.balance / total) * 100 : 0,
    }))
    .sort((a, b) => b.balance - a.balance)
}

/**
 * 格式化持仓时间为人类可读格式
 */
export function formatHoldTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}小时`
  return `${(seconds / 86400).toFixed(1)}天`
}
