import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
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

// No generateStaticParams — pages are ISR-rendered on first request
// This avoids empty cached pages from build time
export const dynamicParams = true

export async function generateMetadata({
  params,
}: {
  params: Promise<{ exchange: string }>
}): Promise<Metadata> {
  const { exchange } = await params
  const displayName = EXCHANGE_NAMES[exchange] || exchange
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const typeLabel = sourceType === 'futures' ? '合约' : sourceType === 'spot' ? '现货' : '链上'
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

  const title = `${displayName} ${typeLabel}交易员排行榜 - Arena`
  const description = `查看 ${displayName} 平台最新${typeLabel}交易员排行榜，包含 ROI、胜率、最大回撤、Arena Score 等关键指标。实时更新，助你发现顶级交易员。`

  return {
    title,
    description,
    alternates: {
      canonical: `${baseUrl}/rankings/${exchange}`,
    },
    keywords: [
      displayName,
      '交易员排行榜',
      'trader ranking',
      'ROI',
      'Arena Score',
      typeLabel,
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
        url: `${baseUrl}/api/og?title=${encodeURIComponent(`${displayName} 排行榜`)}&subtitle=${encodeURIComponent(description.slice(0, 80))}`,
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
      .select('source_trader_id, handle, avatar_url, source, roi, pnl, win_rate, max_drawdown, arena_score, followers, trader_type')
      .eq('source', exchange)
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .order('arena_score', { ascending: false, nullsFirst: false })
      .limit(500)

    if (error) {
      logger.error(`[ExchangeRanking] Error fetching ${exchange}:`, error)
      return []
    }

    // Map to TraderData shape — use handle as trader_key for correct routing to /trader/[handle]
    return (data || []).map((row: Record<string, unknown>) => ({
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
    }))
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

  const displayName = EXCHANGE_NAMES[exchange]
  const traders = await fetchExchangeTraders(exchange)
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const typeLabel = sourceType === 'futures' ? '合约' : sourceType === 'spot' ? '现货' : '链上'

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
          {displayName} {typeLabel}交易员排行榜
        </h1>
        <p
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.secondary,
            marginBottom: tokens.spacing[6],
          }}
        >
          共 {traders.length} 名交易员 | 按 Arena Score 排序 | 90 天数据窗口
        </p>

        <ExchangeRankingClient traders={traders} exchange={exchange} />
      </div>
      <MobileBottomNav />
    </Box>
  )
}
