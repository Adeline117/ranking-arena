/**
 * Cron: Auto-post weekly recap (P5 社区内容厚度, 2026-07-10)
 * Schedule: 0 9 * * 1 (Mondays 09:00 UTC) — see vercel.json
 *
 * 精简版周报(不复活被删的 1192 行 auto-post-insights):本周最高分交易员
 * Top 5(arena_weekly_leaders RPC,现成)+ 双语。与日报同一 system user、
 * 同一防重模式(本周已发即跳过)。
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { BASE_URL } from '@/lib/constants/urls'
import { withCron } from '@/lib/api/with-cron'

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'
const SYSTEM_HANDLE = 'arena_bot'

// arena_weekly_leaders 真实形状(2026-07-10 真点核实,勿凭先验):
// { rows: [{ roi, pnl:{value,currency}, nickname, source, sourceRank,
//   exchangeName, traderKey?, winRate, ... }] }
interface WeeklyLeader {
  nickname?: string | null
  traderKey?: string
  source?: string
  exchangeName?: string
  sourceRank?: number
  roi?: number | null
  pnl?: { value?: number | null; currency?: string } | null
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

  const { data, error } = await supabase.rpc('arena_weekly_leaders', { p_limit: 30 })
  if (error) throw new Error(`arena_weekly_leaders failed: ${error.message}`)
  const raw = ((data as { rows?: unknown[] })?.rows ?? []) as WeeklyLeader[]
  // 可信度过滤(首次真点 2026-07-10 打脸:榜首 4 个 +10000.0% = ROI clamp
  // 哨兵饱和值,还有 PnL $11 的灰尘账户)。周报是信任面,发 clamp 垃圾适得其反:
  // 剔除 |roi|≥9999(饱和) 与 PnL<$500,取剩余前 5;不足 3 个宁可跳过不发。
  const leaders = raw.filter((l) => {
    const roi = Number(l.roi)
    const pnlV = Number(l.pnl?.value)
    if (!Number.isFinite(roi) || !Number.isFinite(pnlV)) return false
    // roi==pnl 完全相等 = validate-before-write 的 roi_equals_pnl 已知垃圾模式
    if (Math.abs(roi - pnlV) < 0.01) return false
    return Math.abs(roi) < 9999 && pnlV >= 500
  })
  if (leaders.length < 3) {
    return { count: 0, skipped: true, reason: `only ${leaders.length} credible leaders` }
  }

  const lines = leaders
    .slice(0, 5)
    .map((l, i) => {
      // 匿名钱包用「交易所 #名次」代替千篇一律的 'Trader';此时不再重复
      // 括号里的交易所名
      const exchange = l.exchangeName ?? l.source ?? '—'
      const named = l.nickname || l.traderKey?.slice(0, 10)
      const display = named
        ? `**${named}** (${exchange})`
        : `**${exchange}${l.sourceRank != null ? ` #${l.sourceRank}` : ''}**`
      const medal = ['🥇', '🥈', '🥉', '4.', '5.'][i]
      const pnlV = l.pnl?.value
      const pnlStr =
        pnlV != null && Number.isFinite(Number(pnlV))
          ? ` · PnL $${Math.round(Number(pnlV)).toLocaleString('en-US')}`
          : ''
      return `${medal} ${display} — ROI ${fmtRoi(l.roi)}${pnlStr}`
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
