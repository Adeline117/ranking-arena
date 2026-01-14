/**
 * 获取交易员详情 API
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// 支持的交易所
const TRADER_SOURCES = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  try {
    const { handle } = await params
    
    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const decodedHandle = decodeURIComponent(handle)

    // 遍历所有数据源查找交易员
    for (const sourceType of TRADER_SOURCES) {
      // 尝试按 handle 查询
      let source = null
      const { data: byHandle } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle, profile_url')
        .eq('source', sourceType)
        .eq('handle', decodedHandle)
        .limit(1)
        .maybeSingle()

      if (byHandle) {
        source = byHandle
      } else {
        // 尝试作为 source_trader_id 查询
        const { data: byId } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url')
          .eq('source', sourceType)
          .eq('source_trader_id', decodedHandle)
          .limit(1)
          .maybeSingle()
        
        if (byId) {
          source = byId
        }
      }

      if (!source) continue

      // 获取最新快照数据
      const { data: snapshot } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown, trades_count, followers, captured_at, season_id')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 获取不同时间段的数据
      const { data: snapshot7d } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .eq('season_id', '7D')
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const { data: snapshot30d } = await supabase
        .from('trader_snapshots')
        .select('roi, pnl, win_rate, max_drawdown')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .eq('season_id', '30D')
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 获取 Arena 粉丝数
      const { count: arenaFollowers } = await supabase
        .from('trader_follows')
        .select('*', { count: 'exact', head: true })
        .eq('trader_id', source.source_trader_id)

      // 检查是否在平台注册
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('id, bio')
        .eq('handle', source.handle || source.source_trader_id)
        .maybeSingle()

      // 获取持仓数据
      const { data: portfolioData } = await supabase
        .from('trader_portfolio')
        .select('symbol, direction, weight_pct, entry_price, pnl_pct')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('updated_at', { ascending: false })
        .limit(100)

      // 获取历史订单
      const { data: historyData } = await supabase
        .from('trader_position_history')
        .select('symbol, direction, entry_price, exit_price, pnl_pct, open_time, close_time')
        .eq('source', sourceType)
        .eq('source_trader_id', source.source_trader_id)
        .order('close_time', { ascending: false })
        .limit(50)

      // 获取交易员动态
      const traderHandle = source.handle || source.source_trader_id
      const { data: posts } = await supabase
        .from('posts')
        .select('id, title, content, created_at, group_id, like_count, is_pinned, groups(name)')
        .eq('author_handle', traderHandle)
        .order('created_at', { ascending: false })
        .limit(20)

      // 获取相似交易员
      const currentRoi = snapshot?.roi || 0
      const roiRange = Math.max(Math.abs(currentRoi) * 0.3, 20)
      
      const { data: similarSnapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, roi')
        .eq('source', sourceType)
        .neq('source_trader_id', source.source_trader_id)
        .gte('roi', currentRoi - roiRange)
        .lte('roi', currentRoi + roiRange)
        .order('roi', { ascending: false })
        .limit(6)

      let similarTraders: Array<{ handle: string; id: string; followers: number; avatar_url?: string; source: string }> = []
      if (similarSnapshots && similarSnapshots.length > 0) {
        const similarIds = similarSnapshots.map(s => s.source_trader_id)
        const { data: similarSources } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, profile_url')
          .eq('source', sourceType)
          .in('source_trader_id', similarIds)

        if (similarSources) {
          similarTraders = similarSources.map(s => ({
            handle: s.handle || s.source_trader_id,
            id: s.source_trader_id,
            followers: 0,
            avatar_url: s.profile_url || undefined,
            source: sourceType,
          }))
        }
      }

      // 构建响应数据
      const response = {
        profile: {
          handle: source.handle || source.source_trader_id,
          id: source.source_trader_id,
          bio: userProfile?.bio || undefined,
          followers: arenaFollowers || 0,
          avatar_url: source.profile_url || undefined,
          isRegistered: !!userProfile,
          source: sourceType,
        },
        performance: {
          roi_90d: snapshot?.roi || 0,
          roi_7d: snapshot7d?.roi ?? undefined,
          roi_30d: snapshot30d?.roi ?? undefined,
          pnl: snapshot?.pnl ?? undefined,
          win_rate: snapshot?.win_rate ?? undefined,
          max_drawdown: snapshot?.max_drawdown ?? undefined,
          pnl_7d: snapshot7d?.pnl ?? undefined,
          pnl_30d: snapshot30d?.pnl ?? undefined,
          win_rate_7d: snapshot7d?.win_rate ?? undefined,
          win_rate_30d: snapshot30d?.win_rate ?? undefined,
          max_drawdown_7d: snapshot7d?.max_drawdown ?? undefined,
          max_drawdown_30d: snapshot30d?.max_drawdown ?? undefined,
        },
        stats: {
          additionalStats: {
            tradesCount: snapshot?.trades_count ?? undefined,
          },
        },
        portfolio: portfolioData?.map(item => ({
          market: item.symbol || '',
          direction: item.direction === 'short' ? 'short' : 'long',
          invested: item.weight_pct ?? 0,
          pnl: item.pnl_pct ?? 0,
          value: item.weight_pct ?? 0,
          price: item.entry_price ?? 0,
        })) || [],
        positionHistory: historyData?.map(item => ({
          symbol: item.symbol || '',
          direction: item.direction === 'short' ? 'short' : 'long',
          entryPrice: item.entry_price || 0,
          exitPrice: item.exit_price || 0,
          pnlPct: item.pnl_pct || 0,
          openTime: item.open_time || '',
          closeTime: item.close_time || '',
        })) || [],
        feed: posts?.map(post => ({
          id: post.id,
          type: post.group_id ? 'group_post' : 'post',
          title: post.title,
          content: post.content || '',
          time: post.created_at,
          groupId: post.group_id,
          groupName: (post.groups as { name?: string } | null)?.name,
          like_count: post.like_count || 0,
          is_pinned: post.is_pinned || false,
        })) || [],
        similarTraders,
      }

      console.log(`[Trader API] 找到交易员: ${source.handle || source.source_trader_id} (${sourceType})`)
      return NextResponse.json(response)
    }

    // 没有找到交易员
    return NextResponse.json({ 
      error: 'Trader not found',
      handle: decodedHandle,
    }, { status: 404 })

  } catch (error) {
    console.error('[Trader API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

