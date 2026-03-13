/**
 * Compare traders OG image
 * GET /api/og/compare?ids=id1,id2,id3
 *
 * Generates a 1200x630 comparison card showing 2-3 traders side by side.
 * Fetches data from DB since compare needs multiple traders.
 * Edge runtime compatible.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

const C = {
  bgTop: '#0A0A0F',
  bgBottom: '#1A1A2E',
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  purpleDim: 'rgba(139,92,246,0.18)',
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  success: '#2FE57D',
  error: '#FF5555',
  border: 'rgba(139,92,246,0.25)',
  borderGold: 'rgba(212,175,55,0.35)',
}

function formatRoi(roi: number): string {
  const abs = Math.abs(roi)
  const sign = roi >= 0 ? '+' : '-'
  if (abs >= 10000) return sign + Math.round(abs / 1000) + 'K%'
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K%'
  return sign + abs.toFixed(1) + '%'
}

interface TraderData {
  name: string
  platform: string
  roi: number
  score: number
  pnl: number
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  // Accept pre-encoded data via query params for Edge compatibility
  // Format: names=A,B,C&platforms=binance,bybit&rois=10.5,-3.2&scores=85,72&pnls=1000,-500
  const names = (searchParams.get('names') || '').split(',').filter(Boolean)
  const platforms = (searchParams.get('platforms') || '').split(',').filter(Boolean)
  const rois = (searchParams.get('rois') || '').split(',').map(Number)
  const scores = (searchParams.get('scores') || '').split(',').map(Number)
  const pnls = (searchParams.get('pnls') || '').split(',').map(Number)

  const traders: TraderData[] = names.slice(0, 3).map((name, i) => ({
    name,
    platform: platforms[i] || '',
    roi: rois[i] || 0,
    score: scores[i] || 0,
    pnl: pnls[i] || 0,
  }))

  if (traders.length === 0) {
    traders.push({ name: 'Trader A', platform: '', roi: 0, score: 0, pnl: 0 })
  }

  const cardWidth = traders.length === 1 ? 900 : traders.length === 2 ? 440 : 280

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(180deg, #0A0A0F 0%, #1A1A2E 100%)',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background blobs */}
        <div style={{
          position: 'absolute', top: -100, left: -60, width: 400, height: 400,
          background: 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)',
          display: 'flex',
        }} />
        <div style={{
          position: 'absolute', bottom: -80, right: -40, width: 350, height: 350,
          background: 'radial-gradient(circle, rgba(212,175,55,0.10) 0%, transparent 70%)',
          display: 'flex',
        }} />

        {/* Top accent bar */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
          display: 'flex',
        }} />

        {/* Content */}
        <div style={{
          position: 'relative', display: 'flex', flexDirection: 'column',
          height: '100%', padding: '40px 56px 36px', zIndex: 1,
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: C.gold, display: 'flex' }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>
                ARENA
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.purpleLight, marginLeft: 8 }}>
                TRADER COMPARISON
              </span>
            </div>
            <span style={{ fontSize: 13, color: C.dimmer }}>arenafi.org</span>
          </div>

          {/* Trader cards */}
          <div style={{
            display: 'flex', gap: 20, flex: 1, justifyContent: 'center', alignItems: 'stretch',
          }}>
            {traders.map((trader, i) => {
              const roiColor = trader.roi >= 0 ? C.success : C.error
              return (
                <div
                  key={i}
                  style={{
                    width: cardWidth,
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '28px 24px',
                    borderRadius: 16,
                    background: 'rgba(255,255,255,0.03)',
                    border: i === 0 ? '1px solid ' + C.borderGold : '1px solid rgba(255,255,255,0.08)',
                    gap: 20,
                  }}
                >
                  {/* Name */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{
                      fontSize: traders.length <= 2 ? 24 : 18,
                      fontWeight: 900, color: C.white, letterSpacing: '-0.5px',
                      overflow: 'hidden', display: 'flex',
                    }}>
                      {trader.name.length > 16 ? trader.name.slice(0, 16) + '...' : trader.name}
                    </span>
                    {trader.platform && (
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.dim }}>
                        {trader.platform}
                      </span>
                    )}
                  </div>

                  {/* Score */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: C.goldLight, letterSpacing: '2px', display: 'flex' }}>
                      SCORE
                    </span>
                    <span style={{
                      fontSize: traders.length <= 2 ? 40 : 32,
                      fontWeight: 900, color: C.goldLight, letterSpacing: '-1px', lineHeight: 1, display: 'flex',
                    }}>
                      {!isNaN(trader.score) && trader.score > 0 ? Math.round(trader.score).toString() : '--'}
                    </span>
                  </div>

                  {/* ROI */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                      ROI
                    </span>
                    <span style={{
                      fontSize: traders.length <= 2 ? 36 : 28,
                      fontWeight: 900, color: roiColor, letterSpacing: '-1px', lineHeight: 1, display: 'flex',
                    }}>
                      {formatRoi(trader.roi)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Bottom CTA */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)',
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.dim }}>
              Compare traders at arenafi.org/compare
            </span>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
      },
    }
  )
}
