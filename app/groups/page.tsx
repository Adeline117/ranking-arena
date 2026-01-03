'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import MarketPanel from '@/app/components/Features/MarketPanel'
import PostFeed from '@/app/components/Features/PostFeed'
import Card from '@/app/components/UI/Card'
import { Box, Text } from '@/app/components/Base'
import type { Trader } from '@/app/components/Features/RankingTable'

export default function GroupsPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoggedIn(!!data.user)
    })
  }, [])

  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select(`
          source_trader_id,
          rank,
          roi,
          followers,
          trader_sources!inner(handle)
        `)
        .eq('source', 'binance')
        .order('rank', { ascending: true })
        .limit(10)

      if (!error && data) {
        const tradersData: Trader[] = data.map((item: any) => ({
          id: item.source_trader_id,
          handle: item.trader_sources?.handle || item.source_trader_id,
          roi: item.roi || 0,
          win_rate: 0,
          followers: item.followers || 0,
        }))
        setTraders(tradersData)
      } else {
        console.error('[groups ranking]', error)
        setTraders([])
      }
      setLoadingTraders(false)
    }
    load()
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box as="main" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
          {/* 左：排名前十 */}
          <Box as="section">
            <Card title="排名前十">
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={loggedIn} />
            </Card>
          </Box>

          {/* 中：算法推荐帖子 */}
          <Box as="section">
            <Card title="推荐帖子">
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {loggedIn ? '已登录：显示全部推荐' : '未登录：仅显示前10条'}
              </Text>
              <PostFeed variant={loggedIn ? 'full' : 'compact'} />
            </Card>
          </Box>

          {/* 右：小组推荐 */}
          <Box as="section">
            <Card title="小组推荐">
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                热门小组
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {/* TODO: 从 groups 表获取推荐小组 */}
                <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  小组推荐功能待实现
                </Text>
              </Box>
            </Card>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
