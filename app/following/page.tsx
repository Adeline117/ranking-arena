'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { Box, Text } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import PullToRefreshWrapper from '@/app/components/ui/PullToRefreshWrapper'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { trackInteraction } from '@/lib/tracking'
import { features } from '@/lib/features'

// 平台配置
const sourceConfig: Record<string, { label: string; labelEn: string; color: string }> = {
  binance_futures: { label: 'Binance 合约', labelEn: 'Binance Futures', color: 'var(--color-chart-amber)' },
  binance_spot: { label: 'Binance 现货', labelEn: 'Binance Spot', color: 'var(--color-chart-amber)' },
  binance_web3: { label: 'Binance 链上', labelEn: 'Binance Web3', color: 'var(--color-chart-amber)' },
  bybit: { label: 'Bybit 合约', labelEn: 'Bybit Futures', color: 'var(--color-chart-orange)' },
  bitget_futures: { label: 'Bitget 合约', labelEn: 'Bitget Futures', color: 'var(--color-accent-success)' },
  bitget_spot: { label: 'Bitget 现货', labelEn: 'Bitget Spot', color: 'var(--color-accent-success)' },
  okx_web3: { label: 'OKX 链上', labelEn: 'OKX Web3', color: 'var(--color-text-primary)' },
  kucoin: { label: 'KuCoin 合约', labelEn: 'KuCoin Futures', color: 'var(--color-chart-teal)' },
  mexc: { label: 'MEXC 合约', labelEn: 'MEXC Futures', color: 'var(--color-chart-indigo)' },
  coinex: { label: 'CoinEx 合约', labelEn: 'CoinEx Futures', color: 'var(--color-chart-blue)' },
  gmx: { label: 'GMX 链上', labelEn: 'GMX DeFi', color: 'var(--color-chart-blue)' },
}

const getSourceDisplayName = (source: string, lang: string) =>
  lang === 'en'
    ? sourceConfig[source]?.labelEn || source
    : sourceConfig[source]?.label || source

const getSourceColor = (source: string) => sourceConfig[source]?.color || 'var(--color-text-secondary)'

// 统一的关注项类型
type FollowItem = {
  id: string
  handle: string
  type: 'trader' | 'user'
  avatar_url?: string
  bio?: string
  roi?: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  win_rate?: number
  followers?: number
  source?: string
  arena_score?: number
  followed_at?: string
}

type SortMode = 'recent' | 'roi' | 'score'

// ============================================
// 统计卡片组件
// ============================================

function StatCard({ label, value, color, subText }: {
  label: string
  value: string
  color?: string
  subText?: string
}) {
  return (
    <Box style={{
      flex: '1 1 140px',
      padding: tokens.spacing[3],
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      minWidth: 0,
    }}>
      <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>{label}</Text>
      <Text size="lg" weight="bold" style={{ color: color || tokens.colors.text.primary }}>
        {value}
      </Text>
      {subText && (
        <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>{subText}</Text>
      )}
    </Box>
  )
}

// ============================================
// 排序按钮组件
// ============================================

function SortButton({ label, active, onClick }: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.full,
        border: 'none',
        cursor: 'pointer',
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: active ? 600 : 400,
        background: active ? tokens.colors.accent.brand + '20' : 'transparent',
        color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary,
        transition: `all ${tokens.transition.base}`,
      }}
    >
      {label}
    </button>
  )
}

// ============================================
// ROI 显示组件（带变化趋势）
// ============================================

function RoiDisplay({ value, label }: { value?: number; label?: string }) {
  if (value === undefined || value === null) return null
  const isPositive = value >= 0
  return (
    <Box style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label && <Text size="xs" color="tertiary">{label}:</Text>}
      <Text size="xs" weight="semibold" style={{
        color: isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
      }}>
        {isPositive ? '+' : ''}{value.toFixed(2)}%
      </Text>
    </Box>
  )
}

// ============================================
// 主组件
// ============================================


