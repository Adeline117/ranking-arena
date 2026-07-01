/**
 * OG Image for the Arena homepage
 * GET /api/og/homepage
 *
 * Generates a 1200x630 social card with Arena branding, stats,
 * and exchange names. Replaces the static /og-image.png which
 * had broken Chinese font rendering.
 */

import { ImageResponse } from 'next/og'

export const runtime = 'edge'

export async function GET() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(145deg, #0f0f1a 0%, #1a1a2e 55%, #0f0f1a 100%)',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent bar — purple/gold gradient */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 5,
          background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
          display: 'flex',
        }}
      />

      {/* Background decorative gradient circles */}
      <div
        style={{
          position: 'absolute',
          top: -100,
          right: -60,
          width: 500,
          height: 500,
          background: 'radial-gradient(circle, rgba(139,92,246,0.12) 0%, transparent 65%)',
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: -80,
          left: -40,
          width: 400,
          height: 400,
          background: 'radial-gradient(circle, rgba(212,175,55,0.08) 0%, transparent 65%)',
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 200,
          left: 600,
          width: 300,
          height: 300,
          background: 'radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 60%)',
          display: 'flex',
        }}
      />

      {/* Main content */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          height: '100%',
          padding: '60px 72px',
          zIndex: 1,
        }}
      >
        {/* Brand name */}
        <div
          style={{
            fontSize: 64,
            fontWeight: 900,
            color: '#FFFFFF',
            letterSpacing: '-1px',
            lineHeight: 1,
            display: 'flex',
          }}
        >
          Arena
        </div>

        {/* Subtitle */}
        <div
          style={{
            fontSize: 30,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.7)',
            marginTop: 16,
            letterSpacing: '-0.3px',
            display: 'flex',
          }}
        >
          Crypto Trader Rankings
        </div>

        {/* Stats line */}
        <div
          style={{
            fontSize: 19,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.45)',
            marginTop: 32,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ color: '#D4AF37', fontWeight: 700 }}>8,000+</span>
          <span>Traders</span>
          <span style={{ color: 'rgba(255,255,255,0.2)', margin: '0 4px' }}>·</span>
          <span style={{ color: '#D4AF37', fontWeight: 700 }}>30+</span>
          <span>Exchanges</span>
          <span style={{ color: 'rgba(255,255,255,0.2)', margin: '0 4px' }}>·</span>
          <span>Real-time Rankings</span>
        </div>

        {/* Exchange names */}
        <div
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.25)',
            marginTop: 20,
            letterSpacing: '0.3px',
            display: 'flex',
          }}
        >
          Binance · Bybit · OKX · Bitget · Hyperliquid · MEXC · dYdX · GMX
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '20px 72px',
          borderTop: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.35)',
            display: 'flex',
          }}
        >
          arenafi.org
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'rgba(255,255,255,0.2)',
            display: 'flex',
          }}
        >
          All rankings in crypto
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    }
  )
}
