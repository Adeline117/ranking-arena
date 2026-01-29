'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { formatRelativeTime, getFreshnessLevel } from '@/lib/leaderboard-adapter'
import { useTraderRefresh, buildTraderId } from '@/lib/hooks/useLeaderboard'
import type { Platform } from '@/lib/types/leaderboard'

interface DataFreshnessIndicatorProps {
  platform: Platform
  traderKey: string
  lastSnapshotAt: string | null
  lastProfileAt: string | null
  isStale: boolean
  staleReason: string | null
}

/**
 * Shows when trader data was last updated and provides a manual refresh button.
 * Displays relative time ("2h ago"), freshness badge (green/yellow/red),
 * and a "Refresh" button that enqueues a background job.
 */
export default function DataFreshnessIndicator({
  platform,
  traderKey,
  lastSnapshotAt,
  lastProfileAt,
  isStale,
  staleReason,
}: DataFreshnessIndicatorProps) {
  const traderId = buildTraderId(platform, traderKey)
  const { triggerRefresh, isRefreshing, error } = useTraderRefresh(traderId)
  const [refreshTriggered, setRefreshTriggered] = useState(false)

  const latestUpdate = lastSnapshotAt || lastProfileAt
  const freshness = getFreshnessLevel(latestUpdate)
  const relativeTime = formatRelativeTime(latestUpdate)

  const freshnessColors: Record<string, { dot: string; text: string; bg: string }> = {
    fresh: { dot: tokens.colors.accent.success, text: tokens.colors.text.secondary, bg: 'transparent' },
    aging: { dot: tokens.colors.accent.warning, text: tokens.colors.accent.warning, bg: 'rgba(245, 158, 11, 0.05)' },
    stale: { dot: tokens.colors.accent.error, text: tokens.colors.accent.error, bg: 'rgba(239, 68, 68, 0.05)' },
    unknown: { dot: tokens.colors.text.tertiary, text: tokens.colors.text.tertiary, bg: 'transparent' },
  }

  const colors = freshnessColors[freshness]

  const handleRefresh = async () => {
    if (isRefreshing || refreshTriggered) return
    setRefreshTriggered(true)
    await triggerRefresh(2) // Priority 2 = user-triggered
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderRadius: tokens.radius.md,
        background: colors.bg,
        fontSize: '12px',
      }}
    >
      {/* Freshness dot */}
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: colors.dot,
          flexShrink: 0,
        }}
      />

      {/* Time label */}
      <span style={{ color: colors.text }}>
        {latestUpdate ? `Updated ${relativeTime}` : 'No data yet'}
      </span>

      {/* Stale warning */}
      {isStale && staleReason && (
        <span
          style={{
            color: tokens.colors.accent.error,
            fontSize: '11px',
            marginLeft: '4px',
          }}
        >
          ({staleReason})
        </span>
      )}

      {/* Refresh button */}
      <button
        onClick={handleRefresh}
        disabled={isRefreshing || refreshTriggered}
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 8px',
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: 'transparent',
          color: isRefreshing || refreshTriggered ? tokens.colors.text.tertiary : tokens.colors.text.secondary,
          fontSize: '11px',
          cursor: isRefreshing || refreshTriggered ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s',
        }}
      >
        <RefreshIcon spinning={isRefreshing} size={11} />
        {getRefreshLabel(isRefreshing, refreshTriggered)}
      </button>

      {/* Error state */}
      {error && (
        <span style={{ color: tokens.colors.accent.error, fontSize: '11px' }}>
          {error}
        </span>
      )}
    </div>
  )
}

function getRefreshLabel(isRefreshing: boolean, refreshTriggered: boolean): string {
  if (isRefreshing) return 'Refreshing...'
  if (refreshTriggered) return 'Queued'
  return 'Refresh'
}

function RefreshIcon({ spinning, size = 12 }: { spinning: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        animation: spinning ? 'spin 1s linear infinite' : 'none',
      }}
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}
