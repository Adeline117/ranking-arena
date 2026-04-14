/**
 * /feed - Trader Activity Feed page
 *
 * Server component: fetches initial activity batch, passes to client feed.
 */

import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { features } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import ActivityFeed from '@/app/components/feed/ActivityFeed'
import type { TraderActivity } from '@/lib/types/activities'
import TopNav from '@/app/components/layout/TopNav'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { BASE_URL } from '@/lib/constants/urls'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('feed')

export const revalidate = 60 // ISR: 1 minute

export const metadata: Metadata = {
  title: 'Trader Activity Feed',
  description: 'Live auto-generated feed of trader milestones: rank surges, ROI breakthroughs, win streaks, and large profits.',
  alternates: { canonical: `${BASE_URL}/feed` },
  openGraph: {
    title: 'Trader Activity Feed',
    description: 'Live auto-generated feed of trader milestones: rank surges, ROI breakthroughs, win streaks, and large profits.',
    url: `${BASE_URL}/feed`,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Trader Activity Feed' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trader Activity Feed',
    description: 'Live auto-generated feed of trader milestones: rank surges, ROI breakthroughs, win streaks, and large profits.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

// ---------------------------------------------------------------------------
// Server-side data fetch
// ---------------------------------------------------------------------------

async function fetchInitialActivities(): Promise<{
  activities: TraderActivity[]
  hasMore: boolean
  nextCursor: string | null
}> {
  try {
    const supabase = getSupabaseAdmin()

    const LIMIT = 50
    const { data, error } = await supabase
      .from('trader_activities')
      .select('id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(LIMIT + 1)

    if (error || !data) {
      return { activities: [], hasMore: false, nextCursor: null }
    }

    const hasMore = data.length > LIMIT
    const page = hasMore ? data.slice(0, LIMIT) : data
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].occurred_at : null

    return {
      activities: page as TraderActivity[],
      hasMore,
      nextCursor,
    }
  } catch (error) {
    logger.warn('[feed] fetchActivities failed:', error instanceof Error ? error.message : String(error))
    return { activities: [], hasMore: false, nextCursor: null }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function FeedPage() {
  if (!features.social) redirect('/')

  const { activities, hasMore, nextCursor } = await fetchInitialActivities()

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
      }}
    >
      <TopNav />

      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
        }}
      >
        {/* Page header */}
        <div style={{ marginBottom: tokens.spacing[5] }}>
          <h1
            style={{
              margin: 0,
              fontSize: tokens.typography.fontSize['2xl'],
              fontWeight: tokens.typography.fontWeight.black,
              color: tokens.colors.text.primary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            Activity Feed
          </h1>
          <p
            style={{
              margin: `${tokens.spacing[1]} 0 0`,
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.tertiary,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            Auto-generated milestones from live trader data — rank climbs, ROI breakouts, win streaks, and large profits.
          </p>
        </div>

        {/* Feed */}
        <Suspense fallback={<RankingSkeleton />}>
          <ActivityFeed
            initialActivities={activities}
            initialHasMore={hasMore}
            initialNextCursor={nextCursor}
          />
        </Suspense>
      </div>
    </div>
  )
}
