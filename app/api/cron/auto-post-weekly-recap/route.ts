/**
 * Cron: Auto-post weekly recap (P5 社区内容厚度, 2026-07-10)
 * Schedule: 0 9 * * 1 (Mondays 09:00 UTC) — see vercel.json
 *
 * 精简版周报(不复活被删的 1192 行 auto-post-insights):仅在已封存的
 * 7D 公开 cohort 完整可验证时发布 Top 5；与日报同一 system user、同一
 * 防重模式(本周已发即跳过)。
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'
import { withCron } from '@/lib/api/with-cron'
import { platformLabel } from '@/lib/constants/platform-labels'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
const SYSTEM_HANDLE = 'arena_bot'
const PUBLIC_RANKED_LEADERBOARD = 'public_ranked_leaderboard' as const
const PUBLIC_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,roi,pnl,arena_score,rank,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at,trader_type'

// This public post has no non-ranking body. Its input must therefore be the
// sealed public cohort; if that cohort cannot be proven, skip the post.
interface WeeklyLeader {
  handle: string | null
  source: string
  source_trader_id: string
  roi: number
  pnl: number
  trader_type: string | null
  is_outlier: boolean | null
}

function fmtRoi(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

const handler = withCron('auto-post-weekly-recap', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()

  // 防重:本周(周一起算)已发过即跳过
  const now = new Date()
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7))
  const mondayIso = monday.toISOString().split('T')[0]
  const { data: existing } = await supabase
    .from('posts')
    .select('id')
    .eq('author_id', SYSTEM_USER_ID)
    .ilike('title', 'Weekly Top 5%')
    .gte('created_at', `${mondayIso}T00:00:00Z`)
    .limit(1)
    .maybeSingle()
  if (existing) return { count: 0, skipped: true, reason: 'already posted this week' }

  const { data, error } = await supabase
    .from(PUBLIC_RANKED_LEADERBOARD as never)
    .select(PUBLIC_RANKING_COLUMNS)
    .eq('season_id', '7D')
    .gte('pnl', 500)
    .gt('roi', 0)
    .lt('roi', 9999) // ROI clamp 哨兵饱和值(±10000)以下才可信
    .order('roi', { ascending: false })
    .limit(40)
  if (error) {
    return { count: 0, skipped: true, reason: 'public ranking cohort unavailable' }
  }

  const raw = verifiedWeeklyLeaders(data ?? [])
  if (raw.length === 0) {
    return { count: 0, skipped: true, reason: 'public ranking cohort unavailable' }
  }

  // The sealed reader already proves public eligibility. These editorial rules
  // only keep the recap diverse and avoid obvious clamp-shaped copy.
  const perSource = new Map<string, number>()
  const leaders: WeeklyLeader[] = []
  for (const l of raw) {
    if (l.trader_type === 'bot' || l.is_outlier === true) continue
    if (Math.abs(Number(l.roi) - Number(l.pnl)) < 0.01) continue
    const n = perSource.get(l.source) ?? 0
    if (n >= 2) continue
    perSource.set(l.source, n + 1)
    leaders.push(l)
    if (leaders.length === 5) break
  }
  if (leaders.length < 3) {
    return { count: 0, skipped: true, reason: `only ${leaders.length} credible leaders` }
  }

  const lines = leaders
    .map((l, i) => {
      const label = platformLabel(l.source)
      // 匿名交易员显示「交易所 · id前缀」(web3=钱包前缀,CEX=uid hash 前缀,
      // 与 binance 官方榜的匿名显示同风格)
      const display = l.handle
        ? `**${l.handle}** (${label})`
        : `**${label} · ${l.source_trader_id.slice(0, 8)}…**`
      const medal = ['🥇', '🥈', '🥉', '4.', '5.'][i]
      return `${medal} ${display} — ROI ${fmtRoi(l.roi)} · PnL $${Math.round(Number(l.pnl)).toLocaleString('en-US')}`
    })
    .join('\n')

  const weekLabel = mondayIso
  const title = `Weekly Top 5 — this week's best performers (week of ${weekLabel})`
  const content = [
    `🏆 **This week's top performers by 7D ROI / 本周收益榜 Top 5**`,
    '',
    lines,
    '',
    `Full leaderboard with Arena Scores, risk metrics and charts → ${BASE_URL}/rankings`,
  ].join('\n')

  const { data: post, error: insertError } = await supabase
    .from('posts')
    .insert({
      title,
      content,
      author_id: SYSTEM_USER_ID,
      author_handle: SYSTEM_HANDLE,
      author_avatar_url: `${BASE_URL}/logo-symbol.png`,
      poll_enabled: false,
      hot_score: 50,
    })
    .select('id')
    .single()
  if (insertError) throw new Error(`Failed to insert post: ${insertError.message}`)

  return { count: 1, postId: post.id }
})

export const GET = handler

function verifiedWeeklyLeaders(rows: unknown[]): WeeklyLeader[] {
  const sanitized = sanitizePublicRankingPayload(
    { traders: rows, period: '7D' },
    { expectedPeriod: '7D' }
  ) as { traders?: unknown[]; ranking_visibility?: unknown }

  if (
    sanitized.ranking_visibility === 'partial' ||
    sanitized.ranking_visibility === 'unknown' ||
    sanitized.ranking_visibility === 'error' ||
    !Array.isArray(sanitized.traders) ||
    sanitized.traders.length === 0
  ) {
    return []
  }

  const leaders: WeeklyLeader[] = []
  for (const row of sanitized.traders) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return []
    const record = row as Record<string, unknown>
    if (
      typeof record.source !== 'string' ||
      typeof record.source_trader_id !== 'string' ||
      typeof record.roi !== 'number' ||
      !Number.isFinite(record.roi) ||
      typeof record.pnl !== 'number' ||
      !Number.isFinite(record.pnl) ||
      (record.handle !== null && typeof record.handle !== 'string') ||
      (record.trader_type !== null && typeof record.trader_type !== 'string') ||
      (record.is_outlier !== null && typeof record.is_outlier !== 'boolean')
    ) {
      return []
    }
    leaders.push({
      handle: record.handle,
      source: record.source,
      source_trader_id: record.source_trader_id,
      roi: record.roi,
      pnl: record.pnl,
      trader_type: record.trader_type,
      is_outlier: record.is_outlier,
    })
  }
  return leaders
}
