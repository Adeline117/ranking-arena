import type { Metadata } from 'next'
import { redirect, notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG, type SourceType, type TraderSource, ALL_SOURCES } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'

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
        ? `${name} is a ${exchange} trader with ${parts.join(', ')}. Track their performance history, detailed analytics, and ranking movements on Arena among 32,000+ crypto traders.`
        : `${name} is a ${exchange} crypto trader. View comprehensive performance analytics, trading history, risk metrics, and rankings on Arena among 32,000+ crypto traders from 30+ exchanges.`

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
        twitter: { 
          card: 'summary_large_image', 
          title, 
          description: description.length > 160 ? description.substring(0, 157) + '...' : description, 
          images: [ogImageUrl],
          creator: '@arenafi',
        },
        alternates: { canonical: `${BASE}/trader/${encodeURIComponent(decoded)}` },
      }
    }
  } catch { /* fall through */ }

  // Fallback — no DB data
  const fallbackOgImage = `${BASE}/api/og/trader?handle=${encodeURIComponent(decoded)}`
  return {
    title: `${decoded} | Crypto Trader Performance & Rankings — Arena`,
    description: `View ${decoded}'s comprehensive crypto trading performance, PnL, ROI, win rate, and rank on Arena among 32,000+ traders from 30+ exchanges. Real-time analytics and historical data.`,
    openGraph: {
      title: `${decoded} | Crypto Trader — Arena`,
      description: `View ${decoded}'s crypto trading performance, analytics, and rank on Arena among 32,000+ traders from 30+ exchanges.`,
      url: `${BASE}/trader/${encodeURIComponent(decoded)}`,
      siteName: 'Arena',
      type: 'profile',
      images: [{ url: fallbackOgImage, width: 1200, height: 630 }],
    },
    twitter: { 
      card: 'summary_large_image', 
      title: `${decoded} | Crypto Trader — Arena`, 
      description: `View ${decoded}'s trading performance and rank on Arena.`,
      images: [fallbackOgImage],
      creator: '@arenafi',
    },
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
async function fetchUnregisteredTrader(handle: string, platform?: string): Promise<UnregisteredTraderData | null> {
  try {
    const supabase = getSupabaseAdmin()

    // Find trader_sources by handle (case-insensitive)
    let traderSourceQuery = supabase
      .from('trader_sources')
      .select('handle, avatar_url, source, source_trader_id')
      .ilike('handle', handle)
      .limit(1)
    if (platform) traderSourceQuery = traderSourceQuery.eq('source', platform)
    let { data: traderSource } = await traderSourceQuery.maybeSingle()

    if (!traderSource) {
      // Fallback: try matching by source_trader_id (full address)
      let fallbackQuery = supabase
        .from('trader_sources')
        .select('handle, avatar_url, source, source_trader_id')
        .eq('source_trader_id', handle)
        .limit(1)
      if (platform) fallbackQuery = fallbackQuery.eq('source', platform)
      const { data: fallbackSource } = await fallbackQuery.maybeSingle()

      if (fallbackSource) {
        traderSource = fallbackSource
      }
    }

    // Fallback: if trader_sources has no entry but platform is known,
    // try leaderboard_ranks directly (handles platforms like etoro/bitunix/drift
    // that may not have trader_sources entries)
    if (!traderSource && platform) {
      const { data: directRank } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, rank, arena_score, roi, pnl, win_rate, max_drawdown, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trading_style, avg_holding_hours, profitability_score, risk_control_score, execution_score, avatar_url')
        .eq('source', platform)
        .eq('source_trader_id', handle)
        .order('arena_score', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (directRank) {
        // Also check trader_profiles_v2 for avatar/display info
        const { data: profile } = await supabase
          .from('trader_profiles_v2')
          .select('display_name, avatar_url')
          .eq('platform', platform)
          .eq('trader_key', handle)
          .limit(1)
          .maybeSingle()

        return {
          handle: handle, // Keep URL handle to prevent redirect (display_name differs from source_trader_id)
          avatar_url: directRank.avatar_url || profile?.avatar_url || null,
          source: platform,
          source_trader_id: handle,
          rank: directRank.rank,
          arena_score: directRank.arena_score,
          roi: directRank.roi,
          pnl: directRank.pnl,
          win_rate: directRank.win_rate,
          max_drawdown: directRank.max_drawdown,
          sharpe_ratio: directRank.sharpe_ratio,
          sortino_ratio: directRank.sortino_ratio,
          profit_factor: directRank.profit_factor,
          calmar_ratio: directRank.calmar_ratio,
          trading_style: directRank.trading_style,
          avg_holding_hours: directRank.avg_holding_hours,
          profitability_score: directRank.profitability_score,
          risk_control_score: directRank.risk_control_score,
          execution_score: directRank.execution_score,
        }
      }

      // Last resort: check trader_snapshots_v2 directly
      const { data: v2Snap } = await supabase
        .from('trader_snapshots_v2')
        .select('trader_key, roi_pct, pnl_usd, win_rate, max_drawdown, arena_score')
        .eq('platform', platform)
        .eq('trader_key', handle)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (v2Snap) {
        const { data: profile } = await supabase
          .from('trader_profiles_v2')
          .select('display_name, avatar_url')
          .eq('platform', platform)
          .eq('trader_key', handle)
          .limit(1)
          .maybeSingle()

        return {
          handle: handle, // Keep URL handle to prevent redirect
          avatar_url: profile?.avatar_url || null,
          source: platform,
          source_trader_id: handle,
          roi: v2Snap.roi_pct,
          pnl: v2Snap.pnl_usd,
          win_rate: v2Snap.win_rate,
          max_drawdown: v2Snap.max_drawdown,
          arena_score: v2Snap.arena_score,
        }
      }

      return null
    }

    if (!traderSource) return null

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

export default async function TraderPage({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<{ platform?: string }> }) {
  const { handle } = await params
  const { platform } = await searchParams

  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // keep original if decode fails
  }

  const sb = getSupabaseAdmin()

  // 并行查询注册用户和解析交易员身份
  const [userHandle, resolved] = await Promise.all([
    findUserProfileByTraderHandle(decodedHandle),
    resolveTrader(sb, { handle: decodedHandle, platform }),
  ])

  // 1. 优先跳转到注册用户页面
  if (userHandle) {
    redirect(`/u/${encodeURIComponent(userHandle)}`)
  }

  // 2. 如果未找到交易员
  if (!resolved) {
    notFound()
  }

  // Redirect raw address URLs to human-readable handle URLs (better SEO)
  if (resolved.handle && resolved.handle !== decodedHandle) {
    const platformParam = `?platform=${resolved.platform}`
    redirect(`/trader/${encodeURIComponent(resolved.handle)}${platformParam}`)
  }

  // 3. 获取完整交易员数据（通过统一数据层 — 自动处理 v1/v2/leaderboard fallback）
  let serverTraderData = null
  try {
    const detail = await getTraderDetail(sb, {
      platform: resolved.platform,
      traderKey: resolved.traderKey,
    })
    if (detail) {
      serverTraderData = toTraderPageData(detail)
    }
  } catch {
    // Inline fetch failed — client will retry via SWR
  }

  // Build UnregisteredTraderData for initial render
  const traderData: UnregisteredTraderData = {
    handle: resolved.handle || decodedHandle,
    avatar_url: resolved.avatarUrl,
    source: resolved.platform,
    source_trader_id: resolved.traderKey,
    // Pull basic scores from serverTraderData if available
    ...(serverTraderData?.performance ? {
      arena_score: (serverTraderData.performance as Record<string, unknown>).arena_score as number | null,
      roi: (serverTraderData.performance as Record<string, unknown>).roi_90d as number | null,
      pnl: (serverTraderData.performance as Record<string, unknown>).pnl as number | null,
      win_rate: (serverTraderData.performance as Record<string, unknown>).win_rate as number | null,
      max_drawdown: (serverTraderData.performance as Record<string, unknown>).max_drawdown as number | null,
      rank: (serverTraderData.performance as Record<string, unknown>).rank as number | null,
      profitability_score: (serverTraderData.performance as Record<string, unknown>).profitability_score as number | null,
      risk_control_score: (serverTraderData.performance as Record<string, unknown>).risk_control_score as number | null,
      execution_score: (serverTraderData.performance as Record<string, unknown>).execution_score as number | null,
    } : {}),
  }

  // JSON-LD structured data
  const exchange = EXCHANGE_DISPLAY[resolved.platform] || resolved.platform || 'Crypto Exchange'
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
    memberOf: { '@type': 'Organization', name: exchange },
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
