/**
 * /feed/[id] - Single activity share page with OG card metadata.
 *
 * Allows each activity to be shared via link with a rich preview.
 */

import { cache } from 'react'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { features } from '@/lib/features'
import Link from 'next/link'
import Image from 'next/image'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { TraderActivity, ActivityType } from '@/lib/types/activities'
import { ACTIVITY_META } from '@/lib/types/activities'
import TopNav from '@/app/components/layout/TopNav'
import { tokens } from '@/lib/design-tokens'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 300 // ISR: 5 minutes

// ---------------------------------------------------------------------------
// Server data fetch
// ---------------------------------------------------------------------------

const fetchActivity = cache(async function fetchActivity(id: string): Promise<TraderActivity | null> {
  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('trader_activities')
      .select('id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at')
      .eq('id', id)
      .single()

    if (error || !data) return null
    return data as TraderActivity
  } catch (error) {
    console.warn('[feed/id] fetchActivity failed:', error instanceof Error ? error.message : String(error))
    return null
  }
})

// ---------------------------------------------------------------------------
// Metadata (OG card)
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params
  const activity = await fetchActivity(id)

  if (!activity) {
    return { title: 'Activity Not Found' }
  }

  const title = `${activity.handle ?? 'Trader'} Activity`
  const description = activity.activity_text

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${BASE_URL}/feed/${id}`,
      siteName: 'Arena',
      type: 'article',
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ActivitySharePage({ params }: PageProps) {
  if (!features.social) redirect('/')

  const { id } = await params
  const activity = await fetchActivity(id)

  if (!activity) {
    notFound()
  }

  const meta = ACTIVITY_META[activity.activity_type as ActivityType]
  const color = meta.colorVar
  const occurredDate = new Date(activity.occurred_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const traderHref = activity.handle
    ? `/trader/${encodeURIComponent(activity.handle)}`
    : null

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
      <TopNav />

      <div
        style={{
          maxWidth: 600,
          margin: '0 auto',
          padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
        }}
      >
        {/* Back link */}
        <Link
          href="/feed"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.tertiary,
            textDecoration: 'none',
            marginBottom: tokens.spacing[6],
          }}
        >
          &larr; Activity Feed
        </Link>

        {/* Activity card */}
        <div
          style={{
            background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.primary} 100%)`,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${color}30`,
            padding: tokens.spacing[6],
            boxShadow: `0 4px 32px ${color}10`,
          }}
        >
          {/* Type badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: tokens.radius.full,
              background: `${color}18`,
              border: `1px solid ${color}30`,
              marginBottom: tokens.spacing[4],
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              {meta.label}
            </span>
          </div>

          {/* Trader row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              marginBottom: tokens.spacing[4],
            }}
          >
            {activity.avatar_url ? (
              <Image
                src={`/api/avatar?url=${encodeURIComponent(activity.avatar_url)}`}
                alt={activity.handle ?? 'Trader'}
                width={48}
                height={48}
                style={{
                  borderRadius: '50%',
                  objectFit: 'cover',
                  border: `2px solid ${color}40`,
                }}
                unoptimized
              />
            ) : (
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${color}40, ${color}20)`,
                  border: `2px solid ${color}40`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  fontWeight: 700,
                  color,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
              >
                {(activity.handle ?? '?')[0]?.toUpperCase()}
              </div>
            )}
            <div>
              {traderHref ? (
                <Link
                  href={traderHref}
                  style={{
                    fontSize: tokens.typography.fontSize.lg,
                    fontWeight: tokens.typography.fontWeight.black,
                    color: tokens.colors.text.primary,
                    textDecoration: 'none',
                    fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  }}
                >
                  {activity.handle}
                </Link>
              ) : (
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.lg,
                    fontWeight: tokens.typography.fontWeight.black,
                    color: tokens.colors.text.primary,
                    fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  }}
                >
                  {activity.handle ?? activity.source_trader_id}
                </span>
              )}
              <div
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  color: tokens.colors.text.tertiary,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  marginTop: 2,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {activity.source.replace(/_futures$/, '').replace(/_/g, ' ')}
              </div>
            </div>
          </div>

          {/* Activity text */}
          <p
            style={{
              margin: 0,
              fontSize: tokens.typography.fontSize.xl,
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.text.primary,
              lineHeight: 1.5,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {activity.activity_text}
          </p>

          {/* Metric highlight */}
          {activity.metric_value !== null && activity.metric_label && (
            <div
              style={{
                marginTop: tokens.spacing[4],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                background: `${color}10`,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${color}20`,
                display: 'inline-block',
              }}
            >
              <span
                style={{
                  fontSize: tokens.typography.fontSize['2xl'],
                  fontWeight: tokens.typography.fontWeight.black,
                  color,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
              >
                {formatMetric(activity.metric_value, activity.metric_label)}
              </span>
              <span
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: tokens.colors.text.tertiary,
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  marginLeft: 8,
                }}
              >
                {activity.metric_label}
              </span>
            </div>
          )}

          {/* Date */}
          <div
            style={{
              marginTop: tokens.spacing[5],
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            {occurredDate}
          </div>
        </div>

        {/* CTA */}
        <div
          style={{
            marginTop: tokens.spacing[6],
            textAlign: 'center',
          }}
        >
          <Link
            href="/feed"
            style={{
              display: 'inline-block',
              padding: `${tokens.spacing[3]} ${tokens.spacing[6]}`,
              borderRadius: tokens.radius.lg,
              background: `linear-gradient(135deg, var(--color-brand), var(--color-accent-primary))`,
              color: tokens.colors.white,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
              textDecoration: 'none',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            View Full Activity Feed
          </Link>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function formatMetric(value: number, label: string): string {
  if (label === 'PnL USD') return `$${(value / 1000).toFixed(0)}K`
  if (label === 'ROI %') return `${value.toFixed(0)}%`
  if (label === 'Arena Score') return value.toFixed(1)
  return String(Math.round(value))
}
