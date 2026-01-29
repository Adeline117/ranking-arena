/**
 * Dynamic Open Graph Image Generator
 * Generates trader card images for social sharing
 * 
 * Usage: /api/og?handle=TraderName&roi=123.45&winRate=67.8&mdd=12.3&score=85.2&source=binance
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

// Cache OG images for 1 hour, stale-while-revalidate for 24 hours
export const revalidate = 3600

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl

  const handle = searchParams.get('handle') || 'Trader'
  const roi = searchParams.get('roi') ? parseFloat(searchParams.get('roi')!) : null
  const winRate = searchParams.get('winRate') ? parseFloat(searchParams.get('winRate')!) : null
  const mdd = searchParams.get('mdd') ? parseFloat(searchParams.get('mdd')!) : null
  const score = searchParams.get('score') ? parseFloat(searchParams.get('score')!) : null
  const source = searchParams.get('source') || ''
  const avatar = searchParams.get('avatar') || ''

  const roiColor = roi != null && roi >= 0 ? '#22c55e' : '#ef4444'
  const roiSign = roi != null && roi >= 0 ? '+' : ''

  try {
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'linear-gradient(135deg, #0B0A10 0%, #1a1625 50%, #0B0A10 100%)',
            padding: '48px 56px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            position: 'relative',
          }}
        >
          {/* Background accent */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: '400px',
              height: '400px',
              background: 'radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)',
              display: 'flex',
            }}
          />

          {/* Top bar: Arena branding */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '40px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              }}
            >
              <div
                style={{
                  fontSize: '28px',
                  fontWeight: 800,
                  color: '#ffffff',
                  letterSpacing: '-0.5px',
                  display: 'flex',
                }}
              >
                Arena
              </div>
              <div
                style={{
                  fontSize: '14px',
                  color: '#9ca3af',
                  display: 'flex',
                }}
              >
                Crypto Trader Leaderboard
              </div>
            </div>
            {source && (
              <div
                style={{
                  display: 'flex',
                  padding: '6px 14px',
                  borderRadius: '20px',
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  fontSize: '14px',
                  color: '#d1d5db',
                  textTransform: 'capitalize',
                }}
              >
                {source}
              </div>
            )}
          </div>

          {/* Main content: trader info */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '28px',
              marginBottom: '44px',
            }}
          >
            {/* Avatar */}
            <div
              style={{
                width: '88px',
                height: '88px',
                borderRadius: '50%',
                background: avatar
                  ? undefined
                  : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '36px',
                fontWeight: 700,
                color: '#ffffff',
                border: '3px solid rgba(99,102,241,0.5)',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar}
                  alt=""
                  width={88}
                  height={88}
                  style={{ objectFit: 'cover' }}
                />
              ) : (
                handle.charAt(0).toUpperCase()
              )}
            </div>

            {/* Name and ROI */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div
                style={{
                  fontSize: '36px',
                  fontWeight: 800,
                  color: '#ffffff',
                  letterSpacing: '-0.5px',
                  display: 'flex',
                }}
              >
                {handle.length > 24 ? handle.slice(0, 22) + '...' : handle}
              </div>
              {roi != null && (
                <div
                  style={{
                    fontSize: '22px',
                    fontWeight: 700,
                    color: roiColor,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  90D ROI: {roiSign}{roi.toFixed(2)}%
                </div>
              )}
            </div>
          </div>

          {/* Stats grid */}
          <div
            style={{
              display: 'flex',
              gap: '20px',
              flex: 1,
            }}
          >
            {/* Stat cards */}
            {[
              { label: 'Arena Score', value: score != null ? score.toFixed(1) : '--', color: '#818cf8' },
              { label: 'Win Rate', value: winRate != null ? `${winRate.toFixed(1)}%` : '--', color: '#22c55e' },
              { label: 'Max Drawdown', value: mdd != null ? `${mdd.toFixed(1)}%` : '--', color: '#f97316' },
            ].map((stat) => (
              <div
                key={stat.label}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  padding: '24px',
                  borderRadius: '16px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div
                  style={{
                    fontSize: '14px',
                    color: '#9ca3af',
                    marginBottom: '8px',
                    display: 'flex',
                  }}
                >
                  {stat.label}
                </div>
                <div
                  style={{
                    fontSize: '32px',
                    fontWeight: 800,
                    color: stat.color,
                    display: 'flex',
                  }}
                >
                  {stat.value}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '32px',
              paddingTop: '20px',
              borderTop: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div
              style={{
                fontSize: '14px',
                color: '#6b7280',
                display: 'flex',
              }}
            >
              arenafi.org
            </div>
            <div
              style={{
                fontSize: '13px',
                color: '#6b7280',
                display: 'flex',
              }}
            >
              Data from 22+ exchanges · Updated 24/7
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    )
  } catch (error) {
    console.error('[OG] Image generation failed:', error)
    // Fallback: return a simple text-based OG image
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0B0A10',
            color: '#ffffff',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div style={{ fontSize: '48px', fontWeight: 800, marginBottom: '16px', display: 'flex' }}>
            Arena
          </div>
          <div style={{ fontSize: '24px', color: '#9ca3af', display: 'flex' }}>
            Crypto Trader Leaderboard
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    )
  }
}
