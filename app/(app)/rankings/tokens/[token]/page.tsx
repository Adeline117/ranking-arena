import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { unstable_cache } from 'next/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import TokenRankingClient, { type Period, type TokenTrader } from './TokenRankingClient'
import { BASE_URL } from '@/lib/constants/urls'
const CURRENT_YEAR = new Date().getFullYear()

// ISR: 1 hour (matches the by-token API cold-cache TTL).
export const revalidate = 3600

// Only allow 1-20 uppercase alphanumeric characters (valid crypto token symbols)
const VALID_TOKEN_RE = /^[A-Z0-9]{1,20}$/

const PAGE_SIZE = 50
const PERIOD_DAYS: Record<Period, number> = { '7D': 7, '30D': 30, '90D': 90 }

// SSR fetch budget: the position-history aggregation can be slow on a cold
// cache during cron contention; past it we hand an empty seed to the client,
// which then fetches on the wire (mirrors the tokens index page).
const SSR_TIMEOUT_MS = 4000

/**
 * Server-side first-page prefetch — replicates the GET /api/rankings/by-token
 * aggregation for offset 0 so the board paints rows on first byte instead of a
 * client-only spinner. Wrapped in unstable_cache (keyed on token+period) and
 * de-duped with the API's own Redis layer by the shared 1h ISR window.
 */
const getTokenTradersSSR = unstable_cache(
  async (token: string, period: Period): Promise<{ traders: TokenTrader[]; total: number }> => {
    try {
      const supabase = getSupabaseAdmin()
      const lookbackDays = PERIOD_DAYS[period] || 90
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - lookbackDays)
      const cutoffISO = cutoff.toISOString()

      // Indexed .in() over the common symbol formats — ilike('BTC%') statement-times-out.
      const symbolVariants = [
        `${token}USDT`,
        `${token}USDT.P`,
        `${token}USD`,
        `${token}/USDT`,
        `${token}/USD`,
        `${token}-PERP`,
      ]

      const { data: positionData } = await supabase
        .from('trader_position_history')
        .select('source, source_trader_id, pnl_usd, pnl_pct')
        .in('symbol', symbolVariants)
        .gte('close_time', cutoffISO)
        .not('pnl_usd', 'is', null)
        .limit(3000)

      if (!positionData || positionData.length === 0) return { traders: [], total: 0 }

      const traderMap = new Map<
        string,
        {
          source: string
          source_trader_id: string
          totalPnl: number
          tradeCount: number
          winCount: number
          pnlPcts: number[]
        }
      >()

      for (const row of positionData as Array<{
        source: string
        source_trader_id: string
        pnl_usd: number | null
        pnl_pct: number | null
      }>) {
        const key = `${row.source}:${row.source_trader_id}`
        let acc = traderMap.get(key)
        if (!acc) {
          acc = {
            source: row.source,
            source_trader_id: row.source_trader_id,
            totalPnl: 0,
            tradeCount: 0,
            winCount: 0,
            pnlPcts: [],
          }
          traderMap.set(key, acc)
        }
        const pnl = Number(row.pnl_usd) || 0
        acc.totalPnl += pnl
        acc.tradeCount++
        if (pnl > 0) acc.winCount++
        if (row.pnl_pct != null) acc.pnlPcts.push(Number(row.pnl_pct))
      }

      const sorted = [...traderMap.values()].sort((a, b) => b.totalPnl - a.totalPnl)
      const total = sorted.length
      const pageRows = sorted.slice(0, PAGE_SIZE)
      if (pageRows.length === 0) return { traders: [], total }

      const traderIds = pageRows.map((tr) => tr.source_trader_id)
      const { data: lrData } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl')
        .eq('season_id', period)
        .in('source_trader_id', traderIds)

      const lrMap = new Map<
        string,
        {
          handle: string | null
          avatar_url: string | null
          arena_score: number | null
          roi: number | null
          pnl: number | null
        }
      >()
      if (lrData) {
        for (const row of lrData as Array<Record<string, unknown>>) {
          lrMap.set(`${row.source}:${row.source_trader_id}`, {
            handle: (row.handle as string) || null,
            avatar_url: (row.avatar_url as string) || null,
            arena_score: row.arena_score != null ? Number(row.arena_score) : null,
            roi: row.roi != null ? Number(row.roi) : null,
            pnl: row.pnl != null ? Number(row.pnl) : null,
          })
        }
      }

      const traders: TokenTrader[] = pageRows.map((tr) => {
        const lr = lrMap.get(`${tr.source}:${tr.source_trader_id}`)
        const avgPnlPct =
          tr.pnlPcts.length > 0 ? tr.pnlPcts.reduce((s, v) => s + v, 0) / tr.pnlPcts.length : null
        return {
          source: tr.source,
          source_trader_id: tr.source_trader_id,
          handle: lr?.handle || null,
          avatar_url: lr?.avatar_url || null,
          arena_score: lr?.arena_score ?? null,
          roi: lr?.roi ?? null,
          total_pnl: lr?.pnl != null ? Number(lr.pnl) : 0,
          token_pnl: Math.round(tr.totalPnl * 100) / 100,
          token_trade_count: tr.tradeCount,
          token_win_rate:
            tr.tradeCount > 0 ? Math.round((tr.winCount / tr.tradeCount) * 10000) / 100 : null,
          token_avg_pnl_pct: avgPnlPct != null ? Math.round(avgPnlPct * 100) / 100 : null,
        }
      })

      return { traders, total }
    } catch {
      // Cold-cache timeout / transient DB error — empty seed, client refetches.
      return { traders: [], total: 0 }
    }
  },
  ['token-traders-ssr'],
  { revalidate: 3600, tags: ['rankings', 'by-token'] }
)

