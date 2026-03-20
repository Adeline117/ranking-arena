/**
 * Farcaster Frame OG Image for trader cards
 * GET /api/frame/trader?handle=xxx&source=binance_futures&season=90D
 *
 * Generates a 1200×630 card with trader stats from leaderboard_ranks.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { Pool } from 'pg'

export const dynamic = 'force-dynamic'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
})

const C = {
  bg: '#0B0A10',
  card: '#14131A',
  text: '#EDEDED',
  sub: '#9A9A9A',
  brand: '#8b6fa8',
  success: '#4DFF9A',
  error: '#FF4D4D',
  gold: '#FFD700',
}

async function getTrader(handle: string, source?: string, season = '90D') {
  const params: string[] = [handle, season]
  let where = `(lr.handle ILIKE $1 OR lr.source_trader_id = $1) AND lr.season_id = $2`
  if (source) {
    params.push(source)
    where += ` AND lr.source = $3`
  }

  const { rows } = await pool.query(
    `SELECT lr.*, ts.avatar_url AS ts_avatar
     FROM leaderboard_ranks lr
     LEFT JOIN trader_sources ts
       ON ts.source = lr.source
       AND ts.source_trader_id = lr.source_trader_id
     WHERE ${where}
     ORDER BY lr.arena_score DESC NULLS LAST
     LIMIT 1`,
    params,
  )
  return rows[0] || null
}

function platformLabel(source: string) {
  const map: Record<string, string> = {
    binance_futures: 'Binance',
    okx: 'OKX',
    bybit: 'Bybit',
    bitget: 'Bitget',
    gateio: 'Gate.io',
    bingx: 'BingX',
    xt: 'XT',
    gmx: 'GMX',
    hyperliquid: 'Hyperliquid',
  }
  return map[source] || source.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')
    if (!handle) return new Response('Missing handle', { status: 400 })

    const source = searchParams.get('source') || undefined
    const season = searchParams.get('season') || '90D'

    const t = await getTrader(handle, source, season)
    if (!t) return new Response('Trader not found', { status: 404 })

    const name = t.handle || handle
    const displayName = name.length > 22 ? name.slice(0, 22) + '…' : name
    const avatar = t.ts_avatar || t.avatar_url
    const score = t.arena_score ? parseFloat(t.arena_score) : null
    const rank = t.rank
    const roi = t.roi ? parseFloat(t.roi) : null
    const winRate = t.win_rate ? parseFloat(t.win_rate) : null
    const mdd = t.max_drawdown ? parseFloat(t.max_drawdown) : null
    const platform = platformLabel(t.source)

    const roiPositive = roi != null && roi >= 0
    const roiColor = roiPositive ? C.success : C.error
    const roiStr = roi != null ? `${roiPositive ? '+' : ''}${roi.toFixed(2)}%` : 'N/A'

    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: `linear-gradient(145deg, ${C.bg} 0%, #1a1428 40%, #12101c 100%)`,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            padding: '40px 60px',
            position: 'relative',
          }}
        >
          {/* Top bar: platform + season */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  background: 'rgba(139,111,168,0.2)',
                  border: '1px solid rgba(139,111,168,0.4)',
                  borderRadius: 8,
                  padding: '6px 14px',
                  fontSize: 16,
                  color: C.brand,
                  fontWeight: 700,
                }}
              >
                {platform}
              </div>
              <div style={{ fontSize: 14, color: C.sub }}>{season} Performance</div>
            </div>
            {rank != null && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 20,
                  fontWeight: 800,
                  color: rank <= 3 ? C.gold : C.text,
                }}
              >
                #{rank}
              </div>
            )}
          </div>

          {/* Main card */}
          <div
            style={{
              display: 'flex',
              flex: 1,
              background: `linear-gradient(135deg, ${C.card} 0%, #1c1928 100%)`,
              borderRadius: 24,
              border: '1px solid rgba(139,111,168,0.2)',
              padding: '36px 48px',
              gap: 48,
              alignItems: 'center',
            }}
          >
            {/* Left: avatar + name + score */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 200, gap: 16 }}>
              {avatar ? (
                <img
                  src={avatar.startsWith('data:') ? avatar : `${BASE_URL}/api/avatar?url=${encodeURIComponent(avatar)}`}
                  alt="Trader avatar"
                  width={88}
                  height={88}
                  style={{ borderRadius: '50%', border: `3px solid ${C.brand}` }}
                />
              ) : (
                <div
                  style={{
                    width: 88,
                    height: 88,
                    borderRadius: '50%',
                    background: `linear-gradient(135deg, ${C.brand}, #6366f1)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 36,
                    fontWeight: 800,
                    color: '#fff',
                  }}
                >
                  {name.charAt(0).toUpperCase()}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ fontSize: 26, fontWeight: 800, color: C.text, textAlign: 'center' }}>
                  {displayName}
                </div>
                {score != null && (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 14, color: C.sub }}>Arena Score</span>
                    <span style={{ fontSize: 32, fontWeight: 900, color: C.brand }}>{score.toFixed(1)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Divider */}
            <div style={{ width: 1, height: '80%', background: 'rgba(139,111,168,0.2)' }} />

            {/* Right: stats */}
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 24 }}>
              {/* ROI big */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 14, color: C.sub, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Return on Investment
                </span>
                <span style={{ fontSize: 56, fontWeight: 900, color: roiColor, letterSpacing: -2 }}>{roiStr}</span>
              </div>

              {/* Win Rate + MDD */}
              <div style={{ display: 'flex', gap: 48 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13, color: C.sub }}>Win Rate</span>
                  <span style={{ fontSize: 28, fontWeight: 800, color: C.text }}>
                    {winRate != null ? `${winRate.toFixed(1)}%` : 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13, color: C.sub }}>Max Drawdown</span>
                  <span style={{ fontSize: 28, fontWeight: 800, color: C.error }}>
                    {mdd != null ? `-${Math.abs(mdd).toFixed(2)}%` : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom branding */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: C.brand }}>Arena</span>
              <span style={{ fontSize: 14, color: C.sub }}>arenafi.org</span>
            </div>
            <span style={{ fontSize: 12, color: 'rgba(154,154,154,0.5)' }}>Farcaster Frame</span>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        },
      },
    )
  } catch (_e) {
    // Frame OG generation error - logged silently
    return new Response('Failed to generate image', { status: 500 })
  }
}
