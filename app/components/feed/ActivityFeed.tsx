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

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { TraderActivity, ActivityType } from '@/lib/types/activities'
import { ACTIVITY_META } from '@/lib/types/activities'
import ActivityFeedItem from './ActivityFeedItem'

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

const PLATFORM_OPTIONS: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'Binance', value: 'binance_futures' },
  { label: 'Bybit', value: 'bybit' },
  { label: 'OKX', value: 'okx_futures' },
  { label: 'Bitget', value: 'bitget_futures' },
  { label: 'Hyperliquid', value: 'hyperliquid' },
  { label: 'GMX', value: 'gmx' },
]

const TYPE_OPTIONS: { label: string; value: ActivityType | null }[] = [
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
  fixedPlatform,
  fixedHandle,
  title = 'Trader Activity Feed',
}: ActivityFeedProps) {
  const [platform, setPlatform] = useState<string | null>(fixedPlatform ?? null)
  const [typeFilter, setTypeFilter] = useState<ActivityType | null>(null)
  const [activities, setActivities] = useState<TraderActivity[]>(initialActivities)
  const [hasMore, setHasMore] = useState(initialHasMore)
  const [cursor, setCursor] = useState<string | null>(initialNextCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Platform filter changes — reload from scratch
  const handlePlatformChange = useCallback(async (newPlatform: string | null) => {
    if (fixedPlatform) return // locked
    setPlatform(newPlatform)
    setTypeFilter(null)
    setActivities([])
    setHasMore(false)
    setCursor(null)
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (newPlatform) params.set('platform', newPlatform)
      if (fixedHandle) params.set('handle', fixedHandle)

      const res = await fetch(`/api/feed/activities?${params}`)
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Failed to load activities')
        return
      }

      const data = json.data
      setActivities(data.activities ?? [])
      setHasMore(data.pagination.hasMore)
      setCursor(data.pagination.nextCursor)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [fixedPlatform, fixedHandle])

  // Load more (cursor pagination)
  const handleLoadMore = useCallback(async () => {
    if (!cursor || loading) return
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (platform) params.set('platform', platform)
      if (fixedHandle) params.set('handle', fixedHandle)
      if (cursor) params.set('cursor', cursor)

      const res = await fetch(`/api/feed/activities?${params}`)
      const json = await res.json()

      if (!res.ok) {
        setError(json.error ?? 'Failed to load activities')
        return
      }

      const data = json.data
      setActivities((prev) => [...prev, ...(data.activities ?? [])])
      setHasMore(data.pagination.hasMore)
      setCursor(data.pagination.nextCursor)
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [cursor, loading, platform, fixedHandle])

  // Apply local type filter on top of server-fetched data
  const visibleActivities = typeFilter
    ? activities.filter((a) => a.activity_type === typeFilter)
    : activities

  return (
    <div
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}40`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[3],
          flexWrap: 'wrap',
          background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <span
            style={{
              fontSize: tokens.typography.fontSize.lg,
              fontWeight: tokens.typography.fontWeight.black,
              color: tokens.colors.text.primary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {title}
          </span>
          {activities.length > 0 && (
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
              {activities.length}
            </span>
          )}
        </div>

        {/* Live indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: 'var(--color-accent-success)',
              boxShadow: '0 0 6px var(--color-accent-success)',
              display: 'inline-block',
              animation: 'pulse 2s infinite',
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            Live
          </span>
        </div>
      </div>

      {/* Platform filter */}
      {!fixedPlatform && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}30`,
            overflowX: 'auto',
          }}
        >
          {PLATFORM_OPTIONS.map((opt) => (
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
          borderBottom: `1px solid ${tokens.colors.border.primary}20`,
          overflowX: 'auto',
        }}
      >
        {TYPE_OPTIONS.map((opt) => (
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
        {visibleActivities.length === 0 && !loading ? (
          <div
            style={{
              padding: tokens.spacing[12],
              textAlign: 'center',
              color: tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            No activity events yet. Check back after the next data sync.
          </div>
        ) : (
          visibleActivities.map((activity, idx) => (
            <div
              key={activity.id}
              style={{
                borderBottom:
                  idx < visibleActivities.length - 1
                    ? `1px solid ${tokens.colors.border.primary}20`
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
              borderTop: `1px solid ${tokens.colors.border.primary}20`,
              textAlign: 'center',
            }}
          >
            <button
              onClick={handleLoadMore}
              disabled={loading}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}60`,
                background: loading ? tokens.colors.bg.tertiary : tokens.colors.bg.secondary,
                color: loading ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.medium,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {loading ? 'Loading...' : 'Load More'}
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
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
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
      style={{
        padding: small ? '2px 8px' : '4px 12px',
        borderRadius: tokens.radius.full,
        border: active
          ? '1px solid var(--color-accent-primary)'
          : `1px solid ${tokens.colors.border.primary}40`,
        background: active ? 'var(--color-accent-primary)20' : 'transparent',
        color: active ? 'var(--color-accent-primary)' : tokens.colors.text.tertiary,
        fontSize: small ? 11 : tokens.typography.fontSize.xs,
        fontWeight: active ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
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
