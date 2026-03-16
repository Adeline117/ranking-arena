import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP, EXCHANGE_CONFIG, DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import type { TraderSource } from '@/lib/constants/exchanges'
import { tokens } from '@/lib/design-tokens'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box } from '@/app/components/base'
import ExchangeRankingClient from './ExchangeRankingClient'
import { logger } from '@/lib/logger'

export const revalidate = 3600 // ISR: 1 hour

let _supabaseInstance: import('@supabase/supabase-js').SupabaseClient | null = null

function getSupabase() {
  if (_supabaseInstance) return _supabaseInstance
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  if (!url || !key) return null
  _supabaseInstance = createClient(url, key, { auth: { persistSession: false } })
  return _supabaseInstance
}

// Pre-render pages for active exchanges at build time
const deadSet = new Set(DEAD_BLOCKED_PLATFORMS)
const ACTIVE_EXCHANGES = Object.keys(EXCHANGE_CONFIG).filter(
  (k) => !deadSet.has(k as TraderSource) && !k.startsWith('dune_') && k !== 'okx_wallet'
)

export async function generateStaticParams() {
  return ACTIVE_EXCHANGES.map((exchange) => ({ exchange }))
}

export const dynamicParams = true

const TYPE_LABELS: Record<string, { en: string; zh: string }> = {
  futures: { en: 'Futures', zh: '合约' },
  spot: { en: 'Spot', zh: '现货' },
  web3: { en: 'On-Chain', zh: '链上' },
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ exchange: string }>
}): Promise<Metadata> {
  const { exchange } = await params
  
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
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

  const title = `${displayName} ${labels.en} Trader Rankings`
  const description = `Top ${displayName} ${labels.en.toLowerCase()} traders ranked by Arena Score. Compare ROI, win rate, max drawdown, and PnL across 90-day windows. Updated every 3 hours.`

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/rankings/${exchange}`,
    },
    keywords: [
      displayName,
      `${displayName} trader ranking`,
      `${displayName} copy trading`,
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
        url: `${baseUrl}/api/og?title=${encodeURIComponent(`${displayName} Rankings`)}&subtitle=${encodeURIComponent(description.slice(0, 80))}`,
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
      images: [`${baseUrl}/api/og?title=${encodeURIComponent(`${displayName} Rankings`)}&subtitle=${encodeURIComponent(description.slice(0, 80))}`],
    },
    robots: { index: true, follow: true },
  }
}

interface TraderData {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  platform: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  followers: number | null
  trader_type?: string | null
  is_bot?: boolean
  captured_at?: string | null
}

async function fetchExchangeTraders(exchange: string): Promise<TraderData[]> {
  const supabase = getSupabase()
  if (!supabase) {
    logger.error(`[ExchangeRanking] No Supabase client for ${exchange} — env vars missing`)
    return []
  }

  try {
    // Use leaderboard_ranks (the primary ranking table) instead of trader_snapshots_v2
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, handle, avatar_url, source, roi, pnl, win_rate, max_drawdown, arena_score, followers, trader_type, computed_at')
      .eq('source', exchange)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .order('arena_score', { ascending: false, nullsFirst: false })
      .limit(1000)

    if (error) {
      logger.error(`[ExchangeRanking] Error fetching ${exchange}:`, error)
      return []
    }

    // Map to TraderData shape — use handle as trader_key for correct routing to /trader/[handle]
    const rows = (data || []).map((row: Record<string, unknown>) => ({
      trader_key: String(row.handle || row.source_trader_id || ''),
      display_name: row.handle ? String(row.handle) : null,
      avatar_url: row.avatar_url as string | null,
      platform: String(row.source || ''),
      roi: Number(row.roi ?? 0),
      pnl: Number(row.pnl ?? 0),
      win_rate: row.win_rate as number | null,
      max_drawdown: row.max_drawdown as number | null,
      arena_score: row.arena_score as number | null,
      followers: row.followers as number | null,
      trader_type: (row.trader_type as string) || null,
      is_bot: row.source === 'web3_bot' || row.trader_type === 'bot',
      captured_at: (row.computed_at as string) || null,
      _source_id: String(row.source_trader_id || ''),
    }))

    // Disambiguate duplicate display names by appending short ID suffix
    const nameCount = new Map<string, number>()
    for (const r of rows) {
      const name = (r.display_name || '').toLowerCase()
      nameCount.set(name, (nameCount.get(name) || 0) + 1)
    }
    const nameIndex = new Map<string, number>()
    for (const r of rows) {
      const name = (r.display_name || '').toLowerCase()
      if (nameCount.get(name)! > 1 && r.display_name) {
        const idx = (nameIndex.get(name) || 0) + 1
        nameIndex.set(name, idx)
        const suffix = r._source_id.slice(-4)
        r.display_name = `${r.display_name} #${suffix}`
      }
    }

    return rows
  } catch (e) {
    logger.error(`[ExchangeRanking] Exception for ${exchange}:`, e)
    return []
  }
}

export default async function ExchangeRankingPage({
  params,
}: {
  params: Promise<{ exchange: string }>
}) {
  const { exchange } = await params

  // Validate exchange slug — return 404 for unknown exchanges
  if (!EXCHANGE_NAMES[exchange]) {
    notFound()
  }

  // Return 404 for DEAD/blocked exchanges
  if (DEAD_BLOCKED_PLATFORMS.includes(exchange as TraderSource)) {
    notFound()
  }

  const displayName = EXCHANGE_NAMES[exchange]
  const traders = await fetchExchangeTraders(exchange)
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const labels = TYPE_LABELS[sourceType] || TYPE_LABELS.futures

  // JSON-LD ItemList for top traders (SEO structured data)
  const top100 = traders.slice(0, 100)
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${displayName} ${labels.en} Trader Rankings`,
    description: `Top ${displayName} ${labels.en.toLowerCase()} traders ranked by Arena Score`,
    numberOfItems: top100.length,
    itemListElement: top100.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Person',
        name: t.display_name || t.trader_key,
        url: `https://www.arenafi.org/trader/${encodeURIComponent(t.trader_key)}`,
        ...(t.avatar_url ? { image: t.avatar_url } : {}),
      },
    })),
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="max-w-5xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        <h1
          style={{
            fontSize: tokens.typography.fontSize['2xl'],
            fontWeight: tokens.typography.fontWeight.black,
            color: tokens.colors.text.primary,
            marginBottom: tokens.spacing[2],
          }}
        >
          {displayName} {labels.en} Trader Rankings
        </h1>
        <p
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.secondary,
            marginBottom: tokens.spacing[6],
          }}
        >
          {traders.length} traders | Ranked by Arena Score | 90-day window
        </p>

        <ExchangeRankingClient traders={traders} exchange={exchange} />
      </div>
      <MobileBottomNav />
    </Box>
  )
}
