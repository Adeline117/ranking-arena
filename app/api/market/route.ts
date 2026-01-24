import { NextResponse, NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic' // 禁用静态渲染

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

const TTL_MS = 60_000

// ✅ 你想展示的币（你可以随时加）
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
    const now = Date.now()
    const cached = cacheMap.get(cacheKey)

    // 命中缓存直接返回
    if (cached && now - cached.ts < TTL_MS) {
      return NextResponse.json({ rows: cached.rows, source: cached.source, cached: true })
    }

    // 先尝试 CoinGecko
    try {
      const rows = await fetchFromCoinGeckoForPairs(targetPairs)
      cacheMap.set(cacheKey, { ts: now, rows, source: 'coingecko' })
      return NextResponse.json(
        { rows, source: 'coingecko', cached: false },
        { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
      )
    } catch (e1) {
      // Fallback 到 Coinbase
      const errorMessage = e1 instanceof Error ? e1.message : String(e1)
      const isRateLimit = errorMessage.includes('429') || errorMessage.includes('Rate limit')
      if (isRateLimit) {
        logger.warn('CoinGecko 速率限制 (429), 自动切换到 Coinbase')
      } else {
        logger.warn('CoinGecko 失败, 尝试 Coinbase', { error: errorMessage })
      }

      // 如果有过期缓存，429 时优先返回过期数据
      if (isRateLimit && cached) {
        return NextResponse.json({ rows: cached.rows, source: cached.source, cached: true, stale: true })
      }

      try {
        const rows = await fetchFromCoinbaseForPairs(targetPairs)
        cacheMap.set(cacheKey, { ts: now, rows, source: 'coinbase' })
        return NextResponse.json(
          { rows, source: 'coinbase', cached: false },
          { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
        )
      } catch (e2: unknown) {
        // 最后手段：返回过期缓存
        if (cached) {
          return NextResponse.json({ rows: cached.rows, source: cached.source, cached: true, stale: true })
        }
        const e2Msg = e2 instanceof Error ? e2.message : 'unknown error'
        logger.error('Coinbase 也失败', { error: e2Msg })
        return NextResponse.json(
          { rows: [], error: `Both sources failed. CoinGecko: ${errorMessage}, Coinbase: ${e2Msg}` },
          { status: 500 }
        )
      }
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

// 为特定pairs获取数据
async function fetchFromCoinGeckoForPairs(pairs: Pair[]): Promise<MarketRow[]> {
  const ids = pairs.map((p) => p.cgId).join(',')
  const url =
    'https://api.coingecko.com/api/v3/coins/markets' +
    '?vs_currency=usd' +
    '&ids=' +
    encodeURIComponent(ids) +
    '&price_change_percentage=24h'

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000) // 10秒超时

  try {
    const res = await fetch(url, {
      cache: 'default', // 使用默认缓存以减少API调用
      headers: { 
        accept: 'application/json',
        // 添加 User-Agent 以减少被限流的风险
        'User-Agent': 'Mozilla/5.0 (compatible; RankingArena/1.0)',
      },
      signal: controller.signal,
    })
    
    clearTimeout(timeoutId)

    if (!res.ok) {
      // 429 速率限制错误：直接抛出，让上层处理回退到 Coinbase
      if (res.status === 429) {
        const txt = await res.text().catch(() => '')
        throw new Error(`CoinGecko HTTP 429: Rate limit exceeded. ${txt.slice(0, 100)}`)
      }
      const txt = await res.text().catch(() => '')
      throw new Error(`CoinGecko HTTP ${res.status}: ${txt.slice(0, 160)}`)
    }

    interface CoinGeckoMarketData {
      id: string
      current_price?: number | null
      price_change_percentage_24h?: number | null
      price_change_percentage_24h_in_currency?: number | null
    }
    
    const data = (await res.json()) as CoinGeckoMarketData[]
    const byId = new Map<string, CoinGeckoMarketData>()
    for (const c of data) byId.set(String(c.id), c)

    const rows: MarketRow[] = []
    for (const p of pairs) {
      const c = byId.get(p.cgId)
      if (!c) continue // 跳过缺失的币种

      const price = Number(c.current_price ?? NaN)
      const pct = Number(c.price_change_percentage_24h ?? c.price_change_percentage_24h_in_currency ?? 0)

      if (!Number.isFinite(price)) continue
      rows.push(formatRow(p.symbol, price, Number.isFinite(pct) ? pct : 0))
    }

    return rows
  } catch (error) {
    clearTimeout(timeoutId)
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
      } catch (error) {
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
