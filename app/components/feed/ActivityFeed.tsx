'use client'

/**
 * ActivityFeed - scrollable timeline of auto-generated trader activity events.
 *
 * Features:
 *   - Platform filter tabs
 *   - Cursor-based infinite scroll (Load More button)
 *   - Compact, high-density layout
 *   - Real-time feel: newest first
 */

import { useState, useMemo, useEffect } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { STALE_RELAXED } from '@/lib/hooks/cache-presets'
import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import type { TraderActivity, ActivityType } from '@/lib/types/activities'
import { ACTIVITY_META } from '@/lib/types/activities'
import ActivityFeedItem, { activityTypeLabel } from './ActivityFeedItem'
import { formatTimeAgo } from '@/lib/utils/date'

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

const _PLATFORM_OPTIONS: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'Binance', value: 'binance_futures' },
  { label: 'Bybit', value: 'bybit' },
  { label: 'OKX', value: 'okx_futures' },
  { label: 'Bitget', value: 'bitget_futures' },
  { label: 'Hyperliquid', value: 'hyperliquid' },
  { label: 'GMX', value: 'gmx' },
]

const _TYPE_OPTIONS: { label: string; value: ActivityType | null }[] = [
  { label: 'All', value: null },
  ...Object.entries(ACTIVITY_META).map(([key, meta]) => ({
    label: meta.label,
    value: key as ActivityType,
  })),
]

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ActivityFeedProps {
  /** Initial server-fetched activities */
  initialActivities: TraderActivity[]
  initialHasMore: boolean
  initialNextCursor: string | null
  /** Whether the SSR seed is a verified response or a failed placeholder. */
  initialStatus?: 'success' | 'error'
  /** If provided, restrict feed to this platform (no platform filter shown) */
  fixedPlatform?: string
  /** If provided, restrict feed to this handle (trader profile mode) */
  fixedHandle?: string
  /** Title shown at the top */
  title?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ActivityFeed({
  initialActivities,
  initialHasMore,
  initialNextCursor,
  initialStatus = 'success',
  fixedPlatform,
  fixedHandle,
  title,
}: ActivityFeedProps) {
  const { t, language } = useLanguage()
  const { isLoggedIn, authChecked, getAuthHeadersAsync } = useAuthSession()
  const localTitle = title || t('activityFeedTitle')

  // Following / Discover view. Personalized ("Following") is only offered to
  // logged-in users and only when this is the main feed (no fixed platform/handle
  // profile mode). Default = Discover (global) so guests + zero-follow users never
  // hit an empty first paint; the user's last choice is remembered per browser.
  const showViewTabs = !fixedPlatform && !fixedHandle
  const [view, setView] = useState<'discover' | 'following'>('discover')

  // Restore the remembered view once auth is known (logged-in only).
  useEffect(() => {
    if (!showViewTabs || !authChecked || !isLoggedIn) return
    try {
      if (localStorage.getItem('feedView') === 'following') setView('following')
    } catch {
      /* localStorage unavailable — keep Discover default */
    }
  }, [showViewTabs, authChecked, isLoggedIn])

  // If the user logs out while on Following, drop back to Discover.
  useEffect(() => {
    if (authChecked && !isLoggedIn && view === 'following') setView('discover')
  }, [authChecked, isLoggedIn, view])

  const following = showViewTabs && isLoggedIn && view === 'following'

  const selectView = (next: 'discover' | 'following') => {
    setView(next)
    try {
      localStorage.setItem('feedView', next)
    } catch {
      /* ignore */
    }
  }

  const platformOptions = useMemo(
    () => [
      { label: t('activityFilterAll'), value: null as string | null },
      { label: 'Binance', value: 'binance_futures' },
      { label: 'Bybit', value: 'bybit' },
      { label: 'OKX', value: 'okx_futures' },
      { label: 'Bitget', value: 'bitget_futures' },
      { label: 'Hyperliquid', value: 'hyperliquid' },
      { label: 'GMX', value: 'gmx' },
    ],
    [t]
  )

  const typeOptions = useMemo(
    () => [
      { label: t('activityFilterAll'), value: null as ActivityType | null },
      ...Object.keys(ACTIVITY_META).map((key) => ({
        label: activityTypeLabel(key as ActivityType, t),
        value: key as ActivityType,
      })),
    ],
    [t]
  )

  const [platform, setPlatform] = useState<string | null>(fixedPlatform ?? null)
  const [typeFilter, setTypeFilter] = useState<ActivityType | null>(null)

  // React Query infinite scroll — replaces manual fetch + useState
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useInfiniteQuery({
    queryKey: ['activities', platform, fixedHandle, following],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (platform) params.set('platform', platform)
      if (fixedHandle) params.set('handle', fixedHandle)
      if (pageParam) params.set('cursor', pageParam)
      if (following) params.set('following', '1')
      // Following mode needs the auth token so the API can resolve the user's follows.
      const headers = following ? await getAuthHeadersAsync() : undefined
      const res = await fetch(`/api/feed/activities?${params}`, headers ? { headers } : undefined)
      if (!res.ok) throw new Error('Failed to load activities')
      const json = await res.json()
      return json.data as {
        activities: TraderActivity[]
        pagination: { hasMore: boolean; nextCursor: string | null }
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore ? lastPage.pagination.nextCursor : undefined,
    // Seed SSR data ONLY for the query state it was fetched under (platform at
    // its initial value). queryKey includes `platform`, so switching filter tabs
    // creates a NEW query — unconditionally providing initialData would re-seed
    // the same unfiltered SSR page into every new key with dataUpdatedAt=now,
    // marking it fresh within staleTime and suppressing the filtered fetch.
    initialData:
      initialStatus === 'success' && !following && platform === (fixedPlatform ?? null)
        ? {
            pages: [
              {
                activities: initialActivities,
                pagination: { hasMore: initialHasMore, nextCursor: initialNextCursor },
              },
            ],
            pageParams: [null as string | null],
          }
        : undefined,
    staleTime: STALE_RELAXED,
    refetchOnWindowFocus: false,
  })

  const error = queryError ? t('loadFailed') : null
  const activities = data?.pages.flatMap((p) => p.activities) ?? []
  const hasMore = hasNextPage ?? false

  const handlePlatformChange = (newPlatform: string | null) => {
    if (fixedPlatform) return
    setPlatform(newPlatform)
    setTypeFilter(null)
  }

  const handleLoadMore = () => {
    if (hasMore && !isFetchingNextPage) fetchNextPage()
  }

  // Apply local type filter on top of fetched data
  const visibleActivities = typeFilter
    ? activities.filter((a) => a.activity_type === typeFilter)
    : activities

  // Honest freshness: only show the pulsing "Live" badge when the newest event is
  // actually recent (< 1h). Otherwise show "Updated <time ago>" so a stalled
  // generation pipeline (feed was months behind) no longer claims to be live (U8-7).
  const newestAt = activities[0]?.occurred_at
  const isLive = newestAt ? Date.now() - new Date(newestAt).getTime() < 60 * 60 * 1000 : false

  return (
    <div
      style={{
        background: `linear-gradient(145deg, ${alpha(tokens.colors.bg.secondary, 97)} 0%, ${alpha(tokens.colors.bg.primary, 94)} 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${alpha(tokens.colors.border.primary, 38)}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
          borderBottom: `1px solid ${alpha(tokens.colors.border.primary, 25)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[3],
          flexWrap: 'wrap',
          background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <h1
            style={{
              fontSize: tokens.typography.fontSize.lg,
              fontWeight: tokens.typography.fontWeight.black,
              color: tokens.colors.text.primary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              margin: 0,
            }}
          >
            {localTitle}
          </h1>
          {visibleActivities.length > 0 && (
            <span
              style={{
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
                color: 'var(--color-accent-primary)',
                background: 'var(--color-accent-primary)20',
                padding: '2px 8px',
                borderRadius: tokens.radius.full,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {visibleActivities.length}
            </span>
          )}
        </div>

        {/* Freshness indicator — pulsing "Live" only when data is actually recent */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: isLive ? 'var(--color-accent-success)' : tokens.colors.text.tertiary,
              boxShadow: isLive ? '0 0 6px var(--color-accent-success)' : 'none',
              display: 'inline-block',
              animation: isLive ? 'pulse 2s infinite' : 'none',
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {isLive
              ? t('activityFeedLive')
              : newestAt
                ? `${t('activityFeedUpdatedPrefix')} ${formatTimeAgo(newestAt, language)}`
                : error
                  ? t('loadFailed')
                  : t('activityFeedLive')}
          </span>
        </div>
      </div>

      {/* Following / Discover view tabs (logged-in users only) */}
      {showViewTabs && isLoggedIn && (
        <div
          role="tablist"
          aria-label={t('activityFeedTitle')}
          style={{
            display: 'flex',
            gap: 4,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${alpha(tokens.colors.border.primary, 19)}`,
          }}
        >
          <ViewTab
            label={t('activityFeedTabFollowing')}
            active={view === 'following'}
            onClick={() => selectView('following')}
          />
          <ViewTab
            label={t('activityFeedTabDiscover')}
            active={view === 'discover'}
            onClick={() => selectView('discover')}
          />
        </div>
      )}

      {/* Platform filter */}
      {!fixedPlatform && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${alpha(tokens.colors.border.primary, 19)}`,
            overflowX: 'auto',
          }}
        >
          {platformOptions.map((opt) => (
            <FilterChip
              key={opt.label}
              label={opt.label}
              active={platform === opt.value}
              onClick={() => handlePlatformChange(opt.value)}
            />
          ))}
        </div>
      )}

      {/* Activity type filter */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${alpha(tokens.colors.border.primary, 13)}`,
          overflowX: 'auto',
        }}
      >
        {typeOptions.map((opt) => (
          <FilterChip
            key={opt.label}
            label={opt.label}
            active={typeFilter === opt.value}
            onClick={() => setTypeFilter(opt.value)}
            small
          />
        ))}
      </div>

      {/* Activity list */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {visibleActivities.length === 0 && !loading && !error ? (
          following ? (
            // Personalized feed empty: no follows yet, or followed traders were
            // quiet this window. Nudge toward Discover instead of a dead-end.
            <div
              style={{
                padding: tokens.spacing[12],
                textAlign: 'center',
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[3],
              }}
            >
              <span style={{ maxWidth: 340, lineHeight: 1.5 }}>
                {t('activityFeedFollowingEmpty')}
              </span>
              <button
                onClick={() => selectView('discover')}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                  borderRadius: tokens.radius.lg,
                  border: 'none',
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.medium,
                  cursor: 'pointer',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
              >
                {t('activityFeedFollowingEmptyCta')}
              </button>
            </div>
          ) : (
            <div
              style={{
                padding: tokens.spacing[12],
                textAlign: 'center',
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {t('activityFeedEmpty')}
            </div>
          )
        ) : (
          visibleActivities.map((activity, idx) => (
            <div
              key={activity.id}
              style={{
                borderBottom:
                  idx < visibleActivities.length - 1
                    ? `1px solid ${alpha(tokens.colors.border.primary, 13)}`
                    : 'none',
              }}
            >
              <ActivityFeedItem activity={activity} />
            </div>
          ))
        )}

        {/* Load more */}
        {hasMore && !typeFilter && (
          <div
            style={{
              padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
              borderTop: `1px solid ${alpha(tokens.colors.border.primary, 13)}`,
              textAlign: 'center',
            }}
          >
            <button
              onClick={handleLoadMore}
              disabled={loading}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${alpha(tokens.colors.border.primary, 38)}`,
                background: loading ? tokens.colors.bg.tertiary : tokens.colors.bg.secondary,
                color: loading ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {loading ? t('activityFeedLoading') : t('activityFeedLoadMore')}
            </button>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: tokens.spacing[3],
              textAlign: 'center',
              color: tokens.colors.accent.error,
              fontSize: tokens.typography.fontSize.sm,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: tokens.spacing[2],
            }}
          >
            <span>{error}</span>
            <button
              onClick={() => void refetch()}
              disabled={isFetching}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                background: tokens.colors.accent.primary,
                color: tokens.colors.white,
                border: 'none',
                borderRadius: tokens.radius.md,
                cursor: isFetching ? 'wait' : 'pointer',
                opacity: isFetching ? 0.65 : 1,
                fontSize: tokens.typography.fontSize.sm,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {t('tryAgain')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ViewTab — Following / Discover segmented control
// ---------------------------------------------------------------------------

interface ViewTabProps {
  label: string
  active: boolean
  onClick: () => void
}

function ViewTab({ label, active, onClick }: ViewTabProps) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
        borderRadius: tokens.radius.lg,
        border: active
          ? '1px solid var(--color-accent-primary)'
          : `1px solid ${alpha(tokens.colors.border.primary, 25)}`,
        background: active ? alpha(tokens.colors.accent.primary, 12) : 'transparent',
        color: active ? 'var(--color-accent-primary)' : tokens.colors.text.secondary,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: active
          ? tokens.typography.fontWeight.bold
          : tokens.typography.fontWeight.medium,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
        transition: 'all 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// FilterChip
// ---------------------------------------------------------------------------

interface FilterChipProps {
  label: string
  active: boolean
  onClick: () => void
  small?: boolean
}

function FilterChip({ label, active, onClick, small = false }: FilterChipProps) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: small ? '2px 8px' : '4px 12px',
        borderRadius: tokens.radius.full,
        border: active
          ? '1px solid var(--color-accent-primary)'
          : `1px solid ${alpha(tokens.colors.border.primary, 25)}`,
        background: active ? alpha(tokens.colors.accent.primary, 12) : 'transparent',
        color: active ? 'var(--color-accent-primary)' : tokens.colors.text.tertiary,
        fontSize: small ? 11 : tokens.typography.fontSize.xs,
        fontWeight: active
          ? tokens.typography.fontWeight.bold
          : tokens.typography.fontWeight.normal,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
        transition: 'all 0.15s ease',
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  )
}
