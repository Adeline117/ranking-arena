/**
 * Cron: Auto-post weekly recap (P5 社区内容厚度, 2026-07-10)
 * Schedule: 0 9 * * 1 (Mondays 09:00 UTC) — see vercel.json
 *
 * 精简版周报(不复活被删的 1192 行 auto-post-insights):7D 收益榜可信
 * Top 5(leaderboard_ranks 直查 + 可信度过滤)+ 双语。与日报同一
 * system user、同一防重模式(本周已发即跳过)。
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'
import { withCron } from '@/lib/api/with-cron'
import { platformLabel } from '@/lib/constants/platform-labels'

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
const SYSTEM_HANDLE = 'arena_bot'

// 数据源 = public.leaderboard_ranks(7D season,serving 表)直查。
// 曾用 arena_weekly_leaders RPC:形状真点纠偏后又实测 p_limit 15 要 49s
// (statement timeout),且榜首全是 ROI clamp 垃圾——直查 lr 快、可过滤、可信。
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
    .from('leaderboard_ranks')
    .select('handle, source, source_trader_id, roi, pnl, trader_type, is_outlier')
    .eq('season_id', '7D')
    .gte('pnl', 500)
    .gt('roi', 0)
    .lt('roi', 9999) // ROI clamp 哨兵饱和值(±10000)以下才可信
    .order('roi', { ascending: false })
    .limit(40)
  if (error) throw new Error(`leaderboard_ranks query failed: ${error.message}`)
  const raw = (data ?? []) as WeeklyLeader[]

  // 可信度过滤(首次真点 2026-07-10 打脸:榜首全 +10000% clamp + PnL $11 灰尘):
  // 剔除 bot/离群标记、roi==pnl(validate-before-write 的已知垃圾模式);
  // 每源最多 2 个防单一来源刷屏;可信条目不足 3 个宁可跳过不发。
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
