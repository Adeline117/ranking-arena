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

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.arenafi.org'

interface PageProps {
  params: Promise<{ token: string }>
}

// Generate metadata for SEO and social sharing
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params
  const supabase = getSupabaseAdmin()

  const { data: snapshot } = await supabase
    .from('ranking_snapshots')
    .select('title, time_range, total_traders, top_trader_handle, top_trader_roi, data_captured_at')
    .eq('share_token', token)
    .eq('is_public', true)
    .single()

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

  const supabase = getSupabaseAdmin()

  // Fetch snapshot metadata
  const { data: snapshot, error: snapshotError } = await supabase
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
    .single()

  // Check if snapshot exists and is public
  if (snapshotError || !snapshot || !snapshot.is_public) {
    notFound()
  }

  // Check if snapshot is expired
  const isExpired = snapshot.expires_at && new Date(snapshot.expires_at) < new Date()

  // Fetch traders in the snapshot
  const { data: traders } = await supabase
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
    .eq('snapshot_id', snapshot.id)
    .order('rank', { ascending: true })

  // Increment view count (server action)
  if (!isExpired) {
    supabase.rpc('increment_snapshot_view_count', { snapshot_share_token: token })
  }

  // Transform data for client component
  const snapshotData = {
    id: snapshot.id,
    shareToken: snapshot.share_token,
    timeRange: snapshot.time_range,
    exchange: snapshot.exchange,
    category: snapshot.category,
    totalTraders: snapshot.total_traders,
    topTrader: {
      handle: snapshot.top_trader_handle,
      roi: snapshot.top_trader_roi,
    },
    dataCapturedAt: snapshot.data_captured_at,
    dataDelayMinutes: snapshot.data_delay_minutes,
    viewCount: snapshot.view_count,
    expiresAt: snapshot.expires_at,
    title: snapshot.title,
    description: snapshot.description,
    createdAt: snapshot.created_at,
    isExpired,
  }

  const tradersData = (traders || []).map(t => ({
    rank: t.rank,
    id: t.trader_id,
    handle: t.handle,
    source: t.source,
    avatarUrl: t.avatar_url,
    roi: t.roi,
    pnl: t.pnl,
    winRate: t.win_rate,
    maxDrawdown: t.max_drawdown,
    tradesCount: t.trades_count,
    followers: t.followers,
    arenaScore: t.arena_score,
    returnScore: t.return_score,
    drawdownScore: t.drawdown_score,
    stabilityScore: t.stability_score,
    dataAvailability: t.data_availability,
  }))

  return <SnapshotViewerClient snapshot={snapshotData} traders={tradersData} />
}
