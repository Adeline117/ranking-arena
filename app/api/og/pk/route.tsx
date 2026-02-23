/**
 * PK OG Image API
 * GET /api/og/pk?a=trader_a_handle&b=trader_b_handle&platform=xxx&window=7d
 *
 * Generates a 1200x630 social card for trader PK comparison.
 * Uses @vercel/og (bundled in next/og) at edge runtime.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'edge'

const C = {
  bg: '#0A0912',
  panel: '#14131A',
  text: '#EDEDED',
  sub: '#888888',
  brand: '#8b6fa8',
  gold: '#FFD700',
  success: '#4DFF9A',
  error: '#FF4D4D',
  border: 'rgba(139,111,168,0.3)',
}

interface OGTrader {
  name: string
  avatar_url: string | null
  roi: number | null
  win_rate: number | null
  arena_score: number | null
  pnl: number | null
  max_drawdown: number | null
}

async function fetchOGTrader(
  handle: string,
  platform: string | null
): Promise<OGTrader | null> {
  const url =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  if (!url || !key) return null

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  type TraderSourceRow = {
    handle: string
    avatar_url: string | null
    source: string
    source_trader_id: string
  }

  let q = supabase
    .from('trader_sources')
    .select('handle, avatar_url, source, source_trader_id')
    .ilike('handle', handle)

  if (platform) {
    q = q.eq('source', platform)
  }

  const { data: src } = (await q.limit(1).maybeSingle()) as {
    data: TraderSourceRow | null
  }
  if (!src) return null

  type LeaderboardRow = {
    display_name: string | null
    roi: number | null
    pnl: number | null
    win_rate: number | null
    max_drawdown: number | null
    arena_score: number | null
  }

  const { data: lr } = (await supabase
    .from('leaderboard_ranks')
    .select(
      'display_name, roi, pnl, win_rate, max_drawdown, arena_score'
    )
    .eq('source', src.source)
    .eq('source_trader_id', src.source_trader_id)
    .maybeSingle()) as { data: LeaderboardRow | null }

  const wr = lr?.win_rate ?? null
  const winRateNormalized =
    wr != null ? (wr > 0 && wr <= 1 ? wr * 100 : wr) : null

  return {
    name: lr?.display_name || src.handle || handle,
    avatar_url: src.avatar_url,
    roi: lr?.roi ?? null,
    win_rate: winRateNormalized,
    arena_score: lr?.arena_score ?? null,
    pnl: lr?.pnl ?? null,
    max_drawdown: lr?.max_drawdown ?? null,
  }
}

function fmtRoi(v: number | null): string {
  if (v == null) return 'N/A'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

function fmtWR(v: number | null): string {
  if (v == null) return 'N/A'
  return `${v.toFixed(0)}%`
}

function fmtScore(v: number | null): string {
  if (v == null) return '--'
  return v.toFixed(0)
}

// Determine ROI color
function roiColor(roi: number | null): string {
  if (roi == null) return C.sub
  return roi >= 0 ? C.success : C.error
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const a = searchParams.get('a') || ''
  const b = searchParams.get('b') || ''
  const platform = searchParams.get('platform') || null

  if (!a || !b) {
    return new Response('Missing a or b parameter', { status: 400 })
  }

  const [traderA, traderB] = await Promise.all([
    fetchOGTrader(a, platform),
    fetchOGTrader(b, platform),
  ])

  const nameA = (traderA?.name || a).slice(0, 16)
  const nameB = (traderB?.name || b).slice(0, 16)

  // Determine simple winner by ROI for OG card
  const roiA = traderA?.roi ?? null
  const roiB = traderB?.roi ?? null
  let winnerLabel = 'WHO WINS?'
  if (roiA != null && roiB != null) {
    if (roiA > roiB) winnerLabel = `${nameA} LEADS`
    else if (roiB > roiA) winnerLabel = `${nameB} LEADS`
    else winnerLabel = 'TIED'
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(135deg, ${C.bg} 0%, #1a1225 40%, #130f1e 70%, ${C.bg} 100%)`,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Top gradient bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 5,
            background: 'linear-gradient(90deg, #8b6fa8 0%, #FFD700 50%, #8b6fa8 100%)',
            display: 'flex',
          }}
        />

        {/* Background glow effects */}
        <div
          style={{
            position: 'absolute',
            left: -100,
            top: -100,
            width: 500,
            height: 500,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(139,111,168,0.08) 0%, transparent 70%)',
            display: 'flex',
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: -100,
            bottom: -100,
            width: 500,
            height: 500,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,215,0,0.05) 0%, transparent 70%)',
            display: 'flex',
          }}
        />

        {/* Header row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            paddingTop: 28,
            gap: 12,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: C.sub,
              letterSpacing: 5,
              textTransform: 'uppercase',
            }}
          >
            ARENA
          </span>
          <span
            style={{
              fontSize: 22,
              fontWeight: 900,
              color: C.gold,
              letterSpacing: 2,
            }}
          >
            TRADER PK
          </span>
        </div>

        {/* Main battle area */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'center',
            padding: '0 56px',
            gap: 0,
          }}
        >
          {/* Trader A panel */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              padding: '28px 32px',
              background: 'rgba(139,111,168,0.06)',
              border: '1px solid rgba(139,111,168,0.2)',
              borderRadius: 16,
              marginRight: 24,
            }}
          >
            {/* Avatar initial circle */}
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #8b6fa8 0%, #6366f1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 26,
                fontWeight: 900,
                color: '#fff',
                marginBottom: 14,
                boxShadow: '0 0 20px rgba(139,111,168,0.4)',
              }}
            >
              {(traderA?.name || a).charAt(0).toUpperCase()}
            </div>
            {/* Name */}
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: C.text,
                marginBottom: 10,
              }}
            >
              {nameA}
            </div>
            {/* ROI */}
            <div
              style={{
                fontSize: 48,
                fontWeight: 900,
                color: roiColor(roiA),
                letterSpacing: -1,
                lineHeight: 1,
                marginBottom: 14,
              }}
            >
              {fmtRoi(roiA)}
            </div>
            {/* Secondary stats */}
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 12, color: C.sub, textTransform: 'uppercase', letterSpacing: 1 }}>
                  WIN RATE
                </span>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
                  {fmtWR(traderA?.win_rate ?? null)}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <span style={{ fontSize: 12, color: C.sub, textTransform: 'uppercase', letterSpacing: 1 }}>
                  ARENA SCORE
                </span>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.brand }}>
                  {fmtScore(traderA?.arena_score ?? null)}
                </span>
              </div>
            </div>
          </div>

          {/* Center VS */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '0 32px',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: 80,
                fontWeight: 900,
                color: C.gold,
                letterSpacing: -4,
                lineHeight: 1,
                textShadow: '0 0 40px rgba(255,215,0,0.6)',
              }}
            >
              VS
            </div>
            <div
              style={{
                marginTop: 16,
                padding: '6px 16px',
                background: 'rgba(255,215,0,0.1)',
                border: '1px solid rgba(255,215,0,0.3)',
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 700,
                color: C.gold,
                letterSpacing: 2,
                textTransform: 'uppercase',
              }}
            >
              {winnerLabel}
            </div>
          </div>

          {/* Trader B panel */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              padding: '28px 32px',
              background: 'rgba(99,102,241,0.06)',
              border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: 16,
              marginLeft: 24,
              alignItems: 'flex-end',
            }}
          >
            {/* Avatar initial circle */}
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 26,
                fontWeight: 900,
                color: '#fff',
                marginBottom: 14,
                boxShadow: '0 0 20px rgba(99,102,241,0.4)',
              }}
            >
              {(traderB?.name || b).charAt(0).toUpperCase()}
            </div>
            {/* Name */}
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: C.text,
                marginBottom: 10,
                textAlign: 'right',
              }}
            >
              {nameB}
            </div>
            {/* ROI */}
            <div
              style={{
                fontSize: 48,
                fontWeight: 900,
                color: roiColor(roiB),
                letterSpacing: -1,
                lineHeight: 1,
                marginBottom: 14,
                textAlign: 'right',
              }}
            >
              {fmtRoi(roiB)}
            </div>
            {/* Secondary stats - right aligned */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                alignItems: 'flex-end',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexDirection: 'row-reverse',
                }}
              >
                <span style={{ fontSize: 12, color: C.sub, textTransform: 'uppercase', letterSpacing: 1 }}>
                  WIN RATE
                </span>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
                  {fmtWR(traderB?.win_rate ?? null)}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexDirection: 'row-reverse',
                }}
              >
                <span style={{ fontSize: 12, color: C.sub, textTransform: 'uppercase', letterSpacing: 1 }}>
                  ARENA SCORE
                </span>
                <span style={{ fontSize: 18, fontWeight: 700, color: '#6366f1' }}>
                  {fmtScore(traderB?.arena_score ?? null)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '14px 56px 18px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: C.brand,
              letterSpacing: 1,
            }}
          >
            Arena
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>
            arenafi.org
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    }
  )
}
