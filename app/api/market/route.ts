import { NextResponse, NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { getOrSetWithLock } from '@/lib/cache'

export const runtime = 'edge'
export const dynamic = 'force-dynamic' // 禁用静态渲染

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

const TTL_MS = 120_000

// Coins to display（你可以随时加）
type Pair = {
  symbol: string
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
const cacheMap = new Map<string, { ts: number; rows: MarketRow[]; source: string }>()

function formatRow(symbol: string, priceNum: number, pctNum: number): MarketRow {
  const direction: 'up' | 'down' = pctNum >= 0 ? 'up' : 'down'
  return {
    symbol,
    price: Number(priceNum).toLocaleString(undefined, { maximumFractionDigits: 2 }),
    changePct: `${pctNum >= 0 ? '+' : ''}${pctNum.toFixed(2)}%`,
    direction,
  }
}

// 说明：早期版本有 “默认 pairs” 的 CoinGecko/Coinbase 抓取函数。
// 现在统一使用 *ForPairs 版本，支持自定义 pairs，因此移除旧函数以避免未使用告警。

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
    const cacheKey = targetPairs.map(p => p.symbol).sort().join(',')
    const redisCacheKey = `api:market:${cacheKey}`
    const now = Date.now()
    const cached = cacheMap.get(cacheKey)

    // 命中内存缓存直接返回
    if (cached && now - cached.ts < TTL_MS) {
      return NextResponse.json({ rows: cached.rows, source: cached.source, cached: true })
    }

    // L2: Redis 缓存 (30秒 TTL，热数据)
    try {
      const result = await getOrSetWithLock<{ rows: MarketRow[]; source: string }>(
        redisCacheKey,
        async () => {
          // 先尝试 CoinGecko
          try {
            const rows = await fetchFromCoinGeckoForPairs(targetPairs)
            return { rows, source: 'coingecko' }
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
              return { rows: cached.rows, source: cached.source }
            }

            const rows = await fetchFromCoinbaseForPairs(targetPairs)
            return { rows, source: 'coinbase' }
          }
        },
        { ttl: 120, lockTtl: 10 }
      )

      // 回填内存缓存
      cacheMap.set(cacheKey, { ts: Date.now(), rows: result.rows, source: result.source })

      return NextResponse.json(
        { rows: result.rows, source: result.source, cached: false },
        { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } }
      )
    } catch (e2: unknown) {
      // 最后手段：返回过期缓存
      if (cached) {
        return NextResponse.json({ rows: cached.rows, source: cached.source, cached: true, stale: true })
      }
      const e2Msg = e2 instanceof Error ? e2.message : 'unknown error'
      logger.error('All market data sources failed', { error: e2Msg })
      return NextResponse.json(
        { rows: [], error: e2Msg },
        { status: 500 }
      )
    }
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'unknown error'
    logger.error('请求异常', { error: errorMessage })
    return NextResponse.json(
      { rows: [], error: errorMessage },
      { status: 500 }
    )
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
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    try {
      const res = await fetch(url, { cache: 'default', headers: fetchHeaders, signal: controller.signal })
      clearTimeout(timeoutId)
      if (!res.ok) {
        if (res.status === 429) throw new Error(`CoinGecko HTTP 429: Rate limit exceeded.`)
        throw new Error(`CoinGecko HTTP ${res.status}`)
      }
      return (await res.json()) as CoinGeckoMarketData[]
    } catch (e) {
      clearTimeout(timeoutId)
      throw e
    }
  }

  try {
    // Always use ids= parameter to fetch only the coins we need (much faster than top-N pages)
    const ids = pairs.map(p => p.cgId).join(',')
    const data = await fetchPage(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h`)
    const rows: MarketRow[] = []
    for (const c of data) {
      const price = Number(c.current_price ?? NaN)
      const pct = Number(c.price_change_percentage_24h ?? c.price_change_percentage_24h_in_currency ?? 0)
      if (!Number.isFinite(price)) continue
      // Use symbol from known pairs, or generate from CoinGecko data
      const knownPair = pairs.find(p => p.cgId === c.id)
      const symbol = knownPair?.symbol || `${(c.symbol || c.id).toUpperCase()}-USD`
      rows.push(formatRow(symbol, price, Number.isFinite(pct) ? pct : 0))
    }

    return rows
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('CoinGecko request timeout')
    }
    if (error instanceof Error && (error.message?.includes('fetch failed') || error.message?.includes('Failed to fetch'))) {
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
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 8000) // 8秒超时

        const res = await fetch(url, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        
        clearTimeout(timeoutId)

        if (!res.ok) {
          return null // 返回null表示失败
        }
        const s = await res.json() as { open?: number; last?: number }

        const open = Number(s.open ?? NaN)
        const last = Number(s.last ?? NaN)
        if (!Number.isFinite(open) || !Number.isFinite(last) || open <= 0) {
          return null
        }
        const pct = ((last - open) / open) * 100
        return formatRow(p.symbol, last, pct)
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          return null // 超时返回null
        }
        if (error instanceof Error && (error.message?.includes('fetch failed') || error.message?.includes('Failed to fetch'))) {
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
