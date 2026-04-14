/**
 * Snapshot Viewer Page
 *
 * Public page for viewing shared ranking snapshots
 * URL: /s/[token]
 */

import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import SnapshotViewerClient from './SnapshotViewerClient'

export const revalidate = 300

// SSR timeout: during cron contention, Supabase queries can block on row locks
// for 30+ seconds. Race against this timeout so users see a fast 404 instead.
const SSR_TIMEOUT_MS = 3000

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.arenafi.org'

interface PageProps {
  params: Promise<{ token: string }>
}

// Generate metadata for SEO and social sharing
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params
  let snapshot: { title: string | null; time_range: string; total_traders: number; top_trader_handle: string; top_trader_roi: number; data_captured_at: string } | null = null
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await Promise.race([
      supabase
        .from('ranking_snapshots')
        .select('title, time_range, total_traders, top_trader_handle, top_trader_roi, data_captured_at')
        .eq('share_token', token)
        .eq('is_public', true)
        .single(),
      new Promise<{ data: null }>((resolve) => setTimeout(() => resolve({ data: null }), SSR_TIMEOUT_MS)),
    ])
    snapshot = data
  } catch { /* timeout or error — use default metadata */ }

  if (!snapshot) {
    return {
      title: 'Snapshot Not Found',
    }
  }

  const timeRangeLabels: Record<string, string> = {
    '7D': '7-Day',
    '30D': '30-Day',
    '90D': '90-Day',
  }

  const title = snapshot.title || `${timeRangeLabels[snapshot.time_range] || snapshot.time_range} Leaderboard Snapshot`
  const description = `Top ${snapshot.total_traders} traders. #1: ${snapshot.top_trader_handle} with ${snapshot.top_trader_roi >= 0 ? '+' : ''}${snapshot.top_trader_roi?.toFixed(1)}% ROI. Captured on ${new Date(snapshot.data_captured_at).toLocaleDateString()}.`

  return {
    title: `${title}`,
    description,
    alternates: { canonical: `${BASE_URL}/s/${token}` },
    openGraph: {
      title,
      description,
      type: 'article',
      siteName: 'Arena',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}

export default async function SnapshotViewerPage({ params }: PageProps) {
  const { token } = await params

  // Validate token format
  if (!token || token.length < 6) {
    notFound()
  }

  let snapshot: Record<string, unknown> | null = null
  let traders: Record<string, unknown>[] | null = null

  try {
    const supabase = getSupabaseAdmin()

    // Fetch snapshot metadata with timeout
    const { data: snapshotData, error: snapshotError } = await Promise.race([
      supabase
        .from('ranking_snapshots')
        .select(`
          id,
          share_token,
          time_range,
          exchange,
          category,
          total_traders,
          top_trader_handle,
          top_trader_roi,
          data_captured_at,
          data_delay_minutes,
          is_public,
          view_count,
          expires_at,
          title,
          description,
          created_at
        `)
        .eq('share_token', token)
        .single(),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: { message: 'SSR timeout' } }), SSR_TIMEOUT_MS)
      ),
    ])

    if (snapshotError || !snapshotData || !snapshotData.is_public) {
      notFound()
    }
    snapshot = snapshotData

    // Fetch traders in the snapshot with timeout
    const { data: tradersData } = await Promise.race([
      supabase
        .from('snapshot_traders')
        .select(`
          rank,
          trader_id,
          handle,
          source,
          avatar_url,
          roi,
          pnl,
          win_rate,
          max_drawdown,
          trades_count,
          followers,
          arena_score,
          return_score,
          drawdown_score,
          stability_score,
          data_availability
        `)
        .eq('snapshot_id', snapshotData.id)
        .order('rank', { ascending: true }),
      new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), SSR_TIMEOUT_MS)
      ),
    ])
    traders = tradersData
  } catch {
    notFound()
  }

  // snapshot is guaranteed non-null here (notFound() returns never in all null/error paths above)
  const snap = snapshot!

  // Check if snapshot is expired
  const isExpired = snap.expires_at && new Date(snap.expires_at as string) < new Date()

  // Increment view count (fire-and-forget, no timeout needed)
  if (!isExpired) {
    getSupabaseAdmin().rpc('increment_snapshot_view_count', { snapshot_share_token: token })
  }

  // Transform data for client component
  const snapshotPayload = {
    id: snap.id as string,
    shareToken: snap.share_token as string,
    timeRange: snap.time_range as string,
    exchange: snap.exchange as string,
    category: snap.category as string,
    totalTraders: snap.total_traders as number,
    topTrader: {
      handle: snap.top_trader_handle as string,
      roi: snap.top_trader_roi as number,
    },
    dataCapturedAt: snap.data_captured_at as string,
    dataDelayMinutes: snap.data_delay_minutes as number,
    viewCount: snap.view_count as number,
    expiresAt: (snap.expires_at as string) || undefined,
    title: (snap.title as string) || undefined,
    description: (snap.description as string) || undefined,
    createdAt: snap.created_at as string,
    isExpired: !!isExpired,
  }

  const tradersPayload = (traders || []).map((t: Record<string, unknown>) => ({
    rank: t.rank as number,
    id: t.trader_id as string,
    handle: t.handle as string,
    source: t.source as string,
    avatarUrl: (t.avatar_url as string) || undefined,
    roi: (t.roi as number) ?? null,
    pnl: (t.pnl as number) ?? undefined,
    winRate: (t.win_rate as number) ?? undefined,
    maxDrawdown: (t.max_drawdown as number) ?? undefined,
    tradesCount: (t.trades_count as number) ?? undefined,
    followers: (t.followers as number) ?? undefined,
    arenaScore: (t.arena_score as number) ?? undefined,
    returnScore: (t.return_score as number) ?? undefined,
    drawdownScore: (t.drawdown_score as number) ?? undefined,
    stabilityScore: (t.stability_score as number) ?? undefined,
    dataAvailability: (t.data_availability as Record<string, boolean>) ?? undefined,
  }))

  return <SnapshotViewerClient snapshot={snapshotPayload} traders={tradersPayload} />
}
