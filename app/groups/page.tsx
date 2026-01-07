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
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

export default function GroupsPage() {
  const { t } = useLanguage()
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
      
      // 获取最新的 captured_at
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', 'binance')
        .order('captured_at', { ascending: false })
        .limit(1)
        .single()

      if (!latestSnapshot) {
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 查询 snapshots
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, rank, roi, followers')
        .eq('source', 'binance')
        .eq('captured_at', latestSnapshot.captured_at)
        .order('rank', { ascending: true })
        .limit(10)

      if (!snapshots || snapshots.length === 0) {
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 查询 handles
      const traderIds = snapshots.map((s: any) => s.source_trader_id)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle')
        .eq('source', 'binance')
        .in('source_trader_id', traderIds)

      const handleMap = new Map()
      if (sources) {
        sources.forEach((s: any) => {
          handleMap.set(s.source_trader_id, s.handle)
        })
      }

      const tradersData: Trader[] = snapshots.map((item: any) => ({
        id: item.source_trader_id,
        handle: handleMap.get(item.source_trader_id) || item.source_trader_id,
        roi: item.roi || 0,
        win_rate: 0,
        followers: item.followers || 0,
        source: 'binance', // 数据来源
      }))

      setTraders(tradersData)
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
            <Card title={t('top10')}>
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={loggedIn} />
            </Card>
          </Box>

          {/* 中：算法推荐帖子 */}
          <Box as="section">
            <Card title={t('recommendedPosts')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {loggedIn ? t('loggedInShowAll') : t('notLoggedInShowLimited')}
              </Text>
              <PostFeed variant={loggedIn ? 'full' : 'compact'} />
            </Card>
          </Box>

          {/* 右：小组推荐 */}
          <Box as="section">
            <Card title={t('groupRecommendations')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {t('hotGroups')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {/* TODO: 从 groups 表获取推荐小组 */}
                <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  {t('groupRecommendationsComingSoon')}
                </Text>
              </Box>
            </Card>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
