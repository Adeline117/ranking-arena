import type { Metadata } from 'next'
import { redirect, notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { findTraderSource, TRADER_SOURCES, type SourceType } from '@/app/api/traders/[handle]/trader-queries'
import type { TraderSource } from '@/app/api/traders/[handle]/trader-types'
import { getTraderDetails, getTraderDetailsFromSnapshots } from '@/app/api/traders/[handle]/trader-transforms'

// Derive display names from central config
const EXCHANGE_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.name])
)

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)
  const BASE = 'https://www.arenafi.org'

  try {
    const supabase = getSupabaseAdmin()
    const { data: ts } = await supabase
      .from('trader_sources')
      .select('handle, source, source_trader_id, avatar_url')
      .ilike('handle', decoded)
      .limit(1)
      .maybeSingle()

    if (ts) {
      const { data: lr } = await supabase
        .from('leaderboard_ranks')
        .select('rank, arena_score, roi, pnl')
        .eq('source', ts.source)
        .eq('source_trader_id', ts.source_trader_id)
        .maybeSingle()

      const name = ts.handle || decoded
      const exchange = EXCHANGE_DISPLAY[ts.source] || ts.source || 'Crypto'
      const roi = lr?.roi
      const score = lr?.arena_score
      const rank = lr?.rank

      const parts = [
        roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null,
        score != null ? `Arena Score ${score.toFixed(0)}` : null,
        rank != null ? `#${rank} ranked` : null,
      ].filter(Boolean)

      const title = `${name} (${exchange}) | Crypto Trader Rankings — Arena`
      const description = parts.length
        ? `${name} is a ${exchange} trader with ${parts.join(', ')}. Track their performance history on Arena.`
        : `${name} is a ${exchange} crypto trader. View performance analytics and rankings on Arena.`

      const ogParams = new URLSearchParams({ handle: decoded })
      if (roi != null) ogParams.set('roi', roi.toFixed(2))
      if (score != null) ogParams.set('score', score.toFixed(0))
      if (rank != null) ogParams.set('rank', String(rank))
      if (ts.source) ogParams.set('source', ts.source)
      const ogImageUrl = `${BASE}/api/og/trader?${ogParams.toString()}`

      return {
        title,
        description,
        openGraph: {
          title,
          description,
          url: `${BASE}/trader/${encodeURIComponent(decoded)}`,
          siteName: 'Arena',
          type: 'profile',
          images: [{ url: ogImageUrl, width: 1200, height: 630, alt: `${name} trading performance card` }],
        },
        twitter: { card: 'summary_large_image', title, description, images: [ogImageUrl] },
        alternates: { canonical: `${BASE}/trader/${encodeURIComponent(decoded)}` },
      }
    }
  } catch { /* fall through */ }

  // Fallback — no DB data
  const fallbackOgImage = `${BASE}/api/og/trader?handle=${encodeURIComponent(decoded)}`
  return {
    title: `${decoded} | Crypto Trader — Arena`,
    description: `View ${decoded}'s crypto trading performance, PnL, and rank on Arena among 32,000+ traders.`,
    openGraph: {
      title: `${decoded} | Crypto Trader — Arena`,
      description: `View ${decoded}'s crypto trading performance on Arena.`,
      url: `${BASE}/trader/${encodeURIComponent(decoded)}`,
      siteName: 'Arena',
      type: 'profile',
      images: [{ url: fallbackOgImage, width: 1200, height: 630 }],
    },
    twitter: { card: 'summary_large_image', title: `${decoded} | Crypto Trader — Arena`, images: [fallbackOgImage] },
    alternates: { canonical: `${BASE}/trader/${encodeURIComponent(decoded)}` },
  }
}

// Allow non-pre-rendered trader pages to be dynamically generated at runtime
export const dynamicParams = true

// ISR: regenerate trader pages every 5 minutes
// Sidebar widgets are client components using SWR (no server-side Redis dependency)
export const revalidate = 300

// Find the user profile associated with this trader handle
// Uses chained query: traders -> trader_authorizations -> user_profiles
async function findUserProfileByTraderHandle(traderHandle: string): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin()
    
    // Single query: find trader, then get active authorization with user profile
    const { data: trader } = await supabase
      .from('traders')
      .select('id, trader_authorizations!inner(user_id, user_profiles:user_id(handle))')
      .eq('handle', traderHandle)
      .eq('trader_authorizations.status', 'active')
      .maybeSingle()
    
    if (!trader) return null
    
    const auths = trader.trader_authorizations as unknown as Array<{ user_id: string; user_profiles: { handle: string | null } | null }>
    return auths?.[0]?.user_profiles?.handle || null
  } catch {
    // Fallback to serial queries if join fails (table relationship may not exist)
    try {
      const supabase = getSupabaseAdmin()
      
      const { data: traderData } = await supabase
        .from('traders')
        .select('id')
        .eq('handle', traderHandle)
        .maybeSingle()
      
      if (!traderData?.id) return null
      
      const { data: auth } = await supabase
        .from('trader_authorizations')
        .select('user_id')
        .eq('trader_id', traderData.id)
        .eq('status', 'active')
        .maybeSingle()
      
      if (!auth?.user_id) return null
      
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', auth.user_id)
        .maybeSingle()
      
      return profile?.handle || null
    } catch {
      return null
    }
  }
}

