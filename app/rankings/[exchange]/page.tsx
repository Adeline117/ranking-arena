import { Metadata } from 'next'
import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP, EXCHANGE_CONFIG, DEAD_BLOCKED_PLATFORMS, EXCHANGE_SLUG_ALIASES, resolveExchangeSlug } from '@/lib/constants/exchanges'
import type { TraderSource } from '@/lib/constants/exchanges'
import { tokens } from '@/lib/design-tokens'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import ExchangeRankingClient from './ExchangeRankingClient'
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { logger } from '@/lib/logger'
import { unstable_cache } from 'next/cache'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 600 // ISR: 10 min (aligned with compute-leaderboard on-demand revalidation)

// Pre-render pages for active exchanges at build time
// Include both canonical source keys AND slug aliases for SEO-friendly URLs
const deadSet = new Set(DEAD_BLOCKED_PLATFORMS)
const ACTIVE_EXCHANGES = Object.keys(EXCHANGE_CONFIG).filter(
  (k) => !deadSet.has(k as TraderSource) && !k.startsWith('dune_') && k !== 'okx_wallet'
)
// Also pre-render alias slugs (e.g. "binance" → binance_futures)
const ALIAS_SLUGS = Object.keys(EXCHANGE_SLUG_ALIASES)

export async function generateStaticParams() {
  const all = [...ACTIVE_EXCHANGES, ...ALIAS_SLUGS]
  // Deduplicate
  return [...new Set(all)].map((exchange) => ({ exchange }))
}

export const dynamicParams = true

const TYPE_LABELS: Record<string, { en: string; zh: string }> = {
  futures: { en: 'Futures', zh: '合约' },
  spot: { en: 'Spot', zh: '现货' },
  web3: { en: 'On-Chain', zh: '链上' },
}

// ---------------------------------------------------------------------------
// SEO: Exchange intro blurbs for programmatic landing pages
// Short 2-3 sentence descriptions targeting long-tail keywords like
// "best Bybit traders 2026", "top Binance futures traders"
// ---------------------------------------------------------------------------
const EXCHANGE_INTROS: Record<string, string> = {
  binance_futures: 'Binance is the world\'s largest crypto exchange by trading volume, offering futures contracts on hundreds of pairs. Discover the best-performing Binance futures copy traders and compare their risk-adjusted returns.',
  bybit: 'Bybit is a leading derivatives exchange known for its deep liquidity and copy trading features. Browse the top Bybit traders ranked by Arena Score to find consistent performers.',
  bitget_futures: 'Bitget is a top copy-trading platform with millions of users worldwide. See which Bitget futures traders deliver the best ROI and risk management over 90-day windows.',
  okx_futures: 'OKX is one of the most trusted crypto exchanges, offering advanced futures trading tools. Explore the highest-ranked OKX futures traders by Arena Score.',
  mexc: 'MEXC offers a wide selection of futures trading pairs with competitive fees. Find the top MEXC traders ranked by performance, drawdown, and consistency.',
  htx_futures: 'HTX (formerly Huobi) is a veteran crypto exchange with a robust futures market. Review the top HTX futures traders and their verified performance metrics.',
  coinex: 'CoinEx provides accessible futures trading for a global audience. Discover CoinEx\'s top-performing traders ranked by Arena\'s risk-adjusted scoring system.',
  bingx: 'BingX specializes in social and copy trading across futures markets. See the best BingX traders by ROI, win rate, and Arena Score.',
  gateio: 'Gate.io offers one of the widest selections of crypto futures markets. Browse top Gate.io traders and compare their performance across multiple timeframes.',
  xt: 'XT.COM is a growing crypto exchange with an active futures trading community. Explore top XT.COM traders ranked by Arena Score.',
  blofin: 'BloFin is a newer exchange focused on copy trading and derivatives. Find the best BloFin traders by risk-adjusted performance.',
  btcc: 'BTCC is one of the oldest Bitcoin exchanges, now offering futures trading. See how BTCC\'s top traders rank by Arena Score.',
  bitfinex: 'Bitfinex is a professional-grade exchange offering margin and derivatives trading. Discover Bitfinex\'s highest-performing traders.',
  bitunix: 'Bitunix offers futures copy trading with a growing user base. Compare the top Bitunix traders by ROI, PnL, and consistency.',
  toobit: 'Toobit is an emerging exchange offering futures and copy trading features. Browse top Toobit traders ranked by Arena Score.',
  etoro: 'eToro is a leading social trading platform supporting stocks and crypto. Explore the best eToro crypto traders by risk-adjusted returns.',
  binance_spot: 'Binance Spot is the world\'s most liquid crypto spot market. Discover top Binance spot traders ranked by Arena Score.',
  bybit_spot: 'Bybit Spot offers a growing selection of crypto spot trading pairs. See the best Bybit spot traders and their performance metrics.',
  binance_web3: 'Binance Web3 integrates on-chain DeFi access through the Binance ecosystem. Explore the top Binance Web3 traders by Arena Score.',
  okx_web3: 'OKX Web3 provides seamless access to decentralized trading across multiple chains. Discover the best OKX Web3 traders.',
  gmx: 'GMX is a decentralized perpetual exchange on Arbitrum and Avalanche. Browse top GMX traders ranked by on-chain verified performance.',
  dydx: 'dYdX is a leading decentralized derivatives exchange with full on-chain transparency. See the best dYdX traders by Arena Score.',
  hyperliquid: 'Hyperliquid is a high-performance on-chain perpetuals DEX with order book matching. Explore the top Hyperliquid traders.',
  gains: 'Gains Network (gTrade) offers decentralized leveraged trading on Arbitrum and Polygon. Discover top Gains traders by risk-adjusted returns.',
  jupiter_perps: 'Jupiter Perps is a Solana-based perpetual trading platform. Browse the best Jupiter Perps traders ranked by Arena Score.',
  aevo: 'Aevo is a decentralized options and perpetuals exchange. See top Aevo traders and their performance metrics.',
  drift: 'Drift is a Solana-based decentralized perpetual exchange with deep liquidity. Explore the highest-ranked Drift traders.',
  web3_bot: 'Web3 trading bots and AI agents compete alongside human traders. Discover the best-performing automated trading strategies across DeFi protocols.',
}

