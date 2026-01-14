'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import PostFeed from '@/app/components/Features/PostFeed'
import Card from '@/app/components/UI/Card'
import { Box, Text, Button } from '@/app/components/Base'
import type { Trader } from '@/app/components/Features/RankingTable'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

type Group = {
  id: string
  name: string
  avatar_url?: string | null
  member_count?: number | null
}

function GroupsList() {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('groups')
          .select('id, name, avatar_url, member_count')
          .order('member_count', { ascending: false, nullsFirst: false })
          .limit(10)

        if (error) {
          console.error('Error loading groups:', JSON.stringify(error))
        }
        setGroups(data || [])
      } catch (err) {
        console.error('Error:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  if (loading) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        加载中...
      </Text>
    )
  }

  if (groups.length === 0) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        暂无小组
      </Text>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {groups.map((group) => (
        <Link
          key={group.id}
          href={`/groups/${group.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            textDecoration: 'none',
            color: tokens.colors.text.primary,
            transition: `all ${tokens.transition.base}`,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.tertiary || tokens.colors.bg.hover
            e.currentTarget.style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
            e.currentTarget.style.transform = 'translateX(4px)'
            e.currentTarget.style.boxShadow = tokens.shadow.sm
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.secondary
            e.currentTarget.style.borderColor = tokens.colors.border.primary
            e.currentTarget.style.transform = 'translateX(0)'
            e.currentTarget.style.boxShadow = 'none'
          }}
        >
          {/* Avatar */}
          <Box
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.md,
              background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {group.avatar_url ? (
              <img
                src={group.avatar_url}
                alt={group.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Text size="sm" weight="bold" color="tertiary">
                {group.name.charAt(0).toUpperCase()}
              </Text>
            )}
          </Box>

          {/* Info */}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
              {group.name}
            </Text>
            {group.member_count !== null && group.member_count !== undefined && (
              <Text size="xs" color="tertiary">
                {group.member_count} 位成员
              </Text>
            )}
          </Box>
        </Link>
      ))}
    </Box>
  )
}

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
      try {
        // 获取最新的 captured_at (90D 数据)
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

        // 查询 snapshots - 按 ROI 排序获取前10
        const { data: snapshots } = await supabase
          .from('trader_snapshots')
          .select('source_trader_id, rank, roi, pnl, followers, win_rate, max_drawdown')
          .eq('source', 'binance')
          .eq('captured_at', latestSnapshot.captured_at)
          .order('roi', { ascending: false })
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
          pnl: item.pnl || 10000,
          win_rate: item.win_rate || 0,
          max_drawdown: item.max_drawdown,
          followers: item.followers || 0,
          source: 'binance',
        }))

        setTraders(tradersData)
      } catch (error) {
        console.error('加载排行榜失败:', error)
        setTraders([])
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box className="groups-grid" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
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
              <GroupsList />
              
              {/* 申请创办小组按钮 */}
              <Link href="/groups/apply" style={{ display: 'block', marginTop: tokens.spacing[4] }}>
                <Button
                  variant="secondary"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.lg,
                    border: `1px dashed ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.secondary,
                    cursor: 'pointer',
                    transition: `all ${tokens.transition.base}`,
                  }}
                >
                  <span style={{ fontSize: '18px' }}>+</span>
                  {t('applyCreateGroup')}
                </Button>
              </Link>
            </Card>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