// Fetch unregistered trader data from trader_sources + leaderboard_ranks
async function fetchUnregisteredTrader(handle: string): Promise<UnregisteredTraderData | null> {
  try {
    const supabase = getSupabaseAdmin()
    
    // Find trader_sources by handle (case-insensitive)
    let { data: traderSource } = await supabase
      .from('trader_sources')
      .select('handle, avatar_url, source, source_trader_id')
      .ilike('handle', handle)
      .limit(1)
      .maybeSingle()
    
    if (!traderSource) {
      // Fallback: try matching by source_trader_id (full address)
      const { data: fallbackSource } = await supabase
        .from('trader_sources')
        .select('handle, avatar_url, source, source_trader_id')
        .eq('source_trader_id', handle)
        .limit(1)
        .maybeSingle()
      
      if (!fallbackSource) return null
      traderSource = fallbackSource
    }
    
    // Get leaderboard_ranks data
    const { data: rankData } = await supabase
      .from('leaderboard_ranks')
      .select('rank, arena_score, roi, pnl, win_rate, max_drawdown, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trading_style, avg_holding_hours, profitability_score, risk_control_score, execution_score')
      .eq('source', traderSource.source)
      .eq('source_trader_id', traderSource.source_trader_id)
      .maybeSingle()
    
    // Fallback to trader_snapshots if leaderboard_ranks has no data
    let snapshotData: Record<string, unknown> | null = null
    if (!rankData) {
      const { data: snapshot } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, profitability_score, risk_control_score, execution_score')
        .eq('source', traderSource.source)
        .eq('source_trader_id', traderSource.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (snapshot) {
        snapshotData = {
          roi: snapshot.roi,
          pnl: snapshot.pnl,
          win_rate: snapshot.win_rate != null ? (snapshot.win_rate <= 1 ? snapshot.win_rate * 100 : snapshot.win_rate) : null,
          max_drawdown: snapshot.max_drawdown,
          arena_score: snapshot.arena_score,
          profitability_score: snapshot.profitability_score,
          risk_control_score: snapshot.risk_control_score,
          execution_score: snapshot.execution_score,
        }
      }
    }
    
    return {
      handle: traderSource.handle || handle,
      avatar_url: traderSource.avatar_url,
      source: traderSource.source,
      source_trader_id: traderSource.source_trader_id,
      ...(rankData || snapshotData || {}),
    }
  } catch {
    return null
  }
}

export default async function TraderPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // keep original if decode fails
  }

  // 并行查询注册用户和未注册交易员数据，避免瀑布式加载
  const [userHandle, traderData] = await Promise.all([
    findUserProfileByTraderHandle(decodedHandle),
    fetchUnregisteredTrader(decodedHandle),
  ])

  // 1. 优先跳转到注册用户页面
  if (userHandle) {
    redirect(`/u/${encodeURIComponent(userHandle)}`)
  }

  // 2. 展示未注册交易员数据
  if (traderData) {
    // Fetch full trader data INLINE (no HTTP call — avoids Cloudflare 524 timeout)
    let serverTraderData = null
    try {
      const sb = getSupabaseAdmin()
      // Find trader source
      let found: { source: TraderSource; sourceType: SourceType } | null = null
      if (traderData.source && TRADER_SOURCES.includes(traderData.source as SourceType)) {
        const { data: byId } = await sb
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url, avatar_url, market_type')
          .eq('source', traderData.source)
          .eq('source_trader_id', traderData.source_trader_id)
          .limit(1)
          .maybeSingle()
        if (byId) {
          found = { source: byId as TraderSource, sourceType: traderData.source as SourceType }
        }
      }
      if (!found) {
        found = await findTraderSource(sb, traderData.source_trader_id || traderData.handle)
      }
      if (found) {
        try {
          serverTraderData = await getTraderDetails(sb, found.source, found.sourceType)
        } catch {
          serverTraderData = await getTraderDetailsFromSnapshots(sb, found.source.source_trader_id, found.sourceType)
        }
      }
    } catch {
      // Inline fetch failed — client will retry via SWR
    }

    // JSON-LD structured data for this trader
    const exchange = EXCHANGE_DISPLAY[traderData.source || ''] || traderData.source || 'Crypto Exchange'
    const roi = traderData.roi ?? null
    const score = traderData.arena_score ?? null
    const rank = traderData.rank ?? null
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: traderData.handle,
      url: `https://www.arenafi.org/trader/${encodeURIComponent(traderData.handle)}`,
      ...(traderData.avatar_url ? { image: traderData.avatar_url } : {}),
      description: [
        `${exchange} crypto trader`,
        roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null,
        score != null ? `Arena Score ${score.toFixed(0)}` : null,
        rank != null ? `Ranked #${rank} on Arena` : null,
      ].filter(Boolean).join('. '),
      memberOf: {
        '@type': 'Organization',
        name: exchange,
      },
      sameAs: [`https://www.arenafi.org/trader/${encodeURIComponent(traderData.handle)}`],
    }

    return (
      <>
        <JsonLd data={jsonLd} />
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <TraderProfileClient data={traderData} serverTraderData={serverTraderData as any} />
      </>
    )
  }

  // 3. Not found
  notFound()
}
