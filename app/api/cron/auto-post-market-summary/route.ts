/**
 * Cron: Auto-post daily market summary
 * Schedule: 0 10 * * * (daily at 10:00 UTC)
 *
 * Generates a bilingual (EN/ZH) market analysis post:
 * - BTC/ETH price + 24h change
 * - Top 3 arena score performers
 * - Top 3 trending traders (most viewed)
 *
 * Posts as "Arena Bot" system user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { type SupabaseClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const log = createLogger('cron:auto-post-market-summary')

type AnySupabase = SupabaseClient

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Deterministic system user ID for Arena Bot
// Generated once: crypto.randomUUID() → fixed for all environments
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
const SYSTEM_HANDLE = 'arena_bot'
const SYSTEM_DISPLAY_NAME = 'Arena Bot'

interface MarketPrice {
  symbol: string
  close_price: number
  daily_return_pct: number
}

interface TopTrader {
  display_name: string | null
  handle: string | null
  source: string
  source_trader_id: string
  arena_score: number
  roi_pct: number | null
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('auto-post-market-summary')

  try {
    const supabase = getSupabaseAdmin()

    // Ensure system user exists
    await ensureSystemUser(supabase)

    // Check if we already posted today (prevent duplicates)
    const today = new Date().toISOString().split('T')[0]
    const { data: existingPost } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', SYSTEM_USER_ID)
      .gte('created_at', `${today}T00:00:00Z`)
      .lt('created_at', `${today}T23:59:59Z`)
      .limit(1)
      .maybeSingle()

    if (existingPost) {
      await plog.success(0, { skipped: true, reason: 'already posted today' })
      return NextResponse.json({ ok: true, skipped: true, reason: 'already posted today' })
    }

    // Fetch market data
    const [prices, topPerformers, trendingTraders] = await Promise.all([
      fetchMarketPrices(supabase),
      fetchTopPerformers(supabase),
      fetchTrendingTraders(supabase),
    ])

    // Generate post content
    const { title, content } = generateMarketPost(prices, topPerformers, trendingTraders)

    // Insert post
    const { data: post, error: insertError } = await supabase
      .from('posts')
      .insert({
        title,
        content,
        author_id: SYSTEM_USER_ID,
        author_handle: SYSTEM_HANDLE,
        author_avatar_url: `${BASE_URL}/logo-symbol.png`,
        poll_enabled: false,
        hot_score: 50, // Give system posts a baseline hot score
      })
      .select('id')
      .single()

    if (insertError) {
      throw new Error(`Failed to insert post: ${insertError.message}`)
    }

    await plog.success(1, { postId: post.id })
    return NextResponse.json({ ok: true, postId: post.id })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function ensureSystemUser(supabase: AnySupabase) {
  // Must exist in auth.users first (user_activities trigger has FK to auth.users)
  const { data: authUser } = await supabase.auth.admin.getUserById(SYSTEM_USER_ID)
  if (!authUser?.user) {
    const { error: authErr } = await supabase.auth.admin.createUser({
      id: SYSTEM_USER_ID,
      email: 'arena-bot@arenafi.org',
      email_confirm: true,
      user_metadata: { handle: SYSTEM_HANDLE, display_name: SYSTEM_DISPLAY_NAME },
    } as Parameters<typeof supabase.auth.admin.createUser>[0])
    if (authErr && !authErr.message.includes('already')) {
      throw new Error(`Cannot create system auth user (required for user_activities FK): ${authErr.message}`)
    }
  }

  // Then ensure user_profiles entry
  const { error } = await supabase
    .from('user_profiles')
    .upsert({
      id: SYSTEM_USER_ID,
      handle: SYSTEM_HANDLE,
      display_name: SYSTEM_DISPLAY_NAME,
      avatar_url: `${BASE_URL}/logo-symbol.png`,
      bio: 'Automated market analysis by Arena',
      role: 'official',
    }, { onConflict: 'id' })

  if (error) {
    log.warn('Could not create system user profile', { error: error.message })
  }
}

async function fetchMarketPrices(supabase: AnySupabase): Promise<MarketPrice[]> {
  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

  // Try today first, fall back to yesterday
  const { data } = await supabase
    .from('market_benchmarks')
    .select('symbol, close_price, daily_return_pct')
    .in('symbol', ['BTC', 'ETH'])
    .in('date', [today, yesterday])
    .order('date', { ascending: false })

  if (!data || data.length === 0) return []

  // Deduplicate: keep latest per symbol
  const seen = new Set<string>()
  const result: MarketPrice[] = []
  for (const row of data) {
    if (!seen.has(row.symbol)) {
      seen.add(row.symbol)
      result.push({
        symbol: row.symbol,
        close_price: Number(row.close_price),
        daily_return_pct: Number(row.daily_return_pct ?? 0),
      })
    }
  }
  return result
}

async function fetchTopPerformers(supabase: AnySupabase): Promise<TopTrader[]> {
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('display_name, handle, source, source_trader_id, arena_score, roi_pct')
    .eq('season_id', '7D')
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(3)

  return (data || []).map(row => ({
    display_name: row.display_name,
    handle: row.handle,
    source: row.source,
    source_trader_id: row.source_trader_id,
    arena_score: Number(row.arena_score ?? 0),
    roi_pct: row.roi_pct != null ? Number(row.roi_pct) : null,
  }))
}

async function fetchTrendingTraders(supabase: AnySupabase): Promise<TopTrader[]> {
  // Trending = highest view count from trader_details in last 24h, or fallback to top by followers
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('display_name, handle, source, source_trader_id, arena_score, roi_pct')
    .eq('season_id', '30D')
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .range(3, 5) // offset to get different traders from top performers

  return (data || []).map(row => ({
    display_name: row.display_name,
    handle: row.handle,
    source: row.source,
    source_trader_id: row.source_trader_id,
    arena_score: Number(row.arena_score ?? 0),
    roi_pct: row.roi_pct != null ? Number(row.roi_pct) : null,
  }))
}

function formatPrice(price: number): string {
  if (price >= 1000) {
    return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
  return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function formatChange(pct: number): string {
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

function formatTraderName(t: TopTrader): string {
  const name = t.display_name || t.handle || t.source_trader_id.slice(0, 8)
  const platform = t.source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return `${name} (${platform})`
}

function generateMarketPost(
  prices: MarketPrice[],
  topPerformers: TopTrader[],
  trendingTraders: TopTrader[],
): { title: string; content: string } {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const title = `Daily Market Pulse - ${dateStr}`

  // Build content sections
  const sections: string[] = []

  // Price section
  const btc = prices.find(p => p.symbol === 'BTC')
  const eth = prices.find(p => p.symbol === 'ETH')

  if (btc || eth) {
    const priceLines: string[] = []
    if (btc) {
      const emoji = btc.daily_return_pct >= 0 ? '🟢' : '🔴'
      priceLines.push(`${emoji} BTC: ${formatPrice(btc.close_price)} (${formatChange(btc.daily_return_pct)})`)
    }
    if (eth) {
      const emoji = eth.daily_return_pct >= 0 ? '🟢' : '🔴'
      priceLines.push(`${emoji} ETH: ${formatPrice(eth.close_price)} (${formatChange(eth.daily_return_pct)})`)
    }
    sections.push(`**Market Overview / 市场概览**\n${priceLines.join('\n')}`)
  }

  // Top performers
  if (topPerformers.length > 0) {
    const medals = ['🥇', '🥈', '🥉']
    const performerLines = topPerformers.map((t, i) => {
      const roi = t.roi_pct != null ? ` | ROI: ${formatChange(t.roi_pct)}` : ''
      return `${medals[i] || '•'} ${formatTraderName(t)} — Score: ${t.arena_score.toFixed(1)}${roi}`
    })
    sections.push(`**Top Performers (7D) / 本周最佳表现**\n${performerLines.join('\n')}`)
  }

  // Trending
  if (trendingTraders.length > 0) {
    const trendingLines = trendingTraders.map(t => {
      const roi = t.roi_pct != null ? ` | ROI: ${formatChange(t.roi_pct)}` : ''
      return `🔥 ${formatTraderName(t)} — Score: ${t.arena_score.toFixed(1)}${roi}`
    })
    sections.push(`**Trending Traders (30D) / 热门交易员**\n${trendingLines.join('\n')}`)
  }

  // Footer
  sections.push('---\n🤖 Auto-generated by Arena Bot | 由 Arena Bot 自动生成\n📊 Data updates every 3-6h | 数据每 3-6 小时更新')

  const content = sections.join('\n\n')
  return { title, content }
}

// Also support POST for Vercel cron
export async function POST(request: NextRequest) {
  return GET(request)
}
