'use client'

import Link from 'next/link'
import { useEffect, useState, Suspense, lazy } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import PostFeed from '@/app/components/post/PostFeed'
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { RankingSkeleton, SkeletonCard } from '@/app/components/ui/Skeleton'
import { useToast } from '@/app/components/ui/Toast'
import { ErrorBoundary } from '@/app/components/Providers/ErrorBoundary'
import ProFeaturesPanel from '@/app/components/premium/ProFeaturesPanel'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'

const MarketPanel = lazy(() => import('@/app/components/home/MarketPanel'))

type Group = {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
}

type PopularTrader = {
  source: string
  source_trader_id: string
  handle?: string | null
  avatar_url?: string | null
  followers?: number | null
  roi?: number | null
}

function PopularTraders() {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const [traders, setTraders] = useState<PopularTrader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredTrader, setHoveredTrader] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        setError(null)
        const { data, error: supabaseError } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, avatar_url, roi, arena_score')
          .order('arena_score', { ascending: false, nullsFirst: false })
          .limit(10)

        if (supabaseError) {
          const errorMsg = language === 'zh'
            ? '加载热门交易员失败，请稍后重试'
            : 'Failed to load popular traders, please try again later'
          setError(errorMsg)
          showToast(errorMsg, 'error')
          return
        }

        // Fetch followers from latest snapshots for display
        const traderKeys = (data || []).map(t => t.source_trader_id)
        let followersMap: Record<string, number> = {}
        if (traderKeys.length > 0) {
          const { data: snapshots } = await supabase
            .from('trader_snapshots')
            .select('source_trader_id, followers')
            .in('source_trader_id', traderKeys)
            .order('captured_at', { ascending: false })
            .limit(traderKeys.length)

          if (snapshots) {
            for (const s of snapshots) {
              if (!followersMap[s.source_trader_id] && s.followers != null) {
                followersMap[s.source_trader_id] = s.followers
              }
            }
          }
        }

        setTraders((data || []).map(t => ({
          ...t,
          followers: followersMap[t.source_trader_id] ?? null,
        })))
      } catch (err) {
        const errorMsg = language === 'zh'
          ? '网络错误，请检查网络连接后重试'
          : 'Network error, please check your connection and try again'
        setError(errorMsg)
        showToast(errorMsg, 'error')
        console.error('Error loading popular traders:', err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [language, showToast])

  if (loading) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {language === 'zh' ? '加载中...' : 'Loading...'}
      </Text>
    )
  }

  if (error) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" style={{ color: '#DC2626', marginBottom: tokens.spacing[2] }}>
          {error}
        </Text>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          {language === 'zh' ? '重试' : 'Retry'}
        </Button>
      </Box>
    )
  }

  if (traders.length === 0) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {language === 'zh' ? '暂无数据' : 'No data available'}
      </Text>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {traders.map((trader, index) => {
        const traderId = `${trader.source}-${trader.source_trader_id}`
        const isHovered = hoveredTrader === traderId
        const displayName = trader.handle || trader.source_trader_id.slice(0, 8)
        const href = trader.handle ? `/trader/${trader.handle}` : `/trader/${trader.source_trader_id}`

        return (
          <Link
            key={traderId}
            href={href}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: isHovered
                ? 'linear-gradient(135deg, rgba(139, 111, 168, 0.12) 0%, rgba(139, 111, 168, 0.05) 100%)'
                : tokens.colors.bg.secondary,
              border: `1px solid ${isHovered ? 'rgba(139, 111, 168, 0.3)' : tokens.colors.border.primary}`,
              textDecoration: 'none',
              color: tokens.colors.text.primary,
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              cursor: 'pointer',
              transform: isHovered ? 'translateX(4px)' : 'translateX(0)',
            }}
            onMouseEnter={() => setHoveredTrader(traderId)}
            onMouseLeave={() => setHoveredTrader(null)}
          >
            {/* Rank */}
            <Text size="sm" weight="bold" style={{ color: index < 3 ? '#c9b8db' : tokens.colors.text.tertiary, width: 20, textAlign: 'center', flexShrink: 0 }}>
              {index + 1}
            </Text>

            {/* Avatar */}
            <Box
              style={{
                width: 36,
                height: 36,
                borderRadius: tokens.radius.full,
                background: 'linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.1) 100%)',
                border: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {trader.avatar_url ? (
                <img
                  src={trader.avatar_url}
                  alt={displayName}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <Text size="xs" weight="bold" style={{ color: '#c9b8db' }}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              )}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" weight="bold" style={{ marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[2], alignItems: 'center' }}>
                <Text size="xs" color="tertiary">
                  {trader.source}
                </Text>
                {trader.followers != null && (
                  <Text size="xs" color="tertiary">
                    {trader.followers.toLocaleString()} {language === 'zh' ? '跟单' : 'copiers'}
                  </Text>
                )}
              </Box>
            </Box>

            {/* ROI */}
            {trader.roi != null && (
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: Number(trader.roi) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                  flexShrink: 0,
                }}
              >
                {Number(trader.roi) >= 0 ? '+' : ''}{Number(trader.roi).toFixed(1)}%
              </Text>
            )}
          </Link>
        )
      })}
    </Box>
  )
}

