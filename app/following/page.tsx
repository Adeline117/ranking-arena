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
        // 获取用户关注的所有交易员ID（使用 trader_follows 表）
        const { data: follows, error: followsError } = await supabase
          .from('trader_follows')
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

        // 并行获取 trader_sources 和 trader_snapshots 数据
        const allSources = ['binance', 'binance_web3', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex']
        
        const [sourcesResult, snapshotsResult] = await Promise.all([
          // 从 trader_sources 获取 handle 信息
          supabase
            .from('trader_sources')
            .select('source_trader_id, handle, source')
            .in('source_trader_id', traderIds),
          // 直接从 trader_snapshots 获取所有关注交易员的数据
          supabase
            .from('trader_snapshots')
            .select('source_trader_id, source, rank, roi, followers, pnl, win_rate, captured_at')
            .in('source_trader_id', traderIds)
            .in('source', allSources)
            .order('captured_at', { ascending: false })
            .limit(5000)
        ])

        const sources = sourcesResult.data || []
        const allSnapshots = snapshotsResult.data || []

        // 构建 handle 映射
        const sourcesMap = new Map<string, { handle: string; source: string }>()
        sources.forEach((s: any) => {
          sourcesMap.set(s.source_trader_id, { handle: s.handle || s.source_trader_id, source: s.source })
        })

        const allTradersData: Trader[] = []
        
        if (allSnapshots.length > 0) {
          // 为每个交易员获取最新的快照（按 source_trader_id 分组取最新）
          const latestSnapshotsMap = new Map<string, typeof allSnapshots[0]>()
          
          for (const snapshot of allSnapshots) {
            const key = snapshot.source_trader_id
            if (!latestSnapshotsMap.has(key)) {
              latestSnapshotsMap.set(key, snapshot)
            } else {
              // 如果已存在，比较 ROI，保留更高的
              const existing = latestSnapshotsMap.get(key)!
              if ((snapshot.roi || 0) > (existing.roi || 0)) {
                latestSnapshotsMap.set(key, snapshot)
              }
            }
          }
          
          // 转换为 Trader 数组
          for (const [traderId, snapshot] of latestSnapshotsMap) {
            const sourceInfo = sourcesMap.get(traderId)
            // 即使没有 trader_sources 数据，也使用 traderId 作为 handle
            const handle = sourceInfo?.handle || traderId
            allTradersData.push({
              id: traderId,
              handle: handle,
              roi: snapshot.roi || 0,
              pnl: snapshot.pnl !== null && snapshot.pnl !== undefined ? snapshot.pnl : undefined,
              win_rate: snapshot.win_rate !== null && snapshot.win_rate !== undefined ? snapshot.win_rate : 0,
              volume_90d: undefined,
              avg_buy_90d: undefined,
              followers: snapshot.followers || 0,
              source: snapshot.source || 'binance',
            })
          }
        }

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