/** Get current year for SEO metadata */
const CURRENT_YEAR = new Date().getFullYear()

export async function generateMetadata({
  params,
}: {
  params: Promise<{ exchange: string }>
}): Promise<Metadata> {
  const rawExchange = (await params).exchange
  const exchange = resolveExchangeSlug(rawExchange)

  // Validate exchange — return 404 metadata for unknown exchanges
  if (!EXCHANGE_NAMES[exchange]) {
    return {
      title: 'Exchange Not Found',
      description: 'The requested exchange ranking page does not exist.',
    }
  }

  const displayName = EXCHANGE_NAMES[exchange]
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const labels = TYPE_LABELS[sourceType] || TYPE_LABELS.futures
  const baseUrl = BASE_URL

  // SEO-optimized title targeting long-tail keywords
  const title = `Top ${displayName} Traders ${CURRENT_YEAR} — Live ${labels.en} Rankings | Arena`
  const description = `Best ${displayName} ${labels.en.toLowerCase()} traders in ${CURRENT_YEAR}, ranked by Arena Score. Compare ROI, win rate, max drawdown, and PnL across 90-day windows. Updated every 30 minutes from live exchange data.`

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/rankings/${exchange}`,
    },
    keywords: [
      `best ${displayName.toLowerCase()} traders ${CURRENT_YEAR}`,
      `top ${displayName.toLowerCase()} ${labels.en.toLowerCase()} traders`,
      `${displayName.toLowerCase()} trader ranking`,
      `${displayName.toLowerCase()} copy trading`,
      `${displayName.toLowerCase()} leaderboard`,
      'crypto trader leaderboard',
      'ROI',
      'Arena Score',
      labels.en.toLowerCase(),
      'crypto',
      'Arena',
    ],
    openGraph: {
      title,
      description,
      type: 'website',
      url: `${baseUrl}/rankings/${exchange}`,
      siteName: 'Arena',
      images: [{
        url: `${baseUrl}/api/og/exchange?exchange=${encodeURIComponent(exchange)}`,
        width: 1200,
        height: 630,
        alt: title,
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      creator: '@arenafi',
      images: [`${baseUrl}/api/og/exchange?exchange=${encodeURIComponent(exchange)}`],
    },
    robots: { index: true, follow: true },
  }
}

// Slim SSR shape — only essential fields for above-the-fold render.
// avatar_url, followers, trader_type, is_bot, pnl are loaded client-side.
interface TraderSSR {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  sharpe_ratio: number | null
  captured_at?: string | null
}

// Full shape used by ExchangeRankingClient (kept for reference / client mapping)
interface TraderData {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  platform: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  followers: number | null
  sharpe_ratio: number | null
  trades_count: number | null
  trader_type?: string | null
  is_bot?: boolean
  captured_at?: string | null
}

// Use unstable_cache instead of tieredGetOrSet (Redis) for ISR pages.
// Upstash SDK's internal fetch uses `cache: 'no-store'` which forces Next.js
// to treat the entire page as dynamic, breaking ISR completely.
// unstable_cache uses Next.js's built-in Data Cache which is ISR-compatible.
//
// IMPORTANT: Only fetches 20 slim rows to keep the RSC/HTML payload small.
// The client fetches the full list post-hydration via /api/rankings.
const fetchExchangeTradersSSR = unstable_cache(
  async (exchange: string): Promise<{
    traders: TraderSSR[]
    totalCount: number
    top10ForJsonLd: Array<{ trader_key: string; display_name: string | null; avatar_url: string | null }>
  }> => {
    const supabase = getSupabaseAdmin()

    try {
      // Run 3 parallel queries to keep latency low:
      // 1. Top 20 slim rows for SSR table render
      // 2. Estimated total count (head-only, no row data)
      // 3. Top 10 with avatar_url for JSON-LD (not passed as RSC props)
      const [{ data, error }, { count }, { data: top10Data }] = await Promise.all([
        supabase
          .from('leaderboard_ranks')
          .select('source_trader_id, handle, avatar_url, roi, pnl, win_rate, max_drawdown, arena_score, sharpe_ratio, computed_at')
          .eq('source', exchange)
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false, nullsFirst: false })
          .limit(20),
        supabase
          .from('leaderboard_ranks')
          .select('*', { count: 'estimated', head: true })
          .eq('source', exchange)
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false'),
        supabase
          .from('leaderboard_ranks')
          .select('source_trader_id, handle, avatar_url')
          .eq('source', exchange)
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false, nullsFirst: false })
          .limit(10),
      ])

      if (error) {
        logger.error(`[ExchangeRanking] Error fetching ${exchange}:`, error)
        return { traders: [], totalCount: 0, top10ForJsonLd: [] }
      }

      const traders: TraderSSR[] = (data || []).map((row: Record<string, unknown>) => ({
        trader_key: String(row.handle || row.source_trader_id || ''),
        display_name: row.handle ? String(row.handle) : null,
        avatar_url: (row.avatar_url as string | null) ?? null,
        roi: row.roi != null ? Number(row.roi) : null,
        pnl: row.pnl != null ? Number(row.pnl) : null,
        win_rate: row.win_rate != null ? Number(row.win_rate) : null,
        max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
        arena_score: row.arena_score != null ? Number(row.arena_score) : null,
        sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
        captured_at: (row.computed_at as string) || null,
      }))

      const top10ForJsonLd = (top10Data || []).map((row: Record<string, unknown>) => ({
        trader_key: String(row.handle || row.source_trader_id || ''),
        display_name: row.handle ? String(row.handle) : null,
        avatar_url: (row.avatar_url as string | null) ?? null,
      }))

      return { traders, totalCount: count ?? traders.length, top10ForJsonLd }
    } catch (e) {
      logger.error(`[ExchangeRanking] Exception for ${exchange}:`, e)
      return { traders: [], totalCount: 0, top10ForJsonLd: [] }
    }
  },
  ['exchange-ranking-ssr'], // cache key prefix — different from old key to bust stale cache
  { revalidate: 300, tags: ['rankings'] } // 5 min, same as hot tier
)

// Keep the old name as a type alias so nothing else breaks if referenced externally
type _TraderDataCompat = TraderData

/**
 * Async server component that fetches and renders the ranking table.
 * Wrapped in Suspense by the page so the page shell streams instantly.
 *
 * Fetches only 20 slim rows for SSR — client hydrates full list post-mount.
 */
async function RankingsContent({ exchange }: { exchange: string }) {
  const displayName = EXCHANGE_NAMES[exchange]
  const { traders, totalCount, top10ForJsonLd } = await fetchExchangeTradersSSR(exchange)
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const labels = TYPE_LABELS[sourceType] || TYPE_LABELS.futures
  const baseUrl = BASE_URL

  // JSON-LD ItemList — top 10 only to keep HTML lean.
  // avatar_url is in a separate query result and NOT passed as RSC props.
  const itemListJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Top ${displayName} ${labels.en} Traders ${CURRENT_YEAR}`,
    description: `Best ${displayName} ${labels.en.toLowerCase()} traders ranked by Arena Score in ${CURRENT_YEAR}`,
    numberOfItems: top10ForJsonLd.length,
    itemListElement: top10ForJsonLd.map((t: { trader_key: string; display_name: string | null; avatar_url: string | null }, i: number) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Person',
        name: t.display_name || t.trader_key,
        url: `${baseUrl}/trader/${encodeURIComponent(t.trader_key)}`,
        ...(t.avatar_url ? { image: t.avatar_url } : {}),
      },
    })),
  }

  // BreadcrumbList JSON-LD for search engine navigation
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Arena',
        item: baseUrl,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Rankings',
        item: `${baseUrl}/rankings`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: `${displayName} ${labels.en}`,
        item: `${baseUrl}/rankings/${exchange}`,
      },
    ],
  }

  const introText = EXCHANGE_INTROS[exchange]

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      {/* SEO intro paragraph — crawlable, above the fold */}
      {introText && (
        <p
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.secondary,
            lineHeight: 1.6,
            marginBottom: tokens.spacing[4],
            maxWidth: '720px',
          }}
        >
          {introText}
        </p>
      )}
      <p
        style={{
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
          marginBottom: tokens.spacing[6],
        }}
      >
        {(totalCount || traders.length).toLocaleString('en-US')} traders | Ranked by Arena Score | 90-day window | Updated {new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
      </p>
      {/*
       * SSR passes 20 slim rows (no avatar_url / pnl / followers) to keep
       * the RSC payload and HTML tiny. Client fetches the full list with all
       * fields post-hydration via /api/rankings.
       */}
      <ExchangeRankingClient
        traders={traders.map((t) => ({
          ...t,
          platform: exchange,
          followers: null, trades_count: null,
          is_bot: false,
        }))}
        exchange={exchange}
        totalCount={totalCount || traders.length}
      />
    </>
  )
}

export default async function ExchangeRankingPage({
  params,
}: {
  params: Promise<{ exchange: string }>
}) {
  const rawExchange = (await params).exchange
  const exchange = resolveExchangeSlug(rawExchange)

  // Validate exchange slug — return 404 for unknown exchanges
  if (!EXCHANGE_NAMES[exchange]) {
    notFound()
  }

  // Return 404 for DEAD/blocked exchanges
  if (DEAD_BLOCKED_PLATFORMS.includes(exchange as TraderSource)) {
    notFound()
  }

  const displayName = EXCHANGE_NAMES[exchange]
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const labels = TYPE_LABELS[sourceType] || TYPE_LABELS.futures

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <div className="max-w-5xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        <h1
          style={{
            fontSize: tokens.typography.fontSize['2xl'],
            fontWeight: tokens.typography.fontWeight.black,
            color: tokens.colors.text.primary,
            marginBottom: tokens.spacing[2],
          }}
        >
          Top {displayName} Traders — Live {labels.en} Rankings
        </h1>

        <SectionErrorBoundary>
          <Suspense fallback={<RankingSkeleton rows={20} />}>
            <RankingsContent exchange={exchange} />
          </Suspense>
        </SectionErrorBoundary>
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}
