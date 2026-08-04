import { NextResponse, NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { getOrSetWithLock } from '@/lib/cache'
import {
  createMarketCoreSnapshot,
  MARKET_DEFAULT_PAIR_SYMBOLS,
  type MarketCoreRow,
  type MarketCoreSnapshot,
} from '@/lib/market/market-core-client-contract'
import { fetchMarketJson } from '@/lib/market/market-fetch'

export const runtime = 'edge'
export const dynamic = 'force-dynamic' // 禁用静态渲染

type MarketRow = MarketCoreRow
type MarketSource = MarketCoreSnapshot['source']

const TTL_MS = 120_000

// Coins to display（你可以随时加）
type Pair = {
  symbol: (typeof MARKET_DEFAULT_PAIR_SYMBOLS)[number]
  cgId: string
  cbProduct: string
}

const PAIRS: Pair[] = [
  { symbol: 'BTC-USD', cgId: 'bitcoin', cbProduct: 'BTC-USD' },
  { symbol: 'ETH-USD', cgId: 'ethereum', cbProduct: 'ETH-USD' },
  { symbol: 'SOL-USD', cgId: 'solana', cbProduct: 'SOL-USD' },
  { symbol: 'ARB-USD', cgId: 'arbitrum', cbProduct: 'ARB-USD' },
  { symbol: 'BNB-USD', cgId: 'binancecoin', cbProduct: 'BNB-USD' },
  { symbol: 'XRP-USD', cgId: 'ripple', cbProduct: 'XRP-USD' },
  { symbol: 'ADA-USD', cgId: 'cardano', cbProduct: 'ADA-USD' },
  { symbol: 'DOGE-USD', cgId: 'dogecoin', cbProduct: 'DOGE-USD' },
  { symbol: 'AVAX-USD', cgId: 'avalanche-2', cbProduct: 'AVAX-USD' },
  { symbol: 'LINK-USD', cgId: 'chainlink', cbProduct: 'LINK-USD' },
  { symbol: 'MATIC-USD', cgId: 'matic-network', cbProduct: 'MATIC-USD' },
  { symbol: 'DOT-USD', cgId: 'polkadot', cbProduct: 'DOT-USD' },
  { symbol: 'UNI-USD', cgId: 'uniswap', cbProduct: 'UNI-USD' },
  { symbol: 'ATOM-USD', cgId: 'cosmos', cbProduct: 'ATOM-USD' },
  { symbol: 'FIL-USD', cgId: 'filecoin', cbProduct: 'FIL-USD' },
  { symbol: 'APT-USD', cgId: 'aptos', cbProduct: 'APT-USD' },
  { symbol: 'OP-USD', cgId: 'optimism', cbProduct: 'OP-USD' },
  { symbol: 'SUI-USD', cgId: 'sui', cbProduct: 'SUI-USD' },
  { symbol: 'NEAR-USD', cgId: 'near', cbProduct: 'NEAR-USD' },
  { symbol: 'PEPE-USD', cgId: 'pepe', cbProduct: 'PEPE-USD' },
  { symbol: 'WIF-USD', cgId: 'dogwifcoin', cbProduct: 'WIF-USD' },
  { symbol: 'SHIB-USD', cgId: 'shiba-inu', cbProduct: 'SHIB-USD' },
  { symbol: 'TRX-USD', cgId: 'tron', cbProduct: 'TRX-USD' },
  { symbol: 'RENDER-USD', cgId: 'render-token', cbProduct: 'RENDER-USD' },
  { symbol: 'INJ-USD', cgId: 'injective-protocol', cbProduct: 'INJ-USD' },
]

// ---- 内存缓存（按 pairs key 缓存）----
// Note: on Edge runtime this Map lives only for the duration of the isolate lifetime
// (typically a single request). It still provides intra-request deduplication and is
// used as a last-resort stale fallback across back-to-back requests when the isolate
// happens to be reused. The primary shared cache is Redis (getOrSetWithLock).
const cacheMap = new Map<
  string,
  { ts: number; rows: MarketRow[]; source: MarketSource; collectedAt: string; stale: boolean }
>()

function marketResponse(input: {
  rows: MarketRow[]
  source: MarketSource
  cached: boolean
  stale: boolean
  requestedPairs: readonly string[]
  collectedAt: string
}) {
  return createMarketCoreSnapshot(input)
}

function formatRow(
  symbol: string,
  priceNum: number,
  pctNum: number,
  rawPrice?: number | null
): MarketRow {
  const direction: 'up' | 'down' = pctNum >= 0 ? 'up' : 'down'
  // Use raw price for small values (SHIB, PEPE etc.) to preserve significant digits
  const actualPrice = rawPrice != null ? rawPrice : priceNum
  let priceStr: string
  if (actualPrice < 0.0001) {
    priceStr = actualPrice.toFixed(8)
  } else if (actualPrice < 0.01) {
    priceStr = actualPrice.toFixed(6)
  } else if (actualPrice < 1) {
    priceStr = actualPrice.toFixed(4)
  } else {
    priceStr = Number(priceNum).toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  return {
    symbol,
    price: priceStr,
    changePct: `${pctNum >= 0 ? '+' : ''}${pctNum.toFixed(2)}%`,
    direction,
  }
}

// 说明：早期版本有 “默认 pairs” 的 CoinGecko/Coinbase 抓取函数。
// 现在统一使用 *ForPairs 版本，支持自定义 pairs，因此移除旧函数以避免未使用告警。

// Binance symbol → arena symbol mapping (USDT → USD normalisation)
const BINANCE_PAIR_MAP: Record<string, string> = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'ARB-USD': 'ARBUSDT',
  'BNB-USD': 'BNBUSDT',
  'XRP-USD': 'XRPUSDT',
  'ADA-USD': 'ADAUSDT',
  'DOGE-USD': 'DOGEUSDT',
  'AVAX-USD': 'AVAXUSDT',
  'LINK-USD': 'LINKUSDT',
  'MATIC-USD': 'MATICUSDT',
  'DOT-USD': 'DOTUSDT',
  'UNI-USD': 'UNIUSDT',
  'ATOM-USD': 'ATOMUSDT',
  'FIL-USD': 'FILUSDT',
  'APT-USD': 'APTUSDT',
  'OP-USD': 'OPUSDT',
  'SUI-USD': 'SUIUSDT',
  'NEAR-USD': 'NEARUSDT',
  'PEPE-USD': 'PEPEUSDT',
  'WIF-USD': 'WIFUSDT',
  'SHIB-USD': 'SHIBUSDT',
  'TRX-USD': 'TRXUSDT',
  'RENDER-USD': 'RENDERUSDT',
  'INJ-USD': 'INJUSDT',
}

// Next.js 缓存配置：revalidate 60秒（1分钟）
export const revalidate = 60

export async function GET(request: NextRequest) {
  // 公开 API 限流：每分钟 100 次
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const logger = createLogger('market-api')

  try {
    const { searchParams } = new URL(request.url)
    const pairsParam = searchParams.get('pairs')

    // 确定目标 pairs
    let targetPairs = PAIRS
    if (pairsParam) {
      const requestedPairs = pairsParam.split(',').filter(Boolean)
      targetPairs = PAIRS.filter((p) => requestedPairs.includes(p.symbol))
      if (targetPairs.length === 0) {
        targetPairs = PAIRS
      }
    }

    // 缓存 key 基于请求的 pairs
    const cacheKey = targetPairs
      .map((p) => p.symbol)
      .sort()
      .join(',')
    const redisCacheKey = `api:market:${cacheKey}`
    const now = Date.now()
    const cached = cacheMap.get(cacheKey)

    // 命中内存缓存直接返回
    if (cached && now - cached.ts < TTL_MS) {
      return NextResponse.json(
        marketResponse({
          rows: cached.rows,
          source: cached.source,
          cached: true,
          stale: cached.stale,
          requestedPairs: targetPairs.map((pair) => pair.symbol),
          collectedAt: cached.collectedAt,
        })
      )
    }

    // L2: Redis 缓存 (30秒 TTL，热数据)
    try {
      let generatedForRequest = false
      const result = await getOrSetWithLock<{
        rows: MarketRow[]
        source: MarketSource
        collectedAt: string
        stale: boolean
      }>(
        `${redisCacheKey}:v2`,
        async () => {
          generatedForRequest = true
          // 先尝试 CoinGecko
          try {
            const rows = await fetchFromCoinGeckoForPairs(targetPairs)
            return {
              rows,
              source: 'coingecko',
              collectedAt: new Date().toISOString(),
              stale: false,
            }
          } catch (e1) {
            const errorMessage = e1 instanceof Error ? e1.message : String(e1)
            const isRateLimit = errorMessage.includes('429') || errorMessage.includes('Rate limit')
            if (isRateLimit) {
              logger.warn('CoinGecko 速率限制 (429), 自动切换到 Coinbase')
            } else {
              logger.warn('CoinGecko 失败, 尝试 Coinbase', { error: errorMessage })
            }

            // 如果有过期内存缓存，429 时优先返回过期数据
            if (isRateLimit && cached) {
              return {
                rows: cached.rows,
                source: cached.source,
                collectedAt: cached.collectedAt,
                stale: true,
              }
            }

            try {
              const rows = await fetchFromCoinbaseForPairs(targetPairs)
              return {
                rows,
                source: 'coinbase',
                collectedAt: new Date().toISOString(),
                stale: false,
              }
            } catch (e2) {
              const e2msg = e2 instanceof Error ? e2.message : String(e2)
              logger.warn('Coinbase failed, trying Binance', { error: e2msg })
              const rows = await fetchFromBinanceForPairs(targetPairs)
              return {
                rows,
                source: 'binance',
                collectedAt: new Date().toISOString(),
                stale: false,
              }
            }
          }
        },
        { ttl: 120, lockTtl: 10 }
      )

      // 回填内存缓存
      cacheMap.set(cacheKey, {
        ts: Date.now(),
        rows: result.rows,
        source: result.source,
        collectedAt: result.collectedAt,
        stale: result.stale,
      })

      return NextResponse.json(
        marketResponse({
          rows: result.rows,
          source: result.source,
          cached: !generatedForRequest || result.stale,
          stale: result.stale,
          requestedPairs: targetPairs.map((pair) => pair.symbol),
          collectedAt: result.collectedAt,
        }),
        { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } }
      )
    } catch (e2: unknown) {
      // 最后手段：返回过期缓存
      if (cached) {
        return NextResponse.json(
          marketResponse({
            rows: cached.rows,
            source: cached.source,
            cached: true,
            stale: true,
            requestedPairs: targetPairs.map((pair) => pair.symbol),
            collectedAt: cached.collectedAt,
          })
        )
      }
      const e2Msg = e2 instanceof Error ? e2.message : 'unknown error'
      logger.error('All market data sources failed', { error: e2Msg })
      return NextResponse.json({ rows: [], error: e2Msg }, { status: 500 })
    }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'unknown error'
    logger.error('请求异常', { error: errorMessage })
    return NextResponse.json({ rows: [], error: errorMessage }, { status: 500 })
  }
}

