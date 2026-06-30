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
import { tokens, alpha } from '@/lib/design-tokens'
import { ACTIVITY_META } from '@/lib/types/activities'
import type { TraderActivity, ActivityType } from '@/lib/types/activities'
import ActivityIcon from './ActivityIcon'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { formatTimeAgo } from '@/lib/utils/date'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export default function ActivityFeedItem({
  activity,
  showShareHint = true,
}: ActivityFeedItemProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const [hovered, setHovered] = useState(false)
  const meta = ACTIVITY_META[activity.activity_type as ActivityType]
  const color = meta.colorVar
  const relativeTime = formatTimeAgo(activity.occurred_at, language)
  const sourceLabel = formatSourceLabel(activity.source)

  // Some trader handles are (masked) emails, e.g. "lo***@gmail.com". This feed is
  // public/anonymous — never surface an email-shaped name as the display name.
  const rawName = activity.handle ?? activity.source_trader_id
  const displayName = isEmailLike(rawName) ? 'Anonymous trader' : rawName

  // Trader handle link — suppress for email-shaped handles (would be a broken
  // /trader/<email> link AND would leak the address in the URL).
  const traderHref =
    activity.handle && !isEmailLike(activity.handle)
      ? `/trader/${encodeURIComponent(activity.handle)}`
      : null

  // Share link
  const shareHref = `/feed/${activity.id}`

  function handleShare(e: React.MouseEvent) {
    e.preventDefault()
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      const url = `${window.location.origin}${shareHref}`
      navigator.clipboard.writeText(url).then(
        () => showToast(t('linkCopied'), 'success'),
        () => undefined
      )
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
        background: hovered ? `${alpha(color, 3)}` : 'transparent',
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
          background: `${alpha(color, 9)}`,
          border: `1px solid ${alpha(color, 19)}`,
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
            src={avatarSrc(activity.avatar_url)}
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
              background: `linear-gradient(135deg, ${alpha(color, 25)}, ${alpha(color, 13)})`,
              border: `1px solid ${alpha(color, 25)}`,
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
              {(displayName ?? '?')[0]?.toUpperCase()}
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
              {displayName}
            </Link>
          ) : (
            <span style={{ color, fontWeight: 700 }}>{displayName}</span>
          )}{' '}
          <span style={{ color: tokens.colors.text.secondary }}>
            {/* Strip the raw name from the text (it leads with it) so an email-shaped
                handle is removed from the visible activity text, not just the label. */}
            {activity.activity_text.replace(new RegExp(`^${escapeRegExp(rawName)}\\s*`), '')}
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
              border: `1px solid ${alpha(tokens.colors.border.primary, 25)}`,
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
              background: `${alpha(color, 7)}`,
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

        {/* Always rendered (not hover-gated) so it stays reachable on touch
            devices, where there is no hover state. */}
        {showShareHint && (
          <button
            type="button"
            onClick={handleShare}
            title={t('copyShareLink')}
            aria-label={t('copyShareLink')}
            style={{
              background: 'none',
              border: `1px solid ${alpha(tokens.colors.border.primary, 38)}`,
              borderRadius: tokens.radius.sm,
              padding: '2px 6px',
              cursor: 'pointer',
              fontSize: 10,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              transition: 'all 0.15s ease',
            }}
          >
            {t('share')}
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

/** True for (masked) email-shaped strings like "lo***@gmail.com" — requires a
 *  local part, an @, and a dotted domain, so it won't match "@twitterhandle". */
function isEmailLike(value: string | null | undefined): boolean {
  return !!value && /\S+@\S+\.\S+/.test(value)
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
