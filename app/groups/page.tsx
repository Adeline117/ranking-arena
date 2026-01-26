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

  useEffect(() => {
    const load = async () => {
      try {
        setError(null)

        // Query from trader_snapshots - 90D window
        let { data, error: supabaseError } = await supabase
          .from('trader_snapshots')
          .select('source, source_trader_id, roi, arena_score, followers')
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .order('arena_score', { ascending: false })
          .limit(30)

        // Fallback to ROI if no arena_score data
        if (!data || data.length === 0) {
          const fallbackResult = await supabase
            .from('trader_snapshots')
            .select('source, source_trader_id, roi, arena_score, followers')
            .eq('season_id', '90D')
            .not('roi', 'is', null)
            .order('roi', { ascending: false })
            .limit(30)

          data = fallbackResult.data
          supabaseError = fallbackResult.error
        }

        if (supabaseError) {
          const errorMsg = language === 'zh'
            ? '加载热门交易员失败，请稍后重试'
            : 'Failed to load popular traders, please try again later'
          setError(errorMsg)
          showToast(errorMsg, 'error')
          return
        }

        // Deduplicate by source:source_trader_id, keep first (highest score)
        const seen = new Set<string>()
        const dedupedData = (data || []).filter(row => {
          const key = `${row.source}:${row.source_trader_id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, 10) // Take top 10

        // Fetch handle and avatar from trader_sources
        const traderKeys = dedupedData.map(t => t.source_trader_id)
        let profileMap: Record<string, { handle: string | null; avatar_url: string | null }> = {}
        if (traderKeys.length > 0) {
          const { data: sources } = await supabase
            .from('trader_sources')
            .select('source_trader_id, handle')
            .in('source_trader_id', traderKeys)

          if (sources) {
            for (const s of sources) {
              profileMap[s.source_trader_id] = { handle: s.handle, avatar_url: null }
            }
          }
        }

        setTraders(dedupedData.map(t => ({
          source: t.source,
          source_trader_id: t.source_trader_id,
          handle: profileMap[t.source_trader_id]?.handle || null,
          avatar_url: profileMap[t.source_trader_id]?.avatar_url || null,
          roi: t.roi ? parseFloat(t.roi) : null,
          followers: t.followers ?? null,
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
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {traders.map((trader, index) => {
        const traderId = `${trader.source}-${trader.source_trader_id}`
        const displayName = trader.handle || trader.source_trader_id.slice(0, 8)
        const href = trader.handle ? `/trader/${trader.handle}` : `/trader/${trader.source_trader_id}`

        return (
          <Link
            key={traderId}
            href={href}
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
            {/* Rank */}
            <Text size="xs" weight="bold" style={{ color: index < 3 ? '#c9b8db' : tokens.colors.text.tertiary, width: 16 }}>
              {index + 1}
            </Text>

            {/* Name */}
            <Text size="sm" weight="semibold" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </Text>

            {/* ROI */}
            {trader.roi != null && (
              <Text
                size="xs"
                weight="bold"
                style={{
                  color: Number(trader.roi) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
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
  const escapeIlike = (s: string) => s.replace(/[%_\\]/g, c => `\\${c}`)
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
            query = query.or(`name.ilike.%${escapeIlike(debouncedQuery)}%,name_en.ilike.%${escapeIlike(debouncedQuery)}%`)
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
          query = query.or(`name.ilike.%${escapeIlike(debouncedQuery)}%,name_en.ilike.%${escapeIlike(debouncedQuery)}%`)
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
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.lg,
                textDecoration: 'none',
                color: tokens.colors.text.primary,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139,111,168,0.08), rgba(139,111,168,0.03))'
                e.currentTarget.style.borderColor = 'rgba(139,111,168,0.3)'
                e.currentTarget.style.transform = 'translateX(2px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.secondary
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.transform = 'translateX(0)'
              }}
            >
              <Box style={{
                width: 36,
                height: 36,
                borderRadius: tokens.radius.lg,
                background: 'linear-gradient(135deg, rgba(139,111,168,0.25), rgba(139,111,168,0.1))',
                border: `1px solid rgba(139,111,168,0.2)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}>
                {group.avatar_url ? (
                  <img src={group.avatar_url} alt={group.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Text size="sm" weight="bold" style={{ color: '#c9b8db' }}>
                    {group.name.charAt(0).toUpperCase()}
                  </Text>
                )}
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
                  {language === 'zh' ? group.name : (group.name_en || group.name)}
                </Text>
                {group.member_count != null && (
                  <Text size="xs" color="tertiary">
                    {group.member_count.toLocaleString()} {language === 'zh' ? '成员' : 'members'}
                  </Text>
                )}
              </Box>
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

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1400, margin: '0 auto' }}>
        <Box className="main-grid">
          {/* 左：热门交易员 + 小组推荐（仅桌面端显示） */}
          <Box as="section" className="hide-tablet" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
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
          </Box>

          {/* 中：帖子瀑布流 */}
          <Box as="section" style={{ minWidth: 0 }}>
            <Card title={language === 'zh' ? '推荐动态' : 'Recommended'}>
              <PostFeed layout="masonry" variant={loggedIn ? 'full' : 'compact'} initialPostId={initialPostId} />
            </Card>
          </Box>

          {/* 右：Pro功能 + 我的小组 + 市场数据（平板及以上显示） */}
          <Box as="section" className="hide-mobile" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {/* Pro功能 - pro会员不显示 */}
            {!isPro && (
              <ProFeaturesPanel compact />
            )}

            {/* 我的小组 */}
            <Card title={language === 'zh' ? '我的小组' : 'My Groups'}>
              <MyGroups />
            </Card>

            {/* 市场数据 */}
            <ErrorBoundary>
              <Suspense fallback={<SkeletonCard />}>
                <MarketPanel />
              </Suspense>
            </ErrorBoundary>
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