export default function FollowingPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { email, userId, getAuthHeadersAsync } = useAuthSession()
  const [items, setItems] = useState<FollowItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [unfollowingId, setUnfollowingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const PAGE_SIZE = 50
  const offsetRef = useRef(0)

  // Inline unfollow with optimistic UI
  const handleUnfollow = useCallback(async (item: FollowItem, e: React.MouseEvent) => {
    e.stopPropagation()
    if (unfollowingId) return
    setUnfollowingId(item.id)

    // Snapshot current items for rollback (preserves order)
    const snapshot = items

    // Optimistic removal
    setItems(prev => prev.filter(i => i.id !== item.id))

    try {
      const authHeaders = await getAuthHeadersAsync()
      const csrfHeaders = getCsrfHeaders()
      // Use different API endpoint for traders vs users
      const url = item.type === 'user' ? '/api/users/follow' : '/api/follow'
      const reqBody = item.type === 'user'
        ? { followingId: item.id, action: 'unfollow' }
        : { traderId: item.id, action: 'unfollow' }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...csrfHeaders },
        body: JSON.stringify(reqBody),
      })

      if (!response.ok) {
        // Rollback to snapshot (preserves original order)
        setItems(snapshot)
        showToast(t('operationFailed'), 'error')
      } else {
        showToast(t('followingUnfollowed'), 'success')
      }
    } catch {
      // Rollback to snapshot (preserves original order)
      setItems(snapshot)
      showToast(t('operationFailed'), 'error')
    } finally {
      setUnfollowingId(null)
    }
  }, [items, unfollowingId, getAuthHeadersAsync, showToast, t])

  // userId now comes from useAuthSession directly

  const fetchFollowing = useCallback(async (offset: number, append: boolean) => {
    if (!userId) return
    try {
      const response = await fetch(`/api/following?userId=${userId}&limit=${PAGE_SIZE}&offset=${offset}`)
      const data = await response.json()
      
      if (!response.ok) {
        logger.error('Error fetching following:', data.error)
        if (!append) setItems([])
        showToast(t('loadFollowingFailed'), 'error')
        return
      }

      const newItems: FollowItem[] = data.items || []
      if (append) {
        setItems(prev => [...prev, ...newItems])
      } else {
        setItems(newItems)
      }
      offsetRef.current = offset + newItems.length
      setHasMore(data.hasMore === true)
    } catch (error) {
      logger.error('Error loading following:', error)
      if (!append) setItems([])
      showToast(t('loadFollowingFailed'), 'error')
    }
  }, [userId, showToast, t])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    await fetchFollowing(offsetRef.current, true)
    setLoadingMore(false)
  }, [loadingMore, hasMore, fetchFollowing])

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      setLoading(true)
      offsetRef.current = 0
      await fetchFollowing(0, false)
      setLoading(false)
    }

    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchFollowing excluded to avoid refetch loop on callback identity change
  }, [userId])

  // Filter out user follows when social is off
  const visibleItems = useMemo(() =>
    features.social ? items : items.filter(i => i.type === 'trader'),
  [items])

  // 可用平台列表
  const availablePlatforms = useMemo(() => {
    const platforms = new Set<string>()
    visibleItems.forEach(i => { if (i.source) platforms.add(i.source) })
    return Array.from(platforms).sort()
  }, [visibleItems])

  // 排序后的列表
  const sortedItems = useMemo(() => {
    let filtered = [...visibleItems]
    // 搜索筛选
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      filtered = filtered.filter(i => (i.handle || '').toLowerCase().includes(q))
    }
    // 平台筛选 (ignore 'user' filter when social is off)
    if (platformFilter !== 'all' && !(platformFilter === 'user' && !features.social)) {
      filtered = filtered.filter(i => i.source === platformFilter || (platformFilter === 'user' && i.type === 'user'))
    }
    const sorted = filtered
    switch (sortMode) {
      case 'roi':
        sorted.sort((a, b) => (b.roi || 0) - (a.roi || 0))
        break
      case 'score':
        sorted.sort((a, b) => (b.arena_score || 0) - (a.arena_score || 0))
        break
      case 'recent':
      default:
        sorted.sort((a, b) => {
          const timeA = a.followed_at ? new Date(a.followed_at).getTime() : 0
          const timeB = b.followed_at ? new Date(b.followed_at).getTime() : 0
          return timeB - timeA
        })
        break
    }
    return sorted
  }, [visibleItems, sortMode, searchQuery, platformFilter])

  // 汇总统计（基于筛选后的列表，与显示一致）
  const stats = useMemo(() => {
    const traders = sortedItems.filter((i) => i.type === 'trader')
    const users = sortedItems.filter((i) => i.type === 'user')

    if (traders.length === 0) {
      return {
        traderCount: 0,
        userCount: users.length,
        avgRoi: 0,
        bestPerformer: null as FollowItem | null,
        worstPerformer: null as FollowItem | null,
      }
    }

    const rois = traders.map((t) => t.roi || 0)
    const avgRoi = rois.reduce((sum, r) => sum + r, 0) / rois.length

    const sortedByRoi = [...traders].sort((a, b) => (b.roi || 0) - (a.roi || 0))
    const bestPerformer = sortedByRoi[0]
    const worstPerformer = sortedByRoi[sortedByRoi.length - 1]

    return {
      traderCount: traders.length,
      userCount: users.length,
      avgRoi,
      bestPerformer,
      worstPerformer,
    }
  }, [sortedItems])

  const handleItemClick = (item: FollowItem) => {
    trackInteraction({ action: 'click', target_type: item.type, target_id: item.id })
    if (item.type === 'trader') {
      router.push(`/trader/${encodeURIComponent(item.handle)}?source=${item.source || 'binance'}`)
    } else {
      router.push(`/u/${encodeURIComponent(item.handle)}`)
    }
  }

  // 未登录
  if (!userId && !loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            {t('myFollowing')}
          </Text>
          <EmptyState
            title={t('loginRequired')}
            description={t('loginToFollow')}
            action={
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center', flexWrap: 'wrap' }}>
                <Link
                  href="/login?redirect=/following"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 44,
                    padding: '10px 24px',
                    background: tokens.colors.accent.brand,
                    color: tokens.colors.white,
                    borderRadius: tokens.radius.md,
                    textDecoration: 'none',
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  {t('goToLogin')}
                </Link>
                <Link
                  href="/rankings"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 44,
                    padding: '10px 24px',
                    background: tokens.colors.bg.tertiary,
                    color: tokens.colors.text.primary,
                    borderRadius: tokens.radius.md,
                    textDecoration: 'none',
                    fontWeight: 600,
                    fontSize: 14,
                  }}
                >
                  {t('goToRankings')}
                </Link>
              </Box>
            }
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <PullToRefreshWrapper onRefresh={async () => { await fetchFollowing(0, false) }}>
      <Box className="has-mobile-nav" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Breadcrumb items={[{ label: t('myFollowing') }]} />
        {/* 页面标题 */}
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
          {t('myFollowing')}
        </Text>

        {loading ? (
          <ListSkeleton count={5} gap={12} />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            title={t('noFollowing')}
            description={t('noFollowingCta')}
            action={
              <Link
                href="/rankings"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 44,
                  padding: '10px 24px',
                  background: tokens.colors.accent.brand,
                  color: tokens.colors.white,
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                {t('goToRankings')}
              </Link>
            }
          />
        ) : (
          <>
            {/* ============= 汇总统计卡片 ============= */}
            <Box style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: tokens.spacing[3],
              marginBottom: tokens.spacing[5],
              animation: 'fadeIn 0.3s ease-out',
            }}>
              <StatCard
                label={t('totalFollowing')}
                value={`${stats.traderCount + stats.userCount}`}
                subText={features.social
                  ? `${stats.traderCount} ${t('traders')} · ${stats.userCount} ${t('users')}`
                  : `${stats.traderCount} ${t('traders')}`}
              />
              <StatCard
                label={t('avgRoi')}
                value={stats.traderCount > 0
                  ? `${stats.avgRoi >= 0 ? '+' : ''}${stats.avgRoi.toFixed(2)}%`
                  : '—'
                }
                color={stats.avgRoi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}
              />
              <StatCard
                label={t('bestPerformer')}
                value={stats.bestPerformer
                  ? `${(stats.bestPerformer.roi || 0) >= 0 ? '+' : ''}${(stats.bestPerformer.roi || 0).toFixed(2)}%`
                  : '—'
                }
                color={tokens.colors.accent.success}
                subText={stats.bestPerformer?.handle}
              />
              <StatCard
                label={t('worstPerformer')}
                value={stats.worstPerformer
                  ? `${(stats.worstPerformer.roi || 0) >= 0 ? '+' : ''}${(stats.worstPerformer.roi || 0).toFixed(2)}%`
                  : '—'
                }
                color={tokens.colors.accent.error}
                subText={stats.worstPerformer?.handle}
              />
            </Box>

            {/* ============= 搜索 + 平台筛选 ============= */}
            <Box style={{
              display: 'flex',
              gap: tokens.spacing[3],
              marginBottom: tokens.spacing[3],
              flexWrap: 'wrap',
            }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('followingSearchPlaceholder')}
                style={{
                  flex: '1 1 200px',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                  minHeight: 40,
                }}
              />
              <select
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  cursor: 'pointer',
                  minHeight: 40,
                }}
              >
                <option value="all">{t('followingAllPlatforms')}</option>
                {features.social && (
                  <option value="user">{t('users')}</option>
                )}
                {availablePlatforms.map(p => (
                  <option key={p} value={p}>{getSourceDisplayName(p, language)}</option>
                ))}
              </select>
            </Box>

            {/* ============= 排序控制 ============= */}
            <Box style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              marginBottom: tokens.spacing[3],
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.full,
              width: 'fit-content',
            }}>
              <SortButton
                label={t('sortByRecent')}
                active={sortMode === 'recent'}
                onClick={() => setSortMode('recent')}
              />
              <SortButton
                label={t('sortByRoi')}
                active={sortMode === 'roi'}
                onClick={() => setSortMode('roi')}
              />
              <SortButton
                label={t('sortByScore')}
                active={sortMode === 'score'}
                onClick={() => setSortMode('score')}
              />
            </Box>

            {/* ============= 关注列表 ============= */}
            <Box style={{
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing[2],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              padding: tokens.spacing[2],
              animation: 'fadeIn 0.3s ease-out',
            }}>
              {sortedItems.map((item) => (
                <Box
                  key={`${item.type}-${item.id}`}
                  onClick={() => handleItemClick(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.md,
                    cursor: 'pointer',
                    transition: `background ${tokens.transition.base}`,
                    background: 'transparent',
                  }}
                  className="hover-bg-tertiary"
                >
                  {/* 头像 */}
                  <Avatar
                    userId={item.id}
                    name={item.handle}
                    avatarUrl={item.avatar_url}
                    size={48}
                    style={{ flexShrink: 0 }}
                  />

                  {/* 信息区域 */}
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                      <Text size="sm" weight="semibold" style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {item.handle}
                      </Text>
                      {/* 类型标签 */}
                      <span style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: tokens.radius.sm,
                        background: item.type === 'trader'
                          ? getSourceColor(item.source || 'binance') + '20'
                          : tokens.colors.accent.brand + '20',
                        color: item.type === 'trader'
                          ? getSourceColor(item.source || 'binance')
                          : tokens.colors.accent.brand,
                        fontWeight: 500,
                      }}>
                        {item.type === 'trader'
                          ? getSourceDisplayName(item.source || 'binance', language)
                          : t('followingUserType')}
                      </span>
                    </Box>

                    {/* 交易员：ROI + Arena Score 行 */}
                    {item.type === 'trader' ? (
                      <Box style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[3],
                        marginTop: 4,
                        flexWrap: 'wrap',
                      }}>
                        <RoiDisplay value={item.roi} label="ROI" />
                        {item.roi_7d !== undefined && (
                          <RoiDisplay value={item.roi_7d} label="7D" />
                        )}
                        {item.arena_score !== undefined && item.arena_score > 0 && (
                          <Text size="xs" color="tertiary">
                            Score: <span style={{ color: tokens.colors.accent.brand, fontWeight: 500 }}>
                              {item.arena_score.toFixed(1)}
                            </span>
                          </Text>
                        )}
                        {item.win_rate !== undefined && item.win_rate > 0 && (
                          <Text size="xs" color="tertiary">
                            {t('winRate')}: {item.win_rate.toFixed(1)}%
                          </Text>
                        )}
                        {item.followers !== undefined && item.followers > 0 && (
                          <Text size="xs" color="tertiary">
                            {t('copiers')}: {item.followers.toLocaleString()}
                          </Text>
                        )}
                      </Box>
                    ) : item.bio ? (
                      <Text size="xs" color="tertiary" style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 4,
                      }}>
                        {item.bio}
                      </Text>
                    ) : null}
                  </Box>

                  {/* 右侧：Arena Score + 取消关注 + 箭头 */}
                  <Box style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    flexShrink: 0,
                  }}>
                    {item.type === 'trader' && item.arena_score !== undefined && item.arena_score > 0 && (
                      <Box style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        background: tokens.colors.accent.brand + '10',
                        borderRadius: tokens.radius.md,
                        minWidth: 50,
                      }}>
                        <Text size="xs" color="tertiary" style={{ fontSize: 10, lineHeight: 1 }}>Score</Text>
                        <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.brand }}>
                          {item.arena_score.toFixed(0)}
                        </Text>
                      </Box>
                    )}
                    <button
                      onClick={(e) => handleUnfollow(item, e)}
                      disabled={unfollowingId === item.id}
                      title={t('followingUnfollowTitle')}
                      style={{
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.md,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: 'transparent',
                        color: tokens.colors.text.tertiary,
                        fontSize: tokens.typography.fontSize.xs,
                        cursor: unfollowingId === item.id ? 'not-allowed' : 'pointer',
                        opacity: unfollowingId === item.id ? 0.5 : 1,
                        transition: `all ${tokens.transition.base}`,
                        whiteSpace: 'nowrap',
                      }}
                      className="hover-unfollow"
                    >
                      {unfollowingId === item.id
                        ? t('followingUnfollowing')
                        : t('followingUnfollowTitle')
                      }
                    </button>
                    <Box style={{ color: tokens.colors.text.tertiary }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6"></polyline>
                      </svg>
                    </Box>
                  </Box>
                </Box>
              ))}
            </Box>

            {/* ============= 加载更多 ============= */}
            {hasMore && (
              <Box style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}>
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                    borderRadius: tokens.radius.lg,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: loadingMore ? 'not-allowed' : 'pointer',
                    opacity: loadingMore ? 0.6 : 1,
                  }}
                >
                  {loadingMore
                    ? t('loading')
                    : t('loadMore')}
                </button>
              </Box>
            )}

            {/* ============= 发现更多交易员 ============= */}
            <Box style={{
              marginTop: tokens.spacing[6],
              padding: tokens.spacing[5],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              textAlign: 'center',
            }}>
              <Text size="base" weight="semibold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('followingDiscoverTitle')}
              </Text>
              <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
                {t('followingDiscoverDesc')}
              </Text>
              <Link
                href="/rankings"
                style={{
                  display: 'inline-block',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                  borderRadius: tokens.radius.lg,
                  background: tokens.colors.accent.brand,
                  color: tokens.colors.white,
                  textDecoration: 'none',
                  fontWeight: 600,
                  fontSize: tokens.typography.fontSize.sm,
                  transition: `opacity ${tokens.transition.base}`,
                }}
              >
                {t('followingViewRankings')}
              </Link>
            </Box>
          </>
        )}
      </Box>
      </PullToRefreshWrapper>
    </Box>
  )
}
