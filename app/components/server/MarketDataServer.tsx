/**
 * 市场数据服务端组件
 * 在服务端获取加密货币价格数据
 */

import * as cache from '@/lib/cache'
import { CacheKey, CACHE_TTL } from '@/lib/cache'

export interface MarketPrice {
  symbol: string
  price: number
  change24h: number
  changePercent24h: number
}

/**
 * 从服务端获取市场数据
 */
export async function getMarketData(): Promise<MarketPrice[]> {
  const cacheKey = CacheKey.market.prices()

  // 尝试从缓存获取
  const cached = await cache.get<MarketPrice[]>(cacheKey)
  if (cached) {
    return cached
  }

  try {
    // 使用 CoinGecko API 获取价格
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin,solana&vs_currencies=usd&include_24hr_change=true',
      {
        next: { revalidate: 10 }, // 10 秒重新验证
        headers: {
          'Accept': 'application/json',
        },
      }
    )

    if (!response.ok) {
      console.error('[MarketDataServer] API error:', response.status)
      return getDefaultMarketData()
    }

    const data = await response.json()

    const prices: MarketPrice[] = [
      {
        symbol: 'BTC',
        price: data.bitcoin?.usd || 0,
        change24h: data.bitcoin?.usd_24h_change || 0,
        changePercent24h: data.bitcoin?.usd_24h_change || 0,
      },
      {
        symbol: 'ETH',
        price: data.ethereum?.usd || 0,
        change24h: data.ethereum?.usd_24h_change || 0,
        changePercent24h: data.ethereum?.usd_24h_change || 0,
      },
      {
        symbol: 'BNB',
        price: data.binancecoin?.usd || 0,
        change24h: data.binancecoin?.usd_24h_change || 0,
        changePercent24h: data.binancecoin?.usd_24h_change || 0,
      },
      {
        symbol: 'SOL',
        price: data.solana?.usd || 0,
        change24h: data.solana?.usd_24h_change || 0,
        changePercent24h: data.solana?.usd_24h_change || 0,
      },
    ]

    // 缓存结果
    await cache.set(cacheKey, prices, { ttl: CACHE_TTL.MARKET_DATA })

    return prices
  } catch (error) {
    console.error('[MarketDataServer] Error:', error)
    return getDefaultMarketData()
  }
}

function getDefaultMarketData(): MarketPrice[] {
  return [
    { symbol: 'BTC', price: 0, change24h: 0, changePercent24h: 0 },
    { symbol: 'ETH', price: 0, change24h: 0, changePercent24h: 0 },
    { symbol: 'BNB', price: 0, change24h: 0, changePercent24h: 0 },
    { symbol: 'SOL', price: 0, change24h: 0, changePercent24h: 0 },
  ]
}

/**
 * 服务端组件 - 预渲染市场数据
 */
export default async function MarketDataServer() {
  const prices = await getMarketData()
  
  return (
    <script
      id="market-data"
      type="application/json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({ prices, updatedAt: new Date().toISOString() }),
      }}
    />
  )
}
