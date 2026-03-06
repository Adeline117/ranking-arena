'use client'

/**
 * TraderActivityTimeline - compact activity timeline embedded on a trader's profile page.
 *
 * Fetches activities for a specific trader handle via the feed API.
 * Shows newest events first; limited to 20 items (no Load More in compact mode).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import type { TraderActivity } from '@/lib/types/activities'
import ActivityFeedItem from './ActivityFeedItem'

interface TraderActivityTimelineProps {
  /** The trader's handle — used to filter the activity feed */
  handle: string
  /** Source/exchange (for context, not used as filter here) */
  source?: string
}

export default function TraderActivityTimeline({ handle }: TraderActivityTimelineProps) {
  const [activities, setActivities] = useState<TraderActivity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const params = new URLSearchParams()
    params.set('handle', handle)
    params.set('limit', '20')

    fetch(`/api/feed/activities?${params}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return
        if (json?.data?.activities) {
          setActivities(json.data.activities)
        } else {
          setActivities([])
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load activity timeline')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [handle])

  if (loading) {
    return (
      <div
        style={{
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}40`,
          padding: tokens.spacing[6],
          textAlign: 'center',
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.sm,
          fontFamily: tokens.typography.fontFamily.sans.join(', '),
        }}
      >
        Loading activity...
      </div>
    )
  }

  if (error || activities.length === 0) {
    return null // Silently hide if no activities (new feature; many traders won't have data yet)
  }

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
          borderBottom: `1px solid ${tokens.colors.border.primary}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
        }}
      >
        <span
          style={{
            fontSize: tokens.typography.fontSize.base,
            fontWeight: tokens.typography.fontWeight.black,
            color: tokens.colors.text.primary,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          Activity Timeline
        </span>

        <Link
          href="/feed"
          style={{
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-accent-primary)',
            textDecoration: 'none',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          View all activity
        </Link>
      </div>

      {/* Items */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {activities.map((activity, idx) => (
          <div
            key={activity.id}
            style={{
              borderBottom:
                idx < activities.length - 1
                  ? `1px solid ${tokens.colors.border.primary}15`
                  : 'none',
            }}
          >
            <ActivityFeedItem activity={activity} showShareHint />
          </div>
        ))}
      </div>
    </div>
  )
}