// 为特定pairs获取数据（如果有自定义pairs则用ids过滤，否则拉top 100）
async function fetchFromCoinGeckoForPairs(pairs: Pair[]): Promise<MarketRow[]> {
  interface CoinGeckoMarketData {
    id: string
    symbol?: string
    current_price?: number | null
    price_change_percentage_24h?: number | null
    price_change_percentage_24h_in_currency?: number | null
  }

  const fetchHeaders = {
    accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; RankingArena/1.0)',
  }

  async function fetchPage(url: string): Promise<CoinGeckoMarketData[]> {
    const response = await fetchMarketJson(url, {
      cache: 'default',
      headers: fetchHeaders,
      timeoutMs: 10_000,
    })
    if (!Array.isArray(response.value)) throw new Error('CoinGecko returned a malformed body')
    return response.value as CoinGeckoMarketData[]
  }

  try {
    // Always use ids= parameter to fetch only the coins we need (much faster than top-N pages)
    const ids = pairs.map((p) => p.cgId).join(',')
    const data = await fetchPage(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h`
    )
    const rows: MarketRow[] = []
    for (const c of data) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string') continue
      const price = Number(c.current_price ?? NaN)
      const pct = Number(
        c.price_change_percentage_24h ?? c.price_change_percentage_24h_in_currency ?? Number.NaN
      )
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(pct)) continue
      const knownPair = pairs.find((p) => p.cgId === c.id)
      if (!knownPair) continue
      rows.push(formatRow(knownPair.symbol, price, pct, c.current_price))
    }

    if (rows.length === 0) throw new Error('CoinGecko returned no usable market rows')
    return rows
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('CoinGecko request timeout')
    }
    if (
      error instanceof Error &&
      (error.message?.includes('fetch failed') || error.message?.includes('Failed to fetch'))
    ) {
      throw new Error('CoinGecko network error: unable to connect')
    }
    throw error
  }
}

async function fetchFromCoinbaseForPairs(pairs: Pair[]): Promise<MarketRow[]> {
  const base = 'https://api.exchange.coinbase.com'

  const rows = await Promise.all(
    pairs.map(async (p) => {
      try {
        const url = `${base}/products/${encodeURIComponent(p.cbProduct)}/stats`
        const response = await fetchMarketJson(url, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
        })
        const s = response.value as { open?: number | string; last?: number | string }

        const open = Number(s.open ?? NaN)
        const last = Number(s.last ?? NaN)
        if (!Number.isFinite(open) || !Number.isFinite(last) || open <= 0 || last <= 0) {
          return null
        }
        const pct = ((last - open) / open) * 100
        return formatRow(p.symbol, last, pct, last)
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          return null // 超时返回null
        }
        if (
          error instanceof Error &&
          (error.message?.includes('fetch failed') || error.message?.includes('Failed to fetch'))
        ) {
          return null // 网络错误返回null
        }
        return null // 其他错误也返回null
      }
    })
  )

  const validRows = rows.filter((r): r is MarketRow => r !== null)
  if (validRows.length === 0) {
    throw new Error('Coinbase: all requests failed or timed out')
  }
  return validRows
}

async function fetchFromBinanceForPairs(pairs: Pair[]): Promise<MarketRow[]> {
  // Map arena pairs → Binance symbols (USDT quoted)
  const binanceSymbols = pairs
    .map((p) => BINANCE_PAIR_MAP[p.symbol])
    .filter((s): s is string => Boolean(s))

  if (binanceSymbols.length === 0) {
    throw new Error('Binance: no matching symbols for requested pairs')
  }

  const symbolsParam = JSON.stringify(binanceSymbols)
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`

  const response = await fetchMarketJson(url, {
    headers: { accept: 'application/json' },
    timeoutMs: 8_000,
  })

  interface BinanceTicker {
    symbol?: unknown
    lastPrice?: unknown
    priceChangePercent?: unknown
  }

  if (!Array.isArray(response.value)) throw new Error('Binance returned a malformed body')
  const tickers = response.value as BinanceTicker[]

  const rows: MarketRow[] = []
  for (const ticker of tickers) {
    if (
      typeof ticker.symbol !== 'string' ||
      typeof ticker.lastPrice !== 'string' ||
      typeof ticker.priceChangePercent !== 'string'
    ) {
      continue
    }
    const arenaPair = pairs.find((p) => BINANCE_PAIR_MAP[p.symbol] === ticker.symbol)
    if (!arenaPair) continue
    const price = Number(ticker.lastPrice)
    const pct = Number(ticker.priceChangePercent)
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(pct)) continue
    rows.push(formatRow(arenaPair.symbol, price, pct, price))
  }

  if (rows.length === 0) {
    throw new Error('Binance: no valid rows returned')
  }
  return rows
}