function normalizePeriod(raw: string | undefined): Period {
  const up = (raw || '').toUpperCase()
  return (['7D', '30D', '90D'] as const).includes(up as Period) ? (up as Period) : '90D'
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()

  const title = `Best ${token} Traders ${CURRENT_YEAR} — Who Trades ${token} Best? | Arena`
  const description = `Top traders for ${token} ranked by PnL. See who profits most trading ${token} across 27+ crypto exchanges. Updated hourly.`

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/rankings/tokens/${token}`,
    },
    keywords: [
      `best ${token} traders`,
      `top ${token} traders ${CURRENT_YEAR}`,
      `${token} trading leaderboard`,
      `${token} PnL ranking`,
      'crypto trader ranking',
      'Arena',
    ],
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/rankings/tokens/${token}`,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: `${BASE_URL}/og-image.png`,
          width: 1200,
          height: 630,
          alt: `Arena ${token} Rankings`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`${BASE_URL}/og-image.png`],
      creator: '@arenafi',
    },
    robots: { index: true, follow: true },
  }
}

export default async function TokenDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ period?: string }>
}) {
  const { token: rawToken } = await params
  const token = rawToken.toUpperCase()

  // Reject malformed token symbols (SQL injection, XSS, garbage URLs)
  if (!VALID_TOKEN_RE.test(token)) {
    notFound()
  }

  const period = normalizePeriod((await searchParams).period)

  let initial: { traders: TokenTrader[]; total: number } = { traders: [], total: 0 }
  try {
    initial = await Promise.race([
      getTokenTradersSSR(token, period),
      new Promise<{ traders: TokenTrader[]; total: number }>((resolve) =>
        setTimeout(() => resolve({ traders: [], total: 0 }), SSR_TIMEOUT_MS)
      ),
    ])
  } catch {
    // Timeout or error — render with empty seed, client fetches on mount.
  }

  return (
    <TokenRankingClient
      token={token}
      initialPeriod={period}
      initialTraders={initial.traders}
      initialTotal={initial.total}
      asOf={new Date().toISOString()}
    />
  )
}
