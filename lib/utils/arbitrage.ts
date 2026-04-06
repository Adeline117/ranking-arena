/**
 * 加密货币套利检测工具
 * 基于 Peregrine 项目的 Bellman-Ford 负环检测思路
 * 支持跨交易所套利和三角套利
 */

import 'server-only'
import type { Exchange, Ticker } from 'ccxt'

let _ccxt: typeof import('ccxt') | null = null
async function getCcxt() {
  if (!_ccxt) { _ccxt = await import('ccxt') }
  return _ccxt
}

// ---- 类型定义 ----

export interface CrossExchangeOpportunity {
  type: 'cross-exchange'
  symbol: string
  buyExchange: string
  sellExchange: string
  buyPrice: number
  sellPrice: number
  spreadPct: number
  updatedAt: number
}

export interface TriangularOpportunity {
  type: 'triangular'
  exchange: string
  path: string[] // e.g. ['BTC', 'ETH', 'USDT', 'BTC']
  steps: { from: string; to: string; rate: number; symbol: string }[]
  profitPct: number
  updatedAt: number
}

export type ArbitrageOpportunity = CrossExchangeOpportunity | TriangularOpportunity

// ---- 缓存 ----

interface CacheEntry<T> {
  data: T
  ts: number
}

const CACHE_TTL = 30_000
const tickerCache = new Map<string, CacheEntry<Record<string, Ticker>>>()
const resultCache: CacheEntry<ArbitrageOpportunity[]> = { data: [], ts: 0 }

// ---- 交易所实例 ----

const EXCHANGE_IDS = ['binance', 'okx', 'bybit', 'gateio', 'kucoin', 'htx'] as const

const TARGET_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT',
  'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT', 'BNB/USDT',
  'ETH/BTC', 'SOL/BTC', 'XRP/BTC', 'DOGE/BTC',
  'SOL/ETH', 'LINK/ETH',
]

// 三角套利路径 (在同一交易所内)
const TRIANGULAR_PATHS: [string, string, string][] = [
  ['BTC', 'ETH', 'USDT'],
  ['BTC', 'SOL', 'USDT'],
  ['BTC', 'XRP', 'USDT'],
  ['BTC', 'DOGE', 'USDT'],
  ['BTC', 'LINK', 'USDT'],
  ['ETH', 'SOL', 'USDT'],
  ['ETH', 'LINK', 'USDT'],
]

async function getExchange(id: string): Promise<Exchange> {
  const ccxt = await getCcxt()
  const Ex = (ccxt as unknown as Record<string, new (opts: object) => Exchange>)[id]
  if (!Ex) throw new Error(`Unknown exchange: ${id}`)
  return new Ex({ enableRateLimit: true, timeout: 10_000 })
}

async function fetchTickers(exchangeId: string): Promise<Record<string, Ticker>> {
  const cached = tickerCache.get(exchangeId)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  const ex = await getExchange(exchangeId)
  try {
    const tickers = await ex.fetchTickers(TARGET_SYMBOLS)
    const entry = { data: tickers, ts: Date.now() }
    tickerCache.set(exchangeId, entry)
    return tickers
  } catch (_err) {
    /* exchange ticker fetch failed, fall back to cached data */
    return cached?.data ?? {}
  }
}

// ---- 跨交易所套利检测 ----

