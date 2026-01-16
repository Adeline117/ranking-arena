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
        // 通过 API 获取关注的交易员（使用服务端权限）
        const response = await fetch(`/api/following?userId=${userId}`)
        const data = await response.json()
        
        if (!response.ok) {
          console.error('Error fetching following:', data.error)
          setTraders([])
          return
        }

        // 调试信息
        if (data.debug) {
          console.log('[Following Page] Debug info:', data.debug)
        }

        if (!data.traders || data.traders.length === 0) {
          setTraders([])
          return
        }

        // 转换为 Trader 类型
        const tradersData: Trader[] = data.traders.map((t: any) => ({
          id: t.id,
          handle: t.handle,
          roi: t.roi || 0,
          pnl: t.pnl,
          win_rate: t.win_rate || 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: t.followers || 0,
          source: t.source || 'binance',
          avatar_url: t.avatar_url,
        }))

        setTraders(tradersData)
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








