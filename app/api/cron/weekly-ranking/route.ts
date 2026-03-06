/**
 * 交易员周榜自动生成 Cron
 * 每周一09:00 UTC运行，生成7D Top10周榜帖子
 */

export const runtime = 'edge'
export const maxDuration = 30

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

const SYSTEM_USER_ID = 'ae6b996d-0000-0000-0000-000000000000'

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  const plog = await PipelineLogger.start('weekly-ranking')
  try {
    const supabase = getSupabaseAdmin()

    const _weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // 获取7D快照数据，按收益率排序
     
    const { data: snapshots } = await supabase
      .from('trader_snapshots')
      .select('trader_id, roi_7d, roi_30d, nickname, win_rate')
      .not('roi_7d', 'is', null)
      .order('roi_7d', { ascending: false })
      .limit(10) as { data: { trader_id: string; roi_7d: number; roi_30d: number; nickname: string; win_rate: number }[] | null }

    if (!snapshots || snapshots.length === 0) {
      return new Response(JSON.stringify({ message: 'Insufficient data to generate weekly ranking' }))
    }

    // 获取上周排名（用于计算黑马）
    const { data: lastWeekSnapshots } = await supabase
      .from('trader_snapshots')
      .select('trader_id, roi_7d')
      .not('roi_7d', 'is', null)
      .order('roi_7d', { ascending: false })
      .limit(50)

    // 构建上周排名映射
    const prevRankMap = new Map<string, number>()
    lastWeekSnapshots?.forEach((s, i) => {
      prevRankMap.set(s.trader_id, i + 1)
    })

    // 查找黑马（排名上升最多）
    let darkHorse: { nickname: string; rise: number } | null = null
    let maxRise = 0
    snapshots.forEach((s, i) => {
      const prevRank = prevRankMap.get(s.trader_id)
      if (prevRank && prevRank - (i + 1) > maxRise) {
        maxRise = prevRank - (i + 1)
        darkHorse = { nickname: s.nickname || s.trader_id.slice(0, 8), rise: maxRise }
      }
    })

    // 生成帖子内容
    const now = new Date()
    const weekStr = `${now.getFullYear()}年第${getWeekNumber(now)}周`

    const title = `交易员周榜 | ${weekStr} Top10`

    const rankingLines = snapshots.map((s, i) => {
      const rank = i + 1
      const name = s.nickname || s.trader_id.slice(0, 8)
      const roi = s.roi_7d != null ? `${s.roi_7d > 0 ? '+' : ''}${s.roi_7d.toFixed(2)}%` : 'N/A'
      const winRate = s.win_rate != null ? `胜率${(s.win_rate * 100).toFixed(0)}%` : ''
      return `${rank}. ${name} -- 7D ROI: ${roi} ${winRate}`
    })

    const content = [
      `${weekStr} 交易员排行榜`,
      '',
      '--- 7D ROI Top10 ---',
      '',
      ...rankingLines,
      '',
      darkHorse ? `本周黑马: ${(darkHorse as { nickname: string; rise: number }).nickname}（排名上升${(darkHorse as { nickname: string; rise: number }).rise}位）` : '',
      '',
      '数据来源: Arena交易员快照',
      `统计周期: ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('zh-CN')} - ${now.toLocaleDateString('zh-CN')}`,
    ]
      .filter(Boolean)
      .join('\n')

    // 查找系统用户handle
    const { data: sysUser } = await supabase
      .from('profiles')
      .select('handle')
      .eq('id', SYSTEM_USER_ID)
      .single()

    // 查找默认小组
    const { data: groups } = await supabase
      .from('groups')
      .select('id')
      .or('name.ilike.%排行%,name.ilike.%ranking%,name.ilike.%综合%,name.ilike.%general%')
      .limit(1)

    await supabase.from('posts').insert({
      title,
      content,
      author_id: SYSTEM_USER_ID,
      author_handle: sysUser?.handle || 'system',
      group_id: groups?.[0]?.id || null,
    })

    await plog.success(snapshots.length)
    return new Response(
      JSON.stringify({ message: 'Weekly ranking post created', title }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error: unknown) {
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    return new Response(JSON.stringify({ error: (error instanceof Error ? error.message : String(error)) }), { status: 500 })
  }
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}
