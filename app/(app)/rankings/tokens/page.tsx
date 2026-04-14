import type { Metadata } from 'next'
import { unstable_cache } from 'next/cache'
import TokensIndexClient from './TokensIndexClient'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const revalidate = 3600 // ISR: 1 hour (matches API cache)

// SSR timeout: getPopularTokens scans up to 50k rows and can be very slow
// during cron contention. First request (cache miss) is vulnerable.
const SSR_TIMEOUT_MS = 4000

export const metadata: Metadata = {
  title: 'Token Rankings — Who Trades BTC Best? | Arena',
  description:
    'Discover the best traders for every token. See who profits most trading BTC, ETH, SOL, and 50+ tokens across 27 exchanges.',
  alternates: {
    canonical: `${BASE_URL}/rankings/tokens`,
  },
  openGraph: {
    title: 'Token Rankings — Who Trades BTC Best?',
    description:
      'Token-level trader rankings across 27+ exchanges. Find the best BTC, ETH, SOL traders by PnL.',
    url: `${BASE_URL}/rankings/tokens`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Token Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Token Rankings — Who Trades BTC Best?',
    description: 'Token-level trader rankings. Find the best BTC, ETH, SOL traders.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

function extractBaseToken(symbol: string): string {
  const s = symbol.toUpperCase()
  for (const suffix of ['USDT.P', 'USDT', 'BUSD', 'USD', '-PERP', '-USD']) {
    if (s.endsWith(suffix)) return s.slice(0, -suffix.length)
  }
  if (s.includes('/')) return s.split('/')[0]
  return s
}

const getPopularTokens = unstable_cache(
  async (): Promise<PopularToken[]> => {
    try {
      const supabase = getSupabaseAdmin()
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 90)

      const { data, error } = await supabase
        .from('trader_position_history')
        .select('symbol, source, source_trader_id, pnl_usd')
        .gte('close_time', cutoff.toISOString())
        .not('pnl_usd', 'is', null)
        .limit(50000)

      if (error || !data || data.length === 0) return []

      const tokenMap = new Map<string, {
        tradeCount: number
        traders: Set<string>
        totalPnl: number
      }>()

      for (const row of data as Array<{ symbol: string; source: string; source_trader_id: string; pnl_usd: number | null }>) {
        const baseToken = extractBaseToken(row.symbol)
        if (!baseToken || baseToken.length > 10) continue

        if (!tokenMap.has(baseToken)) {
          tokenMap.set(baseToken, { tradeCount: 0, traders: new Set(), totalPnl: 0 })
        }
        const acc = tokenMap.get(baseToken)!
        acc.tradeCount++
        acc.traders.add(`${row.source}:${row.source_trader_id}`)
        acc.totalPnl += Number(row.pnl_usd) || 0
      }

      return [...tokenMap.entries()]
        .map(([token, acc]) => ({
          token,
          trade_count: acc.tradeCount,
          trader_count: acc.traders.size,
          total_pnl: Math.round(acc.totalPnl * 100) / 100,
        }))
        .sort((a, b) => b.trade_count - a.trade_count)
        .slice(0, 50)
    } catch {
      return []
    }
  },
  ['popular-tokens-ssr'],
  { revalidate: 3600, tags: ['rankings', 'popular-tokens'] }
)

export default async function TokensPage() {
  let initialTokens: PopularToken[] = []
  try {
    initialTokens = await Promise.race([
      getPopularTokens(),
      new Promise<PopularToken[]>((resolve) => setTimeout(() => resolve([]), SSR_TIMEOUT_MS)),
    ])
  } catch {
    // Timeout or error — render with empty data, client can fetch
  }

  return <TokensIndexClient initialTokens={initialTokens} />
}