function detectCrossExchange(
  allTickers: Map<string, Record<string, Ticker>>
): CrossExchangeOpportunity[] {
  const opportunities: CrossExchangeOpportunity[] = []
  const symbolMap = new Map<string, { exchange: string; bid: number; ask: number }[]>()

  for (const [exId, tickers] of allTickers) {
    for (const [symbol, ticker] of Object.entries(tickers)) {
      if (!ticker.bid || !ticker.ask || ticker.bid <= 0 || ticker.ask <= 0) continue
      if (!symbolMap.has(symbol)) symbolMap.set(symbol, [])
      symbolMap.get(symbol)!.push({ exchange: exId, bid: ticker.bid, ask: ticker.ask })
    }
  }

  for (const [symbol, entries] of symbolMap) {
    if (entries.length < 2) continue

    let bestBid = entries[0], bestAsk = entries[0]
    for (const e of entries) {
      if (e.bid > bestBid.bid) bestBid = e
      if (e.ask < bestAsk.ask) bestAsk = e
    }

    if (bestBid.exchange === bestAsk.exchange) continue
    const spreadPct = ((bestBid.bid - bestAsk.ask) / bestAsk.ask) * 100
    if (spreadPct <= 0.05) continue // 过滤掉太小的价差

    opportunities.push({
      type: 'cross-exchange',
      symbol,
      buyExchange: bestAsk.exchange,
      sellExchange: bestBid.exchange,
      buyPrice: bestAsk.ask,
      sellPrice: bestBid.bid,
      spreadPct: Math.round(spreadPct * 1000) / 1000,
      updatedAt: Date.now(),
    })
  }

  return opportunities.sort((a, b) => b.spreadPct - a.spreadPct)
}

// ---- 三角套利检测 (Bellman-Ford 负环思路简化版) ----

function detectTriangular(
  allTickers: Map<string, Record<string, Ticker>>
): TriangularOpportunity[] {
  const opportunities: TriangularOpportunity[] = []

  for (const [exId, tickers] of allTickers) {
    for (const [a, b, c] of TRIANGULAR_PATHS) {
      // 路径: A -> B -> C -> A
      // 需要: A/B (或 B/A), B/C (或 C/B), C/A (或 A/C)
      const rate1 = getRate(tickers, a, b)
      const rate2 = getRate(tickers, b, c)
      const rate3 = getRate(tickers, c, a)

      if (!rate1 || !rate2 || !rate3) continue

      // 从1单位A出发，经过三次兑换回到A
      const finalAmount = rate1.rate * rate2.rate * rate3.rate
      const profitPct = (finalAmount - 1) * 100

      if (profitPct <= 0.05) continue

      opportunities.push({
        type: 'triangular',
        exchange: exId,
        path: [a, b, c, a],
        steps: [rate1, rate2, rate3],
        profitPct: Math.round(profitPct * 1000) / 1000,
        updatedAt: Date.now(),
      })
    }
  }

  return opportunities.sort((a, b) => b.profitPct - a.profitPct)
}

function getRate(
  tickers: Record<string, Ticker>,
  from: string,
  to: string
): { from: string; to: string; rate: number; symbol: string } | null {
  // 尝试 FROM/TO 对
  const direct = `${from}/${to}`
  const t1 = tickers[direct]
  if (t1?.ask && t1.ask > 0) {
    return { from, to, rate: 1 / t1.ask, symbol: direct }
  }

  // 尝试 TO/FROM 对 (反向)
  const inverse = `${to}/${from}`
  const t2 = tickers[inverse]
  if (t2?.bid && t2.bid > 0) {
    return { from, to, rate: t2.bid, symbol: inverse }
  }

  return null
}

// ---- 主入口 ----

export async function detectArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
  // 检查缓存
  if (Date.now() - resultCache.ts < CACHE_TTL && resultCache.data.length > 0) {
    return resultCache.data
  }

  const allTickers = new Map<string, Record<string, Ticker>>()

  // 并发获取所有交易所数据
  const results = await Promise.allSettled(
    EXCHANGE_IDS.map(async (id) => {
      const tickers = await fetchTickers(id)
      return { id, tickers }
    })
  )

  for (const r of results) {
    if (r.status === 'fulfilled' && Object.keys(r.value.tickers).length > 0) {
      allTickers.set(r.value.id, r.value.tickers)
    }
  }

  if (allTickers.size < 2) {
    return resultCache.data // 返回旧缓存数据
  }

  const cross = detectCrossExchange(allTickers)
  const triangular = detectTriangular(allTickers)

  const all = [...cross, ...triangular].sort((a, b) => {
    const pA = a.type === 'cross-exchange' ? a.spreadPct : a.profitPct
    const pB = b.type === 'cross-exchange' ? b.spreadPct : b.profitPct
    return pB - pA
  })

  resultCache.data = all.slice(0, 20)
  resultCache.ts = Date.now()

  return resultCache.data
}
