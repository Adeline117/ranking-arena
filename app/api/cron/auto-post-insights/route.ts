/**
 * Cron: Auto-post daily data insights
 * Schedule: 0 8 * * * (daily at 08:00 UTC)
 *
 * Generates varied data-driven posts from real leaderboard data.
 * Rotates between 5 types to keep content fresh.
 * Posts as Arena Bot system user.
 */

import { NextRequest, NextResponse } from 'next/server'
import { type SupabaseClient } from '@supabase/supabase-js'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'

type AnySupabase = SupabaseClient

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
const SYSTEM_HANDLE = 'arena_bot'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('auto-post-insights')

  try {
    const supabase = getSupabaseAdmin()

    // Ensure system user exists in auth.users (user_activities trigger has FK constraint)
    await ensureSystemUser(supabase)

    // Check if already posted today
    const today = new Date().toISOString().split('T')[0]
    const { data: existing } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', SYSTEM_USER_ID)
      .eq('author_handle', SYSTEM_HANDLE)
      .gte('created_at', `${today}T00:00:00Z`)
      .lt('created_at', `${today}T23:59:59Z`)
      .limit(2)

    // Allow max 2 auto-posts per day (insights + market summary)
    if ((existing?.length || 0) >= 2) {
      await plog.success(0, { skipped: true, reason: 'already posted twice today' })
      return NextResponse.json({ ok: true, skipped: true })
    }

    // Rotate post types based on day of week
    const dayOfWeek = new Date().getUTCDay() // 0=Sun, 1=Mon... (UTC for server consistency)
    const generators = [
      generateWeeklyRecap,     // 0: Sun
      generateRankChanges,     // 1: Mon
      generateExchangeCompare, // 2: Tue
      generateRankChanges,     // 3: Wed
      generateDataFact,        // 4: Thu
      generateRankChanges,     // 5: Fri
      generateDataFact,        // 6: Sat
    ]

    const generator = generators[dayOfWeek]
    const { title, content } = await generator(supabase)

    if (!content) {
      await plog.success(0, { skipped: true, reason: 'no data for post' })
      return NextResponse.json({ ok: true, skipped: true, reason: 'no data' })
    }

    const { data: post, error: insertError } = await supabase
      .from('posts')
      .insert({
        title,
        content,
        author_id: SYSTEM_USER_ID,
        author_handle: SYSTEM_HANDLE,
        author_avatar_url: `${BASE_URL}/logo-symbol.png`,
        poll_enabled: false,
        hot_score: 40,
      })
      .select('id')
      .single()

    if (insertError) throw new Error(`Insert failed: ${insertError.message}`)

    await plog.success(1, { postId: post.id, type: generator.name })
    return NextResponse.json({ ok: true, postId: post.id, type: generator.name })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ─── Helpers ───

async function ensureSystemUser(supabase: AnySupabase) {
  const { data: authUser } = await supabase.auth.admin.getUserById(SYSTEM_USER_ID)
  if (!authUser?.user) {
    const { error: authErr } = await supabase.auth.admin.createUser({
      id: SYSTEM_USER_ID,
      email: 'arena-bot@arenafi.org',
      email_confirm: true,
      user_metadata: { handle: SYSTEM_HANDLE },
    } as Parameters<typeof supabase.auth.admin.createUser>[0])
    if (authErr && !authErr.message.includes('already')) {
      throw new Error(`Cannot create system auth user (required for user_activities FK): ${authErr.message}`)
    }
  }

  await supabase.from('user_profiles').upsert({
    id: SYSTEM_USER_ID,
    handle: SYSTEM_HANDLE,
    display_name: 'Arena Bot',
    avatar_url: `${BASE_URL}/logo-symbol.png`,
    bio: 'Automated insights by Arena',
    role: 'official',
  }, { onConflict: 'id' })
}

// ─── Post Generators ───

async function generateRankChanges(supabase: AnySupabase): Promise<{ title: string; content: string }> {
  // Find traders with highest arena_score in 7D (recent movers)
  const { data: top7d } = await supabase
    .from('leaderboard_ranks')
    .select('handle, source, source_trader_id, arena_score, roi')
    .eq('season_id', '7D')
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(5)

  if (!top7d?.length) return { title: '', content: '' }

  const lines = top7d.map((t, i) => {
    const name = t.handle || t.source_trader_id?.slice(0, 10)
    const platform = formatPlatform(t.source)
    const roi = t.roi != null ? ` | ROI: ${t.roi >= 0 ? '+' : ''}${Number(t.roi).toFixed(1)}%` : ''
    return `${i + 1}. **${name}** (${platform}) — Score: ${Number(t.arena_score).toFixed(1)}${roi}`
  })

  const topName = top7d[0].handle || top7d[0].source_trader_id?.slice(0, 8)
  const topRoi = top7d[0].roi != null ? `+${Number(top7d[0].roi).toFixed(0)}%` : ''
  const title = `${topName} leads with ${topRoi} ROI — This Week's Top 5`
  const content = `🔥 **This week's highest-scoring traders (7D)**\n\n${lines.join('\n')}\n\n_Who will top next week's leaderboard?_`
  return { title, content }
}

async function generateExchangeCompare(supabase: AnySupabase): Promise<{ title: string; content: string }> {
  const exchanges = ['binance_futures', 'hyperliquid', 'bybit', 'okx_futures'] // bitget_futures removed 2026-03-18 (7th stuck)
  const results: { name: string; avgScore: number; count: number; topRoi: number }[] = []

  for (const ex of exchanges) {
    const { data } = await supabase
      .from('leaderboard_ranks')
      .select('arena_score, roi')
      .eq('source', ex)
      .eq('season_id', '30D')
      .not('arena_score', 'is', null)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('arena_score', { ascending: false })
      .limit(20)

    if (data?.length) {
      const avgScore = data.reduce((s, r) => s + Number(r.arena_score), 0) / data.length
      const topRoi = Math.max(...data.map(r => Number(r.roi || 0)))
      results.push({ name: formatPlatform(ex), avgScore, count: data.length, topRoi })
    }
  }

  if (!results.length) return { title: '', content: '' }

  results.sort((a, b) => b.avgScore - a.avgScore)
  const lines = results.map((r, i) => {
    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || '•'
    return `${medal} **${r.name}** — Avg Score: ${r.avgScore.toFixed(1)} | Top ROI: +${r.topRoi.toFixed(0)}%`
  })

  const winner = results[0]
  const title = `${winner.name} dominates with ${winner.avgScore.toFixed(0)} avg score — Exchange Battle`
  const content = `⚔️ **Which exchange has the best traders?**\nAvg Arena Score of top 20 traders per exchange (30D):\n\n${lines.join('\n')}\n\n_Where would you rank?_`
  return { title, content }
}

async function generateDataFact(supabase: AnySupabase): Promise<{ title: string; content: string }> {
  // Count traders by various criteria
  const { count: totalTraders } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('season_id', '30D')

  const { count: score80Plus } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('season_id', '30D')
    .gte('arena_score', 80)

  const { count: score90Plus } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('season_id', '30D')
    .gte('arena_score', 90)

  const total = totalTraders || 0
  const pct80 = total > 0 ? ((score80Plus || 0) / total * 100).toFixed(1) : '0'
  const pct90 = total > 0 ? ((score90Plus || 0) / total * 100).toFixed(1) : '0'

  const facts = [
    `Arena tracks **${total.toLocaleString()}** ranked traders across 27+ exchanges.\n\nOnly **${score80Plus?.toLocaleString()}** have Arena Score above 80 — that's the top ${pct80}%.\n\nJust **${score90Plus?.toLocaleString()}** have Score 90+ (${pct90}%). These are the elite performers.`,
    `What separates a Score 90 trader from a Score 70?\n\nArena Score combines:\n- **Return Score** (60 pts max) — risk-adjusted ROI\n- **Profit Score** (40 pts max) — absolute PnL impact\n\nMultiplied by confidence and trust factors. Higher score = better risk-adjusted, sustained performance.`,
  ]

  const factIndex = new Date().getDate() % facts.length
  const title = 'Arena Data Insights'
  return { title, content: facts[factIndex] + '\n\n---\n📊 Updated daily | 每日更新' }
}

async function generateWeeklyRecap(supabase: AnySupabase): Promise<{ title: string; content: string }> {
  const { data: top1 } = await supabase
    .from('leaderboard_ranks')
    .select('handle, source, source_trader_id, arena_score, roi')
    .eq('season_id', '7D')
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(1)

  const { count: total } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('season_id', '30D')

  const { data: profitable } = await supabase
    .from('leaderboard_ranks')
    .select('roi')
    .eq('season_id', '7D')
    .not('roi', 'is', null)
    .limit(1000)

  const profitableCount = profitable?.filter(r => Number(r.roi) > 0).length || 0
  const totalWithRoi = profitable?.length || 1
  const profitPct = (profitableCount / totalWithRoi * 100).toFixed(0)

  const now = new Date()
  const weekStart = new Date(now.getTime() - 7 * 86400000)
  const dateRange = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  const topName = top1?.[0] ? (top1[0].handle || top1[0].source_trader_id?.slice(0, 10)) : 'N/A'
  const topPlatform = top1?.[0] ? formatPlatform(top1[0].source) : ''
  const topRoi = top1?.[0]?.roi != null ? `+${Number(top1[0].roi).toFixed(0)}%` : 'N/A'
  const topScore = top1?.[0] ? Number(top1[0].arena_score).toFixed(1) : 'N/A'

  const title = `Arena Weekly Recap (${dateRange})`
  const content = [
    `**Top performer:** ${topName} (${topPlatform}) — Score ${topScore}, ROI ${topRoi}`,
    `**Profitable traders:** ${profitPct}% of tracked traders were profitable this week`,
    `**Total ranked:** ${(total || 0).toLocaleString()} traders across 27+ exchanges`,
    '',
    '---',
    '📊 Weekly recap auto-generated from Arena leaderboard data',
  ].join('\n')

  return { title, content }
}

function formatPlatform(source: string): string {
  const map: Record<string, string> = {
    binance_futures: 'Binance', binance_spot: 'Binance Spot', bybit: 'Bybit',
    okx_futures: 'OKX', hyperliquid: 'Hyperliquid', // bitget_futures removed 2026-03-18
    gmx: 'GMX', dydx: 'dYdX', drift: 'Drift', aevo: 'Aevo', gains: 'Gains',
    mexc: 'MEXC', gateio: 'Gate.io', coinex: 'CoinEx', htx_futures: 'HTX',
    etoro: 'eToro', btcc: 'BTCC', bitfinex: 'Bitfinex',
  }
  return map[source] || source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
