'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useState, Suspense, lazy, useCallback } from 'react'
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

interface Group {
  id: string
  name: string
  name_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
}

interface PopularTrader {
  source: string
  source_trader_id: string
  handle?: string | null
  avatar_url?: string | null
  followers?: number | null
  roi?: number | null
}

// Bilingual text helper
function t(zh: string, en: string, language: string): string {
  return language === 'zh' ? zh : en
}

// Shared group avatar component
interface GroupAvatarProps {
  avatarUrl?: string | null
  name: string
  size?: number
}

function GroupAvatar({ avatarUrl, name, size = 32 }: GroupAvatarProps): React.ReactElement {
  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.md,
        background: 'linear-gradient(135deg, rgba(139,111,168,0.2), rgba(139,111,168,0.1))',
        border: `1px solid ${tokens.colors.border.primary}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {avatarUrl ? (
        <Image src={avatarUrl} alt={name} width={size} height={size} style={{ width: '100%', height: '100%', objectFit: 'cover' }} unoptimized />
      ) : (
        <Text size="xs" weight="bold" style={{ color: '#c9b8db' }}>
          {name.charAt(0).toUpperCase()}
        </Text>
      )}
    </Box>
  )
}

// Shared hover link style handler
function createHoverHandlers(): {
  onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => void
  onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => void
} {
  return {
    onMouseEnter: (e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary },
    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
  }
}

const hoverHandlers = createHoverHandlers()

// Loading/empty/error state component
interface DataStateProps {
  loading: boolean
  error: string | null
  isEmpty: boolean
  language: string
  emptyMessage?: string
  children: React.ReactNode
}

function DataState({ loading, error, isEmpty, language, emptyMessage, children }: DataStateProps): React.ReactElement {
  if (loading) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {t('加载中...', 'Loading...', language)}
      </Text>
    )
  }
  if (error) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" style={{ color: '#DC2626', marginBottom: tokens.spacing[2] }}>{error}</Text>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          {t('重试', 'Retry', language)}
        </Button>
      </Box>
    )
  }
  if (isEmpty) {
    return (
      <Text size="sm" color="tertiary" style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        {emptyMessage || t('暂无数据', 'No data available', language)}
      </Text>
    )
  }
  return <>{children}</>
}

function PopularTraders(): React.ReactElement {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const [traders, setTraders] = useState<PopularTrader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadTraders(): Promise<void> {
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
          const errorMsg = t('加载热门交易员失败，请稍后重试', 'Failed to load popular traders, please try again later', language)
          setError(errorMsg)
          showToast(errorMsg, 'error')
          return
        }

        // Deduplicate by source:source_trader_id
        const seen = new Set<string>()
        const dedupedData = (data || []).filter(row => {
          const key = `${row.source}:${row.source_trader_id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, 10)

        // Fetch handles from trader_sources
        const traderKeys = dedupedData.map(item => item.source_trader_id)
        const profileMap: Record<string, string | null> = {}
        if (traderKeys.length > 0) {
          const { data: sources } = await supabase
            .from('trader_sources')
            .select('source_trader_id, handle')
            .in('source_trader_id', traderKeys)
          sources?.forEach(s => { profileMap[s.source_trader_id] = s.handle })
        }

        setTraders(dedupedData.map(item => ({
          source: item.source,
          source_trader_id: item.source_trader_id,
          handle: profileMap[item.source_trader_id] || null,
          avatar_url: null,
          roi: item.roi ? parseFloat(item.roi) : null,
          followers: item.followers ?? null,
        })))
      } catch (err) {
        const errorMsg = t('网络错误，请检查网络连接后重试', 'Network error, please check your connection and try again', language)
        setError(errorMsg)
        showToast(errorMsg, 'error')
        console.error('Error loading popular traders:', err)
      } finally {
        setLoading(false)
      }
    }
    loadTraders()
  }, [language, showToast])

  return (
    <DataState loading={loading} error={error} isEmpty={traders.length === 0} language={language}>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {traders.map((trader, index) => {
          const displayName = trader.handle || trader.source_trader_id.slice(0, 8)
          const href = trader.handle ? `/trader/${trader.handle}` : `/trader/${trader.source_trader_id}`
          const roiValue = trader.roi != null ? Number(trader.roi) : null

          return (
            <Link
              key={`${trader.source}-${trader.source_trader_id}`}
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
              {...hoverHandlers}
            >
              <Text size="xs" weight="bold" style={{ color: index < 3 ? '#c9b8db' : tokens.colors.text.tertiary, width: 16 }}>
                {index + 1}
              </Text>
              <Text size="sm" weight="semibold" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayName}
              </Text>
              {roiValue !== null && (
                <Text size="xs" weight="bold" style={{ color: roiValue >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
                  {roiValue >= 0 ? '+' : ''}{roiValue.toFixed(1)}%
                </Text>
              )}
            </Link>
          )
        })}
      </Box>
    </DataState>
  )
}

// Shared group link component
interface GroupLinkProps {
  group: Group
  language: string
}

