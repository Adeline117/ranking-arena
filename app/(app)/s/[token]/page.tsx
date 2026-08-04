/**
 * Snapshot Viewer Page
 *
 * Public page for viewing shared ranking snapshots
 * URL: /s/[token]
 */

import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import {
  PUBLIC_SNAPSHOT_TOKEN_RE,
  parsePublicRankingSnapshot,
  parsePublicSnapshotMetadata,
  parsePublicSnapshotTraders,
} from '@/lib/ranking-snapshots/public-read-contract'
import SnapshotViewerClient from './SnapshotViewerClient'

export const revalidate = 300

// During cron contention, Supabase queries can block on row locks for 30+ seconds.
// Physically abort them so the route reaches its retryable error boundary.
const SSR_TIMEOUT_MS = 3000

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.arenafi.org'

interface PageProps {
  params: Promise<{ token: string }>
}

export async function withSnapshotDeadline<T>(
  label: string,
  load: (signal: AbortSignal) => PromiseLike<T>
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    const pending = Promise.resolve(load(controller.signal))
    return await Promise.race([
      pending,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error(`${label} timed out`))
        }, SSR_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function unavailableSnapshotMetadata(): Metadata {
  return {
    title: 'Snapshot Not Found',
    robots: { index: false, follow: false },
  }
}

// Generate metadata for SEO and social sharing
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params
  if (!PUBLIC_SNAPSHOT_TOKEN_RE.test(token)) return unavailableSnapshotMetadata()

  let snapshot: ReturnType<typeof parsePublicSnapshotMetadata> | null = null
  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await withSnapshotDeadline('Snapshot metadata read', (signal) =>
      supabase
        .from('ranking_snapshots')
        .select(
          'share_token, is_public, is_expired, expires_at, title, time_range, total_traders, top_trader_handle, top_trader_roi, data_captured_at'
        )
        .eq('share_token', token)
        .eq('is_public', true)
        .abortSignal(signal)
        .maybeSingle()
    )
    if (error) throw new Error(`Snapshot metadata read failed: ${error.message}`)
    if (data) snapshot = parsePublicSnapshotMetadata(data, token)
  } catch (error) {
    logger.warn(
      '[s/token] snapshot metadata unavailable:',
      error instanceof Error ? error.message : String(error)
    )
  }

  if (!snapshot || snapshot.isExpired) {
    // Invalid/expired share tokens stream a soft-404 (headers commit at 200
    // before notFound() runs, because this segment has loading.tsx +
    // revalidate). Emit noindex so crawlers don't index dead share links.
    return unavailableSnapshotMetadata()
  }

  const timeRangeLabels: Record<string, string> = {
    '7D': '7-Day',
    '30D': '30-Day',
    '90D': '90-Day',
  }

  const title =
    snapshot.title ||
    `${timeRangeLabels[snapshot.timeRange] || snapshot.timeRange} Leaderboard Snapshot`
  const description = `Top ${snapshot.totalTraders} traders. #1: ${snapshot.topTraderHandle} with ${snapshot.topTraderRoi >= 0 ? '+' : ''}${snapshot.topTraderRoi.toFixed(1)}% ROI. Captured on ${new Date(snapshot.dataCapturedAt).toLocaleDateString()}.`

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

  // Validate token format (url-safe charset, bounded length) — reject malformed
  // tokens before hitting the DB, not just short ones.
  if (!PUBLIC_SNAPSHOT_TOKEN_RE.test(token)) {
    notFound()
  }

  const supabase = getSupabaseAdmin()

  const { data: snapshotData, error: snapshotError } = await withSnapshotDeadline(
    'Snapshot read',
    (signal) =>
      supabase
        .from('ranking_snapshots')
        .select(
          `
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
          is_expired,
          view_count,
          expires_at,
          title,
          description,
          created_at
        `
        )
        .eq('share_token', token)
        .eq('is_public', true)
        .abortSignal(signal)
        .maybeSingle()
  )

  if (snapshotError) {
    throw new Error(`Snapshot read failed: ${snapshotError.message}`)
  }
  if (!snapshotData) notFound()
  const snapshot = parsePublicRankingSnapshot(snapshotData, token)

  const { data: tradersData, error: tradersError } = await withSnapshotDeadline(
    'Snapshot trader read',
    (signal) =>
      supabase
        .from('snapshot_traders')
        .select(
          `
          snapshot_id,
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
        `
        )
        .eq('snapshot_id', snapshot.id)
        .order('rank', { ascending: true })
        .abortSignal(signal)
  )
  if (tradersError) {
    throw new Error(`Snapshot trader read failed: ${tradersError.message}`)
  }
  const traders = parsePublicSnapshotTraders(tradersData, snapshot.id, snapshot.totalTraders)

  // Check if snapshot is expired
  const isExpired = snapshot.isExpired

  // Best-effort analytics must not hold the page open or surface an unhandled rejection.
  if (!isExpired) {
    void Promise.resolve(
      getSupabaseAdmin()
        .rpc('increment_snapshot_view_count', { snapshot_share_token: token })
        .abortSignal(AbortSignal.timeout(1_000))
    ).catch(() => void 0)
  }

  const snapshotPayload = {
    id: snapshot.id,
    shareToken: snapshot.shareToken,
    timeRange: snapshot.timeRange,
    exchange: snapshot.exchange ?? undefined,
    category: snapshot.category ?? undefined,
    totalTraders: snapshot.totalTraders,
    topTrader: {
      handle: snapshot.topTraderHandle,
      roi: snapshot.topTraderRoi,
    },
    dataCapturedAt: snapshot.dataCapturedAt,
    dataDelayMinutes: snapshot.dataDelayMinutes ?? undefined,
    viewCount: snapshot.viewCount,
    expiresAt: snapshot.expiresAt ?? undefined,
    title: snapshot.title ?? undefined,
    description: snapshot.description ?? undefined,
    createdAt: snapshot.createdAt,
    isExpired,
  }

  const tradersPayload = traders.map((trader) => ({
    rank: trader.rank,
    id: trader.id,
    handle: trader.handle ?? undefined,
    source: trader.source,
    avatarUrl: trader.avatarUrl ?? undefined,
    roi: trader.roi,
    pnl: trader.pnl ?? undefined,
    winRate: trader.winRate ?? undefined,
    maxDrawdown: trader.maxDrawdown ?? undefined,
    tradesCount: trader.tradesCount ?? undefined,
    followers: trader.followers ?? undefined,
    arenaScore: trader.arenaScore ?? undefined,
    returnScore: trader.returnScore ?? undefined,
    drawdownScore: trader.drawdownScore ?? undefined,
    stabilityScore: trader.stabilityScore ?? undefined,
    dataAvailability: trader.dataAvailability ?? undefined,
  }))

  return <SnapshotViewerClient snapshot={snapshotPayload} traders={tradersPayload} />
}
