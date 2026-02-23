/**
 * Trader PK Comparison Page
 * Route: /pk/[trader_a]/[trader_b]?platform=xxx&window=7d
 *
 * SSR server component — fetches both traders' data, renders a fighting-game
 * style comparison UI with metric-by-metric winner highlighting.
 * OG meta tags are injected server-side so X/Twitter can preview the card.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import PKPageClient from './PKPageClient'

const BASE_URL = 'https://www.arenafi.org'

// ─── Types ───────────────────────────────────────────────────────────────────

interface PKTraderData {
  handle: string
  display_name: string
  avatar_url: string | null
  source: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  rank: number | null
  trades_count: number | null
}

interface MetricRow {
  label: string
  a_raw: number | null
  b_raw: number | null
  a_display: string
  b_display: string
  /** 'a' | 'b' | 'tie' | null (null = not comparable) */
  winner: 'a' | 'b' | 'tie' | null
}

// ─── Data fetching ────────────────────────────────────────────────────────────

type TraderSourceRow = {
  handle: string
  avatar_url: string | null
  source: string
  source_trader_id: string
}

type LeaderboardRow = {
  display_name: string | null
  rank: number | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
}

type SnapshotRow = {
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  arena_score: number | null
}

async function fetchPKTrader(
  handle: string,
  platform: string | null,
  timeWindow: string
): Promise<PKTraderData | null> {
  try {
    const supabase = getSupabaseAdmin()

    // 1. Resolve trader source
    let srcQuery = supabase
      .from('trader_sources')
      .select('handle, avatar_url, source, source_trader_id')
      .ilike('handle', handle)

    if (platform) {
      srcQuery = srcQuery.eq('source', platform)
    }

    const { data: src } = (await srcQuery
      .limit(1)
      .maybeSingle()) as { data: TraderSourceRow | null }

    if (!src) return null

    // 2. Fetch metrics depending on time window
    let metrics: {
      roi: number | null
      pnl: number | null
      win_rate: number | null
      max_drawdown: number | null
      arena_score: number | null
      rank: number | null
      trades_count: number | null
    }

    if (timeWindow === '7d' || timeWindow === '30d') {
      const seasonId = timeWindow === '7d' ? '7D' : '30D'

      const { data: snap } = (await supabase
        .from('trader_snapshots')
        .select(
          'roi, pnl, win_rate, max_drawdown, trades_count, arena_score'
        )
        .eq('source', src.source)
        .eq('source_trader_id', src.source_trader_id)
        .eq('season_id', seasonId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()) as { data: SnapshotRow | null }

      metrics = {
        roi: snap?.roi ?? null,
        pnl: snap?.pnl ?? null,
        win_rate: snap?.win_rate ?? null,
        max_drawdown: snap?.max_drawdown ?? null,
        arena_score: snap?.arena_score ?? null,
        rank: null,
        trades_count: snap?.trades_count ?? null,
      }
    } else {
      // Default (90d): use leaderboard_ranks for main metrics
      const { data: lr } = (await supabase
        .from('leaderboard_ranks')
        .select(
          'display_name, rank, arena_score, roi, pnl, win_rate, max_drawdown'
        )
        .eq('source', src.source)
        .eq('source_trader_id', src.source_trader_id)
        .maybeSingle()) as { data: LeaderboardRow | null }

      // trades_count from snapshots
      const { data: snap } = (await supabase
        .from('trader_snapshots')
        .select('trades_count')
        .eq('source', src.source)
        .eq('source_trader_id', src.source_trader_id)
        .not('season_id', 'in', '("7D","30D")')
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()) as { data: { trades_count: number | null } | null }

      metrics = {
        roi: lr?.roi ?? null,
        pnl: lr?.pnl ?? null,
        win_rate: lr?.win_rate ?? null,
        max_drawdown: lr?.max_drawdown ?? null,
        arena_score: lr?.arena_score ?? null,
        rank: lr?.rank ?? null,
        trades_count: snap?.trades_count ?? null,
      }

      // Use display_name from leaderboard_ranks
      return {
        handle: src.handle || handle,
        display_name: lr?.display_name || src.handle || handle,
        avatar_url: src.avatar_url,
        source: src.source,
        roi: metrics.roi,
        pnl: metrics.pnl,
        win_rate: normalizeWinRate(metrics.win_rate),
        max_drawdown: metrics.max_drawdown,
        arena_score: metrics.arena_score,
        rank: metrics.rank,
        trades_count: metrics.trades_count,
      }
    }

    return {
      handle: src.handle || handle,
      display_name: src.handle || handle,
      avatar_url: src.avatar_url,
      source: src.source,
      roi: metrics.roi,
      pnl: metrics.pnl,
      win_rate: normalizeWinRate(metrics.win_rate),
      max_drawdown: metrics.max_drawdown,
      arena_score: metrics.arena_score,
      rank: metrics.rank,
      trades_count: metrics.trades_count,
    }
  } catch {
    return null
  }
}

function normalizeWinRate(wr: number | null | undefined): number | null {
  if (wr == null) return null
  return wr > 0 && wr <= 1 ? wr * 100 : wr
}

// ─── Metric computation ───────────────────────────────────────────────────────

function fmtRoi(v: number | null): string {
  if (v == null) return 'N/A'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function fmtPct(v: number | null): string {
  if (v == null) return 'N/A'
  return `${v.toFixed(1)}%`
}

function fmtMDD(v: number | null): string {
  if (v == null) return 'N/A'
  return `-${Math.abs(v).toFixed(1)}%`
}

function fmtPnl(v: number | null): string {
  if (v == null) return 'N/A'
  const abs = Math.abs(v)
  const sign = v >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function fmtCount(v: number | null): string {
  if (v == null) return 'N/A'
  return v.toLocaleString()
}

function buildMetrics(a: PKTraderData, b: PKTraderData): MetricRow[] {
  function compare(
    rawA: number | null,
    rawB: number | null,
    higherIsBetter: boolean
  ): 'a' | 'b' | 'tie' | null {
    if (rawA == null || rawB == null) return null
    if (rawA === rawB) return 'tie'
    if (higherIsBetter) return rawA > rawB ? 'a' : 'b'
    // lower is better (e.g. max_drawdown — less negative is better)
    return rawA < rawB ? 'a' : 'b'
  }

  return [
    {
      label: 'ROI',
      a_raw: a.roi,
      b_raw: b.roi,
      a_display: fmtRoi(a.roi),
      b_display: fmtRoi(b.roi),
      winner: compare(a.roi, b.roi, true),
    },
    {
      label: 'Win Rate',
      a_raw: a.win_rate,
      b_raw: b.win_rate,
      a_display: fmtPct(a.win_rate),
      b_display: fmtPct(b.win_rate),
      winner: compare(a.win_rate, b.win_rate, true),
    },
    {
      label: 'Max Drawdown',
      // max_drawdown is typically stored as a negative number (e.g. -15.5)
      // lower absolute value = better → compare raw (less negative = higher = better)
      a_raw: a.max_drawdown,
      b_raw: b.max_drawdown,
      a_display: fmtMDD(a.max_drawdown),
      b_display: fmtMDD(b.max_drawdown),
      winner: compare(a.max_drawdown, b.max_drawdown, true), // higher = less negative = better
    },
    {
      label: 'Arena Score',
      a_raw: a.arena_score,
      b_raw: b.arena_score,
      a_display: a.arena_score != null ? a.arena_score.toFixed(0) : 'N/A',
      b_display: b.arena_score != null ? b.arena_score.toFixed(0) : 'N/A',
      winner: compare(a.arena_score, b.arena_score, true),
    },
    {
      label: 'Trades',
      a_raw: a.trades_count,
      b_raw: b.trades_count,
      a_display: fmtCount(a.trades_count),
      b_display: fmtCount(b.trades_count),
      winner: compare(a.trades_count, b.trades_count, true),
    },
    {
      label: 'PnL',
      a_raw: a.pnl,
      b_raw: b.pnl,
      a_display: fmtPnl(a.pnl),
      b_display: fmtPnl(b.pnl),
      winner: compare(a.pnl, b.pnl, true),
    },
  ]
}

function computeOverallWinner(
  metrics: MetricRow[],
  nameA: string,
  nameB: string
): { winner: string | null; aWins: number; bWins: number; total: number } {
  let aWins = 0
  let bWins = 0
  let total = 0

  for (const m of metrics) {
    if (m.winner === 'a') {
      aWins++
      total++
    } else if (m.winner === 'b') {
      bWins++
      total++
    } else if (m.winner === 'tie') {
      total++
    }
  }

  const winner =
    aWins > bWins ? nameA : bWins > aWins ? nameB : aWins > 0 ? 'TIE' : null

  return { winner, aWins, bWins, total }
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ trader_a: string; trader_b: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
}): Promise<Metadata> {
  const { trader_a, trader_b } = await params
  const sp = await searchParams
  const platform = sp.platform || ''
  const timeWindow = sp.window || '90d'

  const handleA = decodeURIComponent(trader_a)
  const handleB = decodeURIComponent(trader_b)

  const pageUrl = `${BASE_URL}/pk/${encodeURIComponent(handleA)}/${encodeURIComponent(handleB)}${
    platform ? `?platform=${encodeURIComponent(platform)}` : ''
  }`
  const ogImageUrl = `${BASE_URL}/api/og/pk?a=${encodeURIComponent(handleA)}&b=${encodeURIComponent(handleB)}${
    platform ? `&platform=${encodeURIComponent(platform)}` : ''
  }&window=${encodeURIComponent(timeWindow)}`

  const title = `${handleA} vs ${handleB} | Arena PK`
  const description = `Trader PK: ${handleA} challenges ${handleB} on Arena. See who wins across ROI, Win Rate, Arena Score and more.`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: pageUrl,
      siteName: 'Arena',
      type: 'website',
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${handleA} vs ${handleB} Arena PK`,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
    },
    alternates: { canonical: pageUrl },
  }
}

// ─── Page params ──────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic'

// ─── UI helpers ───────────────────────────────────────────────────────────────

const COLOR = {
  bg: '#0A0912',
  card: '#12111A',
  border: 'rgba(139,111,168,0.2)',
  text: '#EDEDED',
  sub: '#888888',
  brand: '#8b6fa8',
  gold: '#FFD700',
  success: '#4DFF9A',
  error: '#FF4D4D',
  winnerGold: '#FFD700',
  loser: 'rgba(237,237,237,0.35)',
}

interface AvatarInitialProps {
  name: string
  gradient?: string
  size?: number
}

function AvatarInitial({
  name,
  gradient = 'linear-gradient(135deg, #8b6fa8 0%, #6366f1 100%)',
  size = 64,
}: AvatarInitialProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: gradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.42,
        fontWeight: 900,
        color: '#fff',
        flexShrink: 0,
        boxShadow: '0 0 20px rgba(139,111,168,0.3)',
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Page component ───────────────────────────────────────────────────────────

export default async function PKPage({
  params,
  searchParams,
}: {
  params: Promise<{ trader_a: string; trader_b: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
}) {
  const { trader_a, trader_b } = await params
  const sp = await searchParams
  const platform = sp.platform || ''
  const timeWindow = (sp.window || '90d').toLowerCase()

  const handleA = decodeURIComponent(trader_a)
  const handleB = decodeURIComponent(trader_b)

  // Fetch both traders in parallel
  const [dataA, dataB] = await Promise.all([
    fetchPKTrader(handleA, platform || null, timeWindow),
    fetchPKTrader(handleB, platform || null, timeWindow),
  ])

  if (!dataA && !dataB) {
    notFound()
  }

  const nameA = dataA?.display_name || handleA
  const nameB = dataB?.display_name || handleB

  const metrics = dataA && dataB ? buildMetrics(dataA, dataB) : []
  const overall =
    dataA && dataB ? computeOverallWinner(metrics, nameA, nameB) : null

  const windowLabel =
    timeWindow === '7d' ? '7D' : timeWindow === '30d' ? '30D' : '90D'

  const pkUrl = `${BASE_URL}/pk/${encodeURIComponent(handleA)}/${encodeURIComponent(handleB)}${
    platform ? `?platform=${encodeURIComponent(platform)}` : ''
  }`

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `linear-gradient(160deg, ${COLOR.bg} 0%, #130f1e 40%, #0f0d19 70%, ${COLOR.bg} 100%)`,
        color: COLOR.text,
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      {/* Top gradient accent bar */}
      <div
        style={{
          height: 3,
          background:
            'linear-gradient(90deg, #8b6fa8 0%, #FFD700 50%, #8b6fa8 100%)',
        }}
      />

      <div
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '32px 20px 64px',
        }}
      >
        {/* Breadcrumb nav */}
        <nav
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 32,
            fontSize: 13,
            color: COLOR.sub,
          }}
        >
          <Link
            href="/"
            style={{ color: COLOR.sub, textDecoration: 'none' }}
          >
            Arena
          </Link>
          <span>/</span>
          <Link
            href={`/trader/${encodeURIComponent(handleA)}`}
            style={{ color: COLOR.sub, textDecoration: 'none' }}
          >
            {nameA}
          </Link>
          <span>/</span>
          <span style={{ color: COLOR.brand }}>PK</span>
        </nav>

        {/* Page title */}
        <div
          style={{
            textAlign: 'center',
            marginBottom: 40,
          }}
        >
          <div
            style={{
              fontSize: 12,
              letterSpacing: 5,
              color: COLOR.sub,
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            ARENA PK — {windowLabel} BATTLE
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 36,
              fontWeight: 900,
              background:
                'linear-gradient(90deg, #8b6fa8 0%, #FFD700 50%, #8b6fa8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: -1,
            }}
          >
            TRADER SHOWDOWN
          </h1>
        </div>

        {/* Fighter cards row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            gap: 0,
            alignItems: 'center',
            marginBottom: 40,
          }}
        >
          {/* Fighter A */}
          <div
            style={{
              background: `linear-gradient(135deg, rgba(139,111,168,0.1) 0%, rgba(139,111,168,0.04) 100%)`,
              border: '1px solid rgba(139,111,168,0.3)',
              borderRadius: '16px 0 0 16px',
              padding: '28px 32px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              position: 'relative',
            }}
          >
            {dataA ? (
              <>
                <AvatarInitial
                  name={nameA}
                  gradient="linear-gradient(135deg, #8b6fa8 0%, #6366f1 100%)"
                  size={72}
                />
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 800,
                    color: COLOR.text,
                    textAlign: 'center',
                  }}
                >
                  {nameA.length > 18 ? nameA.slice(0, 18) + '...' : nameA}
                </div>
                {dataA.rank != null && (
                  <div
                    style={{
                      fontSize: 12,
                      color: COLOR.gold,
                      fontWeight: 700,
                    }}
                  >
                    #{dataA.rank} Ranked
                  </div>
                )}
                <Link
                  href={`/trader/${encodeURIComponent(handleA)}`}
                  style={{
                    fontSize: 12,
                    color: COLOR.brand,
                    textDecoration: 'none',
                    marginTop: 4,
                  }}
                >
                  View Profile
                </Link>
              </>
            ) : (
              <div style={{ color: COLOR.sub, fontSize: 14 }}>
                Trader not found
              </div>
            )}
          </div>

          {/* VS center */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '28px 24px',
              background: 'rgba(255,215,0,0.04)',
              borderTop: '1px solid rgba(255,215,0,0.15)',
              borderBottom: '1px solid rgba(255,215,0,0.15)',
            }}
          >
            <div
              style={{
                fontSize: 56,
                fontWeight: 900,
                color: COLOR.gold,
                letterSpacing: -3,
                lineHeight: 1,
                textShadow: '0 0 30px rgba(255,215,0,0.5)',
              }}
            >
              VS
            </div>
          </div>

          {/* Fighter B */}
          <div
            style={{
              background: `linear-gradient(225deg, rgba(99,102,241,0.1) 0%, rgba(99,102,241,0.04) 100%)`,
              border: '1px solid rgba(99,102,241,0.3)',
              borderRadius: '0 16px 16px 0',
              padding: '28px 32px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            {dataB ? (
              <>
                <AvatarInitial
                  name={nameB}
                  gradient="linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)"
                  size={72}
                />
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 800,
                    color: COLOR.text,
                    textAlign: 'center',
                  }}
                >
                  {nameB.length > 18 ? nameB.slice(0, 18) + '...' : nameB}
                </div>
                {dataB.rank != null && (
                  <div
                    style={{
                      fontSize: 12,
                      color: '#818cf8',
                      fontWeight: 700,
                    }}
                  >
                    #{dataB.rank} Ranked
                  </div>
                )}
                <Link
                  href={`/trader/${encodeURIComponent(handleB)}`}
                  style={{
                    fontSize: 12,
                    color: '#818cf8',
                    textDecoration: 'none',
                    marginTop: 4,
                  }}
                >
                  View Profile
                </Link>
              </>
            ) : (
              <div style={{ color: COLOR.sub, fontSize: 14 }}>
                Trader not found
              </div>
            )}
          </div>
        </div>

        {/* Metrics comparison table */}
        {metrics.length > 0 && (
          <div
            style={{
              background: COLOR.card,
              border: `1px solid ${COLOR.border}`,
              borderRadius: 16,
              overflow: 'hidden',
              marginBottom: 32,
            }}
          >
            {/* Table header */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 120px 1fr',
                padding: '12px 24px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: COLOR.brand,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  textAlign: 'center',
                }}
              >
                {nameA.length > 14 ? nameA.slice(0, 14) + '...' : nameA}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: COLOR.sub,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  textAlign: 'center',
                }}
              >
                METRIC
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#818cf8',
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  textAlign: 'center',
                }}
              >
                {nameB.length > 14 ? nameB.slice(0, 14) + '...' : nameB}
              </div>
            </div>

            {/* Metric rows */}
            {metrics.map((m, i) => {
              const aWins = m.winner === 'a'
              const bWins = m.winner === 'b'

              return (
                <div
                  key={m.label}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 120px 1fr',
                    padding: '16px 24px',
                    borderBottom:
                      i < metrics.length - 1
                        ? '1px solid rgba(255,255,255,0.04)'
                        : 'none',
                    background: aWins
                      ? 'rgba(255,215,0,0.025)'
                      : bWins
                      ? 'rgba(99,102,241,0.025)'
                      : 'transparent',
                    alignItems: 'center',
                  }}
                >
                  {/* Trader A value */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                    }}
                  >
                    {aWins && (
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: COLOR.gold,
                          flexShrink: 0,
                          boxShadow: '0 0 6px rgba(255,215,0,0.8)',
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 20,
                        fontWeight: 800,
                        color: aWins
                          ? COLOR.winnerGold
                          : bWins
                          ? COLOR.loser
                          : COLOR.text,
                        fontFamily:
                          '"SF Mono", "Fira Code", "Cascadia Code", monospace',
                        letterSpacing: -0.5,
                      }}
                    >
                      {m.a_display}
                    </span>
                    {aWins && (
                      <div
                        style={{
                          padding: '2px 7px',
                          borderRadius: 20,
                          background: 'rgba(255,215,0,0.15)',
                          border: '1px solid rgba(255,215,0,0.4)',
                          fontSize: 10,
                          fontWeight: 700,
                          color: COLOR.gold,
                          letterSpacing: 1,
                        }}
                      >
                        WIN
                      </div>
                    )}
                  </div>

                  {/* Center metric label */}
                  <div
                    style={{
                      textAlign: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                      color: COLOR.sub,
                      textTransform: 'uppercase',
                      letterSpacing: 1,
                    }}
                  >
                    {m.label}
                  </div>

                  {/* Trader B value */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      flexDirection: 'row-reverse',
                    }}
                  >
                    {bWins && (
                      <div
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: '#818cf8',
                          flexShrink: 0,
                          boxShadow: '0 0 6px rgba(129,140,248,0.8)',
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 20,
                        fontWeight: 800,
                        color: bWins
                          ? '#818cf8'
                          : aWins
                          ? COLOR.loser
                          : COLOR.text,
                        fontFamily:
                          '"SF Mono", "Fira Code", "Cascadia Code", monospace',
                        letterSpacing: -0.5,
                      }}
                    >
                      {m.b_display}
                    </span>
                    {bWins && (
                      <div
                        style={{
                          padding: '2px 7px',
                          borderRadius: 20,
                          background: 'rgba(129,140,248,0.15)',
                          border: '1px solid rgba(129,140,248,0.4)',
                          fontSize: 10,
                          fontWeight: 700,
                          color: '#818cf8',
                          letterSpacing: 1,
                        }}
                      >
                        WIN
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Overall winner banner */}
        {overall && overall.winner && (
          <div
            style={{
              textAlign: 'center',
              padding: '28px 24px',
              marginBottom: 32,
              background:
                overall.winner === nameA
                  ? 'linear-gradient(135deg, rgba(255,215,0,0.08) 0%, rgba(255,215,0,0.03) 100%)'
                  : overall.winner === nameB
                  ? 'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(99,102,241,0.03) 100%)'
                  : 'rgba(255,255,255,0.03)',
              border:
                overall.winner === nameA
                  ? '1px solid rgba(255,215,0,0.3)'
                  : overall.winner === nameB
                  ? '1px solid rgba(99,102,241,0.3)'
                  : '1px solid rgba(255,255,255,0.1)',
              borderRadius: 16,
            }}
          >
            <div
              style={{
                fontSize: 12,
                letterSpacing: 4,
                color: COLOR.sub,
                textTransform: 'uppercase',
                marginBottom: 10,
              }}
            >
              {overall.winner === 'TIE'
                ? 'RESULT'
                : `${overall.aWins} vs ${overall.bWins} metrics`}
            </div>
            <div
              style={{
                fontSize: 32,
                fontWeight: 900,
                color:
                  overall.winner === nameA
                    ? COLOR.gold
                    : overall.winner === nameB
                    ? '#818cf8'
                    : COLOR.sub,
                letterSpacing: -1,
              }}
            >
              {overall.winner === 'TIE'
                ? 'TIED'
                : `Winner: ${overall.winner}`}
            </div>
            {overall.winner !== 'TIE' && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 14,
                  color: COLOR.sub,
                }}
              >
                wins{' '}
                {overall.winner === nameA ? overall.aWins : overall.bWins}/
                {overall.total} metrics
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <PKPageClient
            handleA={handleA}
            handleB={handleB}
            platform={platform}
            window={timeWindow}
            nameA={nameA}
            nameB={nameB}
            pkUrl={pkUrl}
          />
        </div>

        {/* Footer note */}
        <div
          style={{
            textAlign: 'center',
            marginTop: 48,
            fontSize: 12,
            color: 'rgba(255,255,255,0.2)',
          }}
        >
          arena.arenafi.org — Transparent Crypto Trader Rankings
        </div>
      </div>
    </div>
  )
}
