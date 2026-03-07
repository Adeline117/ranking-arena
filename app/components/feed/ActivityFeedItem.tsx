'use client'

/**
 * ActivityFeedItem - a single row in the trader activity timeline.
 *
 * Layout:
 *   [icon badge] [avatar] [text]                        [time] [share]
 *
 * No emoji. Activity type is distinguished by icon color + left border color.
 */

import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ACTIVITY_META } from '@/lib/types/activities'
import type { TraderActivity, ActivityType } from '@/lib/types/activities'
import ActivityIcon from './ActivityIcon'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatSourceLabel(source: string): string {
  // Convert "binance_futures" -> "Binance" etc.
  return source
    .replace(/_futures$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace('Okx', 'OKX')
    .replace('Gmx', 'GMX')
    .replace('Htx', 'HTX')
    .replace('Dydx', 'dYdX')
    .replace('Hyperliquid', 'Hyperliquid')
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ActivityFeedItemProps {
  activity: TraderActivity
  showShareHint?: boolean
}

export default function ActivityFeedItem({ activity, showShareHint = true }: ActivityFeedItemProps) {
  const [hovered, setHovered] = useState(false)
  const meta = ACTIVITY_META[activity.activity_type as ActivityType]
  const color = meta.colorVar
  const relativeTime = formatRelativeTime(activity.occurred_at)
  const sourceLabel = formatSourceLabel(activity.source)

  // Trader handle link
  const traderHref = activity.handle
    ? `/trader/${encodeURIComponent(activity.handle)}`
    : null

  // Share link
  const shareHref = `/feed/${activity.id}`

  function handleShare(e: React.MouseEvent) {
    e.preventDefault()
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      const url = `${window.location.origin}${shareHref}`
      navigator.clipboard.writeText(url).catch(() => undefined)
    }
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        background: hovered ? `${color}08` : 'transparent',
        borderLeft: `3px solid ${hovered ? color : 'transparent'}`,
        transition: `all ${tokens.transition.base}`,
        cursor: 'default',
      }}
    >
      {/* Activity type icon badge */}
      <div
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: tokens.radius.md,
          background: `${color}18`,
          border: `1px solid ${color}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIcon type={activity.activity_type as ActivityType} size={14} />
      </div>

      {/* Avatar */}
      <div style={{ flexShrink: 0 }}>
        {activity.avatar_url ? (
          <Image
            src={activity.avatar_url}
            alt={activity.handle ?? 'Trader'}
            width={32}
            height={32}
            style={{
              borderRadius: '50%',
              objectFit: 'cover',
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
            unoptimized
          />
        ) : (
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: `linear-gradient(135deg, ${color}40, ${color}20)`,
              border: `1px solid ${color}40`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {(activity.handle ?? '?')[0]?.toUpperCase()}
            </span>
          </div>
        )}
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Activity text */}
        <p
          style={{
            margin: 0,
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.primary,
            lineHeight: 1.5,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {traderHref ? (
            <Link
              href={traderHref}
              style={{
                color,
                fontWeight: 700,
                textDecoration: 'none',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {activity.handle}
            </Link>
          ) : (
            <span style={{ color, fontWeight: 700 }}>{activity.handle ?? activity.source_trader_id}</span>
          )}{' '}
          <span style={{ color: tokens.colors.text.secondary }}>
            {/* Strip the handle from the text since we render it separately with a link */}
            {activity.activity_text.replace(
              new RegExp(`^${escapeRegExp(activity.handle ?? activity.source_trader_id)}\\s*`),
              '',
            )}
          </span>
        </p>

        {/* Meta row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginTop: 4,
            flexWrap: 'wrap',
          }}
        >
          {/* Source platform badge */}
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: tokens.colors.text.tertiary,
              background: tokens.colors.bg.tertiary,
              padding: '1px 6px',
              borderRadius: tokens.radius.full,
              border: `1px solid ${tokens.colors.border.primary}40`,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}
          >
            {sourceLabel}
          </span>

          {/* Activity type label */}
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color,
              background: `${color}12`,
              padding: '1px 6px',
              borderRadius: tokens.radius.full,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {meta.label}
          </span>

          {/* Metric value */}
          {activity.metric_value !== null && activity.metric_label && (
            <span
              style={{
                fontSize: 11,
                color: tokens.colors.text.tertiary,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {activity.metric_label}: {formatMetric(activity.metric_value, activity.metric_label)}
            </span>
          )}
        </div>
      </div>

      {/* Right: time + share */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: tokens.colors.text.tertiary,
            whiteSpace: 'nowrap',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {relativeTime}
        </span>

        {showShareHint && hovered && (
          <button
            onClick={handleShare}
            title="Copy share link"
            style={{
              background: 'none',
              border: `1px solid ${tokens.colors.border.primary}60`,
              borderRadius: tokens.radius.sm,
              padding: '2px 6px',
              cursor: 'pointer',
              fontSize: 10,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              transition: 'all 0.15s ease',
            }}
          >
            Share
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatMetric(value: number, label: string): string {
  if (label === 'PnL USD') {
    return `$${(value / 1000).toFixed(0)}K`
  }
  if (label === 'ROI %') {
    return `${value.toFixed(0)}%`
  }
  if (label === 'Arena Score') {
    return value.toFixed(1)
  }
  return String(Math.round(value))
}
