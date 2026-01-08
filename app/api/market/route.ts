import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

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

// ---- 简单内存缓存（60s）----
// 注意：在 Serverless 环境可能会被重置（但仍然能显著减少调用）。
let cache: { ts: number; rows: MarketRow[]; source: string } | null = null

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

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const pairsParam = searchParams.get('pairs')
    
    console.log('[Market API] 请求市场数据, pairs:', pairsParam || 'default')
    
    // 如果提供了自定义pairs，使用它们；否则使用默认PAIRS
    let targetPairs = PAIRS
    if (pairsParam) {
      const requestedPairs = pairsParam.split(',').filter(Boolean)
      // 只使用在PAIRS中存在的币种
      targetPairs = PAIRS.filter((p) => requestedPairs.includes(p.symbol))
      if (targetPairs.length === 0) {
        targetPairs = PAIRS // 如果都不存在，回退到默认
      }
    }

    // 1) 命中缓存直接返回（如果请求的pairs与缓存一致）
    const now = Date.now()
    if (cache && now - cache.ts < TTL_MS && !pairsParam) {
      console.log('[Market API] 返回缓存数据, source:', cache.source)
      return NextResponse.json({ rows: cache.rows, source: cache.source, cached: true })
    }

    // 2) 先主源 CoinGecko
    try {
      console.log('[Market API] 尝试从 CoinGecko 获取数据...')
      const rows = await fetchFromCoinGeckoForPairs(targetPairs)
      console.log('[Market API] CoinGecko 成功, 返回', rows.length, '条数据')
      
      if (!pairsParam) {
        cache = { ts: now, rows, source: 'coingecko' }
      }
      return NextResponse.json({ rows, source: 'coingecko', cached: false })
    } catch (e1: any) {
      // 3) fallback 到 Coinbase
      console.warn('[Market API] CoinGecko 失败:', e1?.message, '尝试 Coinbase...')
      try {
        const rows = await fetchFromCoinbaseForPairs(targetPairs)
        console.log('[Market API] Coinbase 成功, 返回', rows.length, '条数据')
        
        if (!pairsParam) {
          cache = { ts: now, rows, source: 'coinbase' }
        }
        return NextResponse.json({
          rows,
          source: 'coinbase',
          cached: false,
          warning: `Primary failed: ${e1?.message ?? 'unknown'}`,
        })
      } catch (e2: any) {
        console.error('[Market API] Coinbase 也失败:', e2?.message)
        return NextResponse.json(
          { 
            rows: [], 
            error: `Both sources failed. CoinGecko: ${e1?.message ?? 'unknown'}, Coinbase: ${e2?.message ?? 'unknown'}` 
          },
          { status: 500 }
        )
      }
    }
  } catch (e: any) {
    console.error('[Market API] 请求异常:', e)
    return NextResponse.json(
      { rows: [], error: e?.message ?? 'unknown error' },
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

  const res = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`CoinGecko HTTP ${res.status}: ${txt.slice(0, 160)}`)
  }

  const data = (await res.json()) as any[]
  const byId = new Map<string, any>()
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
}

async function fetchFromCoinbaseForPairs(pairs: Pair[]): Promise<MarketRow[]> {
  const base = 'https://api.exchange.coinbase.com'

  const rows = await Promise.all(
    pairs.map(async (p) => {
      const url = `${base}/products/${encodeURIComponent(p.cbProduct)}/stats`
      const res = await fetch(url, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        return null // 返回null表示失败
      }
      const s = (await res.json()) as any

      const open = Number(s.open ?? NaN)
      const last = Number(s.last ?? NaN)
      if (!Number.isFinite(open) || !Number.isFinite(last) || open <= 0) {
        return null
      }
      const pct = ((last - open) / open) * 100
      return formatRow(p.symbol, last, pct)
    })
  )

  return rows.filter((r): r is MarketRow => r !== null)
}