function GroupsList() {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeGroupTab, setActiveGroupTab] = useState<'all' | 'mine' | 'hot'>('all')
  const [userId, setUserId] = useState<string | null>(null)
  const [myGroupIds, setMyGroupIds] = useState<string[]>([])

  // Get user for "Mine" tab
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // Load user's group memberships
  useEffect(() => {
    if (!userId) return
    const loadMemberships = async () => {
      const { data } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('user_id', userId)
      setMyGroupIds((data || []).map(m => m.group_id))
    }
    loadMemberships()
  }, [userId])

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        setError(null)

        // "Mine" tab early return
        if (activeGroupTab === 'mine' && myGroupIds.length === 0) {
          setGroups([])
          setLoading(false)
          return
        }

        // "Hot" tab: rank by recent activity (posts in last 7 days)
        if (activeGroupTab === 'hot') {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
          const { data: recentPosts } = await supabase
            .from('posts')
            .select('group_id')
            .gte('created_at', sevenDaysAgo)
            .not('group_id', 'is', null)

          // Count posts per group
          const activityMap: Record<string, number> = {}
          for (const p of recentPosts || []) {
            if (p.group_id) {
              activityMap[p.group_id] = (activityMap[p.group_id] || 0) + 1
            }
          }

          const activeGroupIds = Object.keys(activityMap)
          if (activeGroupIds.length === 0) {
            // Fallback to member_count if no recent activity
            const { data } = await supabase
              .from('groups')
              .select('id, name, avatar_url, member_count, name_en')
              .order('member_count', { ascending: false, nullsFirst: false })
              .limit(20)
            setGroups(data || [])
            setLoading(false)
            return
          }

          let query = supabase
            .from('groups')
            .select('id, name, avatar_url, member_count, name_en')
            .in('id', activeGroupIds)
            .limit(20)

          if (debouncedQuery) {
            query = query.or(`name.ilike.%${debouncedQuery}%,name_en.ilike.%${debouncedQuery}%`)
          }

          const { data, error: supabaseError } = await query
          if (supabaseError) {
            setError(language === 'zh' ? '加载失败' : 'Failed to load')
            showToast(language === 'zh' ? '加载小组列表失败' : 'Failed to load groups', 'error')
          }

          // Sort by activity count (descending)
          const sorted = (data || []).sort((a, b) => (activityMap[b.id] || 0) - (activityMap[a.id] || 0))
          setGroups(sorted)
          setLoading(false)
          return
        }

        // "All" and "Mine" tabs: sort by member_count
        let query = supabase
          .from('groups')
          .select('id, name, avatar_url, member_count, name_en')
          .order('member_count', { ascending: false, nullsFirst: false })
          .limit(20)

        if (debouncedQuery) {
          query = query.or(`name.ilike.%${debouncedQuery}%,name_en.ilike.%${debouncedQuery}%`)
        }

        if (activeGroupTab === 'mine') {
          query = query.in('id', myGroupIds)
        }

        const { data, error: supabaseError } = await query

        if (supabaseError) {
          setError(language === 'zh' ? '加载失败' : 'Failed to load')
          showToast(language === 'zh' ? '加载小组列表失败' : 'Failed to load groups', 'error')
        }
        setGroups(data || [])
      } catch (err) {
        setError(language === 'zh' ? '网络错误' : 'Network error')
        console.error('Error loading groups:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [debouncedQuery, activeGroupTab, myGroupIds, language, showToast])

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {/* Search input */}
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={language === 'zh' ? '搜索小组...' : 'Search groups...'}
        style={{
          width: '100%',
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.sm,
        }}
      />

      {/* Tabs */}
      <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
        {(['all', 'mine', 'hot'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveGroupTab(tab)}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: 'none',
              cursor: 'pointer',
              background: activeGroupTab === tab ? `${tokens.colors.accent?.primary || '#8b6fa8'}20` : 'transparent',
              color: activeGroupTab === tab ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: activeGroupTab === tab ? 'bold' : 'normal',
            }}
          >
            {tab === 'all' ? (language === 'zh' ? '全部' : 'All')
              : tab === 'mine' ? (language === 'zh' ? '我的' : 'Mine')
              : (language === 'zh' ? '热门' : 'Hot')}
          </button>
        ))}
      </Box>

      {/* Results */}
      {loading ? (
        <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[3], textAlign: 'center' }}>
          {language === 'zh' ? '加载中...' : 'Loading...'}
        </Text>
      ) : error ? (
        null
      ) : groups.length === 0 ? (
        <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[3], textAlign: 'center' }}>
          {debouncedQuery
            ? (language === 'zh' ? '未找到匹配的小组' : 'No groups found')
            : activeGroupTab === 'mine'
              ? (language === 'zh' ? '还未加入任何小组' : 'Not joined any groups')
              : (language === 'zh' ? '暂无小组' : 'No groups available')}
        </Text>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {groups.map((group) => (
            <Link
              key={group.id}
              href={`/groups/${group.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                textDecoration: 'none',
                color: tokens.colors.text.primary,
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <Box style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.md,
                background: 'linear-gradient(135deg, rgba(139,111,168,0.2), rgba(139,111,168,0.1))',
                border: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}>
                {group.avatar_url ? (
                  <img src={group.avatar_url} alt={group.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Text size="xs" weight="bold" style={{ color: '#c9b8db' }}>
                    {group.name.charAt(0).toUpperCase()}
                  </Text>
                )}
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="xs" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {group.name}
                </Text>
              </Box>
              {group.member_count != null && (
                <Text size="xs" color="tertiary" style={{ flexShrink: 0 }}>
                  {group.member_count}
                </Text>
              )}
            </Link>
          ))}
        </Box>
      )}
    </Box>
  )
}

function MyGroups() {
  const { language } = useLanguage()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) {
        setLoading(false)
        return
      }

      const { data: memberships } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('user_id', userData.user.id)

      if (!memberships || memberships.length === 0) {
        setLoading(false)
        return
      }

      const groupIds = memberships.map(m => m.group_id)
      const { data: groupsData } = await supabase
        .from('groups')
        .select('id, name, avatar_url, member_count')
        .in('id', groupIds)

      setGroups(groupsData || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {language === 'zh' ? '加载中...' : 'Loading...'}
      </Text>
    )
  }

  if (groups.length === 0) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {language === 'zh' ? '还未加入任何小组' : 'Not joined any groups yet'}
      </Text>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {groups.map((group) => (
        <Link
          key={group.id}
          href={`/groups/${group.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            textDecoration: 'none',
            color: tokens.colors.text.primary,
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <Box style={{
            width: 32,
            height: 32,
            borderRadius: tokens.radius.md,
            background: 'linear-gradient(135deg, rgba(139,111,168,0.2), rgba(139,111,168,0.1))',
            border: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
            {group.avatar_url ? (
              <img src={group.avatar_url} alt={group.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <Text size="xs" weight="bold" style={{ color: '#c9b8db' }}>
                {group.name.charAt(0).toUpperCase()}
              </Text>
            )}
          </Box>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="xs" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.name}
            </Text>
          </Box>
        </Link>
      ))}
    </Box>
  )
}

function GroupsContent() {
  const { t, language } = useLanguage()
  const searchParams = useSearchParams()
  const initialPostId = searchParams.get('post')
  const [email, setEmail] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)
  const { isPro } = useSubscription()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoggedIn(!!data.user)
    })
  }, [])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <style jsx global>{`
          .groups-page-grid {
            display: grid;
            gap: 16px;
            grid-template-columns: 1fr;
          }
          @media (min-width: 768px) {
            .groups-page-grid {
              grid-template-columns: 260px 1fr;
            }
            .groups-page-grid .right-sidebar {
              display: none;
            }
          }
          @media (min-width: 1024px) {
            .groups-page-grid {
              grid-template-columns: 240px 1fr 240px;
            }
            .groups-page-grid .right-sidebar {
              display: block;
            }
          }
          @media (max-width: 767px) {
            .groups-page-grid .left-sidebar {
              order: -1;
            }
          }
        `}</style>
        <Box className="groups-page-grid">
          {/* 左：热门交易员 + 小组推荐 + 市场 */}
          <Box as="section" className="left-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* 热门交易员 */}
            <Card title={language === 'zh' ? '热门交易员' : 'Popular Traders'}>
              <PopularTraders />
            </Card>

            {/* 小组推荐 */}
            <Card title={t('groupRecommendations')}>
              <GroupsList />
              <Link href="/groups/apply" style={{ display: 'block', marginTop: tokens.spacing[3] }}>
                <Button
                  variant="secondary"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.lg,
                    border: `1px dashed ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.secondary,
                    cursor: 'pointer',
                    fontSize: tokens.typography.fontSize.xs,
                  }}
                >
                  <span style={{ fontSize: '14px' }}>+</span>
                  {t('applyCreateGroup')}
                </Button>
              </Link>
            </Card>

            {/* 市场数据 */}
            <ErrorBoundary>
              <Suspense fallback={<SkeletonCard />}>
                <MarketPanel />
              </Suspense>
            </ErrorBoundary>
          </Box>

          {/* 中：帖子瀑布流 */}
          <Box as="section" className="main-content">
            <Card title={language === 'zh' ? '推荐动态' : 'Recommended'}>
              <PostFeed layout="masonry" variant={loggedIn ? 'full' : 'compact'} initialPostId={initialPostId} />
            </Card>
          </Box>

          {/* 右：Pro功能 + 我的小组 */}
          <Box as="section" className="right-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* Pro功能 - pro会员不显示 */}
            {!isPro && (
              <ProFeaturesPanel compact />
            )}

            {/* 我的小组 */}
            <Card title={language === 'zh' ? '我的小组' : 'My Groups'}>
              <MyGroups />
            </Card>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default function GroupsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <GroupsContent />
    </Suspense>
  )
}
