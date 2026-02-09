import { Metadata } from 'next'
import { createClient } from '@supabase/supabase-js'
import { EXCHANGE_NAMES, SOURCES_WITH_DATA, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box } from '@/app/components/base'
import ExchangeRankingClient from './ExchangeRankingClient'
import { logger } from '@/lib/logger'

export const revalidate = 3600 // ISR: 1 hour

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

function getSupabase() {
  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
}

export async function generateStaticParams() {
  return SOURCES_WITH_DATA.map((exchange) => ({ exchange }))
}

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
}

async function fetchExchangeTraders(exchange: string): Promise<TraderData[]> {
  const supabase = getSupabase()
  if (!supabase) return []

  try {
    const { data, error } = await supabase
      .from('trader_snapshots_v2')
      .select('trader_key, display_name, avatar_url, platform, roi, pnl, win_rate, max_drawdown, arena_score, followers')
      .eq('platform', exchange)
      .eq('window', '90d')
      .order('arena_score', { ascending: false, nullsFirst: false })
      .limit(100)

    if (error) {
      logger.error(`[ExchangeRanking] Error fetching ${exchange}:`, error)
      return []
    }
    return data || []
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
  const displayName = EXCHANGE_NAMES[exchange] || exchange
  const traders = await fetchExchangeTraders(exchange)
  const sourceType = SOURCE_TYPE_MAP[exchange] || 'futures'
  const typeLabel = sourceType === 'futures' ? '合约' : sourceType === 'spot' ? '现货' : '链上'

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
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