function GroupLink({ group, language }: GroupLinkProps): React.ReactElement {
  const displayName = language === 'zh' ? group.name : (group.name_en || group.name)
  return (
    <Link
      href={`/groups/${group.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[2]} ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.md,
        textDecoration: 'none',
        color: tokens.colors.text.primary,
        transition: 'all 0.15s ease',
      }}
      {...hoverHandlers}
    >
      <GroupAvatar avatarUrl={group.avatar_url} name={group.name} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="xs" weight="semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayName}
        </Text>
        {group.member_count != null && (
          <Text size="xs" color="tertiary" style={{ fontSize: 10 }}>
            {group.member_count.toLocaleString()} {t('成员', 'members', language)}
          </Text>
        )}
      </Box>
    </Link>
  )
}

type GroupTab = 'all' | 'mine' | 'hot'

function GroupsList(): React.ReactElement {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeGroupTab, setActiveGroupTab] = useState<GroupTab>('all')
  const [userId, setUserId] = useState<string | null>(null)
  const [myGroupIds, setMyGroupIds] = useState<string[]>([])

  const escapeIlike = useCallback((s: string) => s.replace(/[%_\\]/g, c => `\\${c}`), [])

  // Get user for "Mine" tab
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // Load user's group memberships
  useEffect(() => {
    if (!userId) return
    supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId)
      .then(({ data }) => setMyGroupIds((data || []).map(m => m.group_id)))
  }, [userId])

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Load groups
  useEffect(() => {
    async function loadGroups(): Promise<void> {
      try {
        setLoading(true)
        setError(null)

        // "Mine" tab early return
        if (activeGroupTab === 'mine' && myGroupIds.length === 0) {
          setGroups([])
          setLoading(false)
          return
        }

        // Build base query
        const buildQuery = (groupIds?: string[]) => {
          let query = supabase
            .from('groups')
            .select('id, name, avatar_url, member_count, name_en')
            .order('member_count', { ascending: false, nullsFirst: false })
            .limit(3)
          if (groupIds) query = query.in('id', groupIds)
          if (debouncedQuery) {
            query = query.or(`name.ilike.%${escapeIlike(debouncedQuery)}%,name_en.ilike.%${escapeIlike(debouncedQuery)}%`)
          }
          return query
        }

        // "Hot" tab: rank by recent activity
        if (activeGroupTab === 'hot') {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
          const { data: recentPosts } = await supabase
            .from('posts')
            .select('group_id')
            .gte('created_at', sevenDaysAgo)
            .not('group_id', 'is', null)

          const activityMap: Record<string, number> = {}
          recentPosts?.forEach(p => { if (p.group_id) activityMap[p.group_id] = (activityMap[p.group_id] || 0) + 1 })

          const activeGroupIds = Object.keys(activityMap)
          const { data, error: supabaseError } = activeGroupIds.length > 0
            ? await buildQuery(activeGroupIds)
            : await buildQuery()

          if (supabaseError) throw supabaseError

          const sorted = activeGroupIds.length > 0
            ? (data || []).sort((a, b) => (activityMap[b.id] || 0) - (activityMap[a.id] || 0))
            : data || []
          setGroups(sorted)
          return
        }

        // "All" and "Mine" tabs
        const groupIds = activeGroupTab === 'mine' ? myGroupIds : undefined
        const { data, error: supabaseError } = await buildQuery(groupIds)
        if (supabaseError) throw supabaseError
        setGroups(data || [])
      } catch (err) {
        setError(t('加载失败', 'Failed to load', language))
        showToast(t('加载小组列表失败', 'Failed to load groups', language), 'error')
        console.error('Error loading groups:', err)
      } finally {
        setLoading(false)
      }
    }
    loadGroups()
  }, [debouncedQuery, activeGroupTab, myGroupIds, language, showToast, escapeIlike])

  const getEmptyMessage = (): string => {
    if (debouncedQuery) return t('未找到匹配的小组', 'No groups found', language)
    if (activeGroupTab === 'mine') return t('还未加入任何小组', 'Not joined any groups', language)
    return t('暂无小组', 'No groups available', language)
  }

  const tabLabels: Record<GroupTab, string> = {
    all: t('全部', 'All', language),
    mine: t('我的', 'Mine', language),
    hot: t('热门', 'Hot', language),
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={t('搜索小组...', 'Search groups...', language)}
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
            {tabLabels[tab]}
          </button>
        ))}
      </Box>

      <DataState loading={loading} error={error} isEmpty={groups.length === 0} language={language} emptyMessage={getEmptyMessage()}>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          {groups.map((group) => <GroupLink key={group.id} group={group} language={language} />)}
        </Box>
      </DataState>
    </Box>
  )
}

function MyGroups(): React.ReactElement {
  const { language } = useLanguage()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMyGroups(): Promise<void> {
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

      const { data: groupsData } = await supabase
        .from('groups')
        .select('id, name, name_en, avatar_url, member_count')
        .in('id', memberships.map(m => m.group_id))

      setGroups(groupsData || [])
      setLoading(false)
    }
    loadMyGroups()
  }, [])

  return (
    <DataState
      loading={loading}
      error={null}
      isEmpty={groups.length === 0}
      language={language}
      emptyMessage={t('还未加入任何小组', 'Not joined any groups yet', language)}
    >
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
            {...hoverHandlers}
          >
            <GroupAvatar avatarUrl={group.avatar_url} name={group.name} />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text size="xs" weight="bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {language === 'zh' ? group.name : (group.name_en || group.name)}
              </Text>
            </Box>
          </Link>
        ))}
      </Box>
    </DataState>
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
              <PostFeed layout="masonry" variant={loggedIn ? 'full' : 'compact'} initialPostId={initialPostId} showRefreshButton />
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
