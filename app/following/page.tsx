'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import RankingTable, { type Trader } from '@/app/components/Features/RankingTable'
import { Box, Text } from '@/app/components/Base'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import EmptyState from '@/app/components/UI/EmptyState'

export default function FollowingPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      setLoading(true)
      try {
        // 获取用户关注的所有交易员ID
        const { data: follows, error: followsError } = await supabase
          .from('follows')
          .select('trader_id')
          .eq('user_id', userId)

        if (followsError) {
          console.error('Error fetching follows:', followsError)
          setTraders([])
          setLoading(false)
          return
        }

        if (!follows || follows.length === 0) {
          setTraders([])
          setLoading(false)
          return
        }

        const traderIds = follows.map((f: any) => f.trader_id)

        // 从 trader_sources 获取交易员信息
        const { data: sources, error: sourcesError } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, source')
          .in('source_trader_id', traderIds)

        if (sourcesError) {
          console.error('Error fetching trader sources:', sourcesError)
          setTraders([])
          setLoading(false)
          return
        }

        if (!sources || sources.length === 0) {
          setTraders([])
          setLoading(false)
          return
        }

        // 获取最新的交易员快照数据
        const sourceTraderIds = sources.map((s: any) => s.source_trader_id)
        const sourcesMap = new Map<string, { handle: string; source: string }>()
        sources.forEach((s: any) => {
          sourcesMap.set(s.source_trader_id, { handle: s.handle || s.source_trader_id, source: s.source })
        })

        // 分别查询 binance 和 binance_web3 的数据
        const allTradersData: Trader[] = []

        // 查询 binance 数据
        const { data: binanceSnapshotsAll } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, rank, roi, followers, pnl, win_rate, captured_at')
          .eq('source', 'binance')
          .in('source_trader_id', sourceTraderIds)
          .order('captured_at', { ascending: false })
          .limit(1000)

        const latestBinanceTime = binanceSnapshotsAll?.[0]?.captured_at
        const finalBinanceSnapshots = latestBinanceTime
          ? (binanceSnapshotsAll || [])
              .filter(s => s.captured_at === latestBinanceTime)
              .filter(s => sourceTraderIds.includes(s.source_trader_id))
          : []

        finalBinanceSnapshots.forEach((item: any) => {
          const sourceInfo = sourcesMap.get(item.source_trader_id)
          if (sourceInfo) {
            allTradersData.push({
              id: item.source_trader_id,
              handle: sourceInfo.handle,
              roi: item.roi || 0,
              pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
              win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
              volume_90d: undefined,
              avg_buy_90d: undefined,
              followers: item.followers || 0,
              source: 'binance',
            })
          }
        })

        // 查询 binance_web3 数据
        const { data: web3SnapshotsAll } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, rank, roi, followers, pnl, win_rate, captured_at')
          .eq('source', 'binance_web3')
          .in('source_trader_id', sourceTraderIds)
          .order('captured_at', { ascending: false })
          .limit(1000)

        const latestWeb3Time = web3SnapshotsAll?.[0]?.captured_at
        const finalWeb3Snapshots = latestWeb3Time
          ? (web3SnapshotsAll || [])
              .filter(s => s.captured_at === latestWeb3Time)
              .filter(s => sourceTraderIds.includes(s.source_trader_id))
          : []

        finalWeb3Snapshots.forEach((item: any) => {
          const sourceInfo = sourcesMap.get(item.source_trader_id)
          if (sourceInfo) {
            // 如果已经存在，保留 ROI 更高的
            const existing = allTradersData.find(t => t.id === item.source_trader_id)
            if (!existing || item.roi > existing.roi) {
              if (existing) {
                // 更新现有项
                existing.roi = item.roi || 0
                existing.pnl = item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined
                existing.win_rate = item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0
                existing.followers = item.followers || 0
                existing.source = 'binance_web3'
              } else {
                // 添加新项
                allTradersData.push({
                  id: item.source_trader_id,
                  handle: sourceInfo.handle,
                  roi: item.roi || 0,
                  pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
                  win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
                  volume_90d: undefined,
                  avg_buy_90d: undefined,
                  followers: item.followers || 0,
                  source: 'binance_web3',
                })
              }
            }
          }
        })

        // 按 ROI 降序排序
        const sortedTraders = allTradersData.sort((a, b) => b.roi - a.roi)
        setTraders(sortedTraders)
      } catch (error) {
        console.error('Error loading following traders:', error)
        setTraders([])
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [userId])

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            我的关注
          </Text>
          <EmptyState
            title="请先登录"
            description="登录后可以查看您关注的交易员排行榜"
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          我的关注
        </Text>
        {loading ? (
          <RankingSkeleton />
        ) : traders.length === 0 ? (
          <EmptyState
            title="暂无关注的交易员"
            description="关注一些交易员后，他们会显示在这里"
          />
        ) : (
          <RankingTable traders={traders} loading={false} loggedIn={true} />
        )}
      </Box>
    </Box>
  )
}



