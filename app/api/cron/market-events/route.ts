/**
 * 市场事件自动发帖 Cron
 * 检查24h涨跌幅 >= 10%的币种，自动创建讨论帖
 */

export const runtime = 'edge'

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'

const SYSTEM_USER_ID = 'ae6b996d-0000-0000-0000-000000000000'
const COINGECKO_API = 'https://api.coingecko.com/api/v3'

interface CoinMarketData {
  id: string
  symbol: string
  name: string
  current_price: number
  price_change_percentage_24h: number
  high_24h: number
  low_24h: number
  total_volume: number
}

export async function GET(request: NextRequest) {
  // 验证cron密钥
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const supabase = getSupabaseAdmin()

    // 获取市场数据
    const res = await fetch(
      `${COINGECKO_API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`,
      { headers: { accept: 'application/json' } }
    )

    if (!res.ok) {
      return new Response(JSON.stringify({ error: '获取市场数据失败' }), { status: 502 })
    }

    const coins: CoinMarketData[] = await res.json()

    // 筛选涨跌幅 >= 10%
    const significantMoves = coins.filter(
      (c) => Math.abs(c.price_change_percentage_24h) >= 10
    )

    if (significantMoves.length === 0) {
      return new Response(JSON.stringify({ message: '无显著市场事件', created: 0 }))
    }

    // 查找默认小组
    const { data: groups } = await supabase
      .from('groups')
      .select('id, name')
      .or('name.ilike.%市场%,name.ilike.%market%,name.ilike.%综合%,name.ilike.%general%')
      .limit(1)

    const groupId = groups?.[0]?.id || null

    // 查找系统用户handle
    const { data: sysUser } = await supabase
      .from('profiles')
      .select('handle')
      .eq('id', SYSTEM_USER_ID)
      .single()

    const sysHandle = sysUser?.handle || 'system'

    let created = 0

    for (const coin of significantMoves) {
      const change = coin.price_change_percentage_24h
      const direction = change > 0 ? '涨' : '跌'
      const absChange = Math.abs(change).toFixed(1)

      const title = `${coin.symbol.toUpperCase()} 24h${direction}${absChange}%，你怎么看？`
      const content = [
        `${coin.name} (${coin.symbol.toUpperCase()}) 在过去24小时内${direction}幅达到 ${absChange}%。`,
        '',
        `当前价格: $${coin.current_price.toLocaleString()}`,
        `24h最高: $${coin.high_24h.toLocaleString()}`,
        `24h最低: $${coin.low_24h.toLocaleString()}`,
        `24h成交量: $${coin.total_volume.toLocaleString()}`,
        '',
        '欢迎分享你的看法和分析。',
      ].join('\n')

      // 检查是否已存在类似帖子（防重复）
      const { data: existing } = await supabase
        .from('posts')
        .select('id')
        .ilike('title', `%${coin.symbol.toUpperCase()} 24h%`)
        .gte('created_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
        .limit(1)

      if (existing && existing.length > 0) continue

      await supabase.from('posts').insert({
        title,
        content,
        author_id: SYSTEM_USER_ID,
        author_handle: sysHandle,
        group_id: groupId,
      })

      created++
    }

    return new Response(
      JSON.stringify({ message: `创建了 ${created} 个市场讨论帖`, created }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: (error instanceof Error ? error.message : String(error)) }), { status: 500 })
  }
}
