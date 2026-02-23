/**
 * Spotify Wrapped–style rank card OG image
 * GET /api/og/rank?name=xxx&handle=xxx&rank=N&roi=X&winRate=Y&score=Z&platform=xxx&window=7d&total=T
 *
 * All data is passed via query params — no DB access.
 * Edge runtime compatible (pure ImageResponse).
 * Dimensions: 1200 x 630 (Twitter/X recommended).
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

// Brand color palette
const C = {
  bg: '#060411',
  card: '#0E0A1A',
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
  if (abs >= 10000) return `${sign}${Math.round(abs / 1000)}K%`
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K%`
  return `${sign}${abs.toFixed(1)}%`
}

function getTopPercent(rank: number, total: number): string {
  if (!total || !rank || rank <= 0) return ''
  const pct = rank / total
  if (pct <= 0.001) return 'Top 0.1%'
  if (pct <= 0.01) return 'Top 1%'
  if (pct <= 0.03) return 'Top 3%'
  if (pct <= 0.05) return 'Top 5%'
  if (pct <= 0.10) return 'Top 10%'
  if (pct <= 0.25) return 'Top 25%'
  return `Top ${Math.ceil(pct * 100)}%`
}

function getBeatLabel(rank: number, total: number): string {
  if (!total || !rank || rank <= 0) return ''
  const beat = Math.round(((total - rank) / total) * 100)
  return `Beat ${beat}% of traders`
}

function formatWindow(w: string): string {
  const map: Record<string, string> = { '7d': '7 Day', '30d': '30 Day', '90d': '90 Day', '7D': '7 Day', '30D': '30 Day', '90D': '90 Day' }
  return map[w] ?? w.toUpperCase()
}

function formatPlatform(p: string): string {
  const map: Record<string, string> = {
    binance_futures: 'Binance', binance_spot: 'Binance Spot', binance_web3: 'Binance Web3',
    bybit: 'Bybit', bybit_spot: 'Bybit Spot',
    bitget_futures: 'Bitget', bitget_spot: 'Bitget Spot',
    okx: 'OKX', okx_spot: 'OKX Spot', okx_web3: 'OKX Web3', okx_futures: 'OKX',
    hyperliquid: 'Hyperliquid', gmx: 'GMX', dydx: 'dYdX',
    mexc: 'MEXC', kucoin: 'KuCoin', gateio: 'Gate.io',
    htx_futures: 'HTX', weex: 'Weex', blofin: 'Blofin', coinex: 'CoinEx',
  }
  return map[p] ?? p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const name = searchParams.get('name') || searchParams.get('handle') || 'Trader'
  const rank = parseInt(searchParams.get('rank') || '0', 10)
  const total = parseInt(searchParams.get('total') || '0', 10)
  const roi = parseFloat(searchParams.get('roi') || 'NaN')
  const winRate = parseFloat(searchParams.get('winRate') || 'NaN')
  const score = parseFloat(searchParams.get('score') || 'NaN')
  const platform = searchParams.get('platform') || ''
  const windowParam = searchParams.get('window') || '7d'

  const roiValid = !isNaN(roi)
  const winRateValid = !isNaN(winRate)
  const scoreValid = !isNaN(score)
  const rankValid = rank > 0
  const roiColor = roiValid && roi >= 0 ? C.success : C.error
  const roiStr = roiValid ? formatRoi(roi) : '--'
  const topPct = rankValid && total > 0 ? getTopPercent(rank, total) : ''
  const beatLabel = rankValid && total > 0 ? getBeatLabel(rank, total) : ''
  const platformLabel = platform ? formatPlatform(platform) : ''
  const windowLabel = formatWindow(windowParam)

  // Rank display: show full number if small, abbreviate if large
  const rankDisplay = rankValid ? (rank <= 9999 ? `#${rank}` : `#${(rank / 1000).toFixed(0)}K`) : '--'

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          background: C.bg,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background gradient blobs */}
        <div style={{
          position: 'absolute',
          top: -120,
          left: -80,
          width: 480,
          height: 480,
          background: 'radial-gradient(circle, rgba(139,92,246,0.22) 0%, transparent 70%)',
          display: 'flex',
        }} />
        <div style={{
          position: 'absolute',
          bottom: -100,
          right: -60,
          width: 400,
          height: 400,
          background: 'radial-gradient(circle, rgba(212,175,55,0.16) 0%, transparent 70%)',
          display: 'flex',
        }} />
        <div style={{
          position: 'absolute',
          top: 200,
          right: 200,
          width: 300,
          height: 300,
          background: 'radial-gradient(circle, rgba(139,92,246,0.10) 0%, transparent 70%)',
          display: 'flex',
        }} />

        {/* Subtle grid pattern overlay */}
        <div style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'linear-gradient(rgba(139,92,246,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(139,92,246,0.04) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          display: 'flex',
        }} />

        {/* Main content layout */}
        <div style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'stretch',
          height: '100%',
          zIndex: 1,
        }}>
          {/* LEFT PANEL — rank hero */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: 460,
            padding: '0 48px',
            borderRight: `1px solid ${C.border}`,
            gap: 0,
          }}>
            {/* "ARENA RANK" label */}
            <div style={{
              display: 'flex',
              letterSpacing: '4px',
              fontSize: 13,
              fontWeight: 700,
              color: C.purpleLight,
              textTransform: 'uppercase',
              marginBottom: 12,
            }}>
              ARENA RANK
            </div>

            {/* Giant rank number */}
            <div style={{
              display: 'flex',
              fontSize: rankDisplay.length > 4 ? 100 : 128,
              fontWeight: 900,
              lineHeight: 1,
              letterSpacing: '-4px',
              color: C.white,
              marginBottom: 8,
            }}>
              {rankDisplay}
            </div>

            {/* Top % badge */}
            {topPct && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '6px 20px',
                borderRadius: 999,
                background: C.goldDim,
                border: `1px solid ${C.borderGold}`,
                marginTop: 8,
                marginBottom: 4,
              }}>
                <span style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: C.goldLight,
                  letterSpacing: '1px',
                }}>
                  {topPct} Trader
                </span>
              </div>
            )}

            {/* Beat % label */}
            {beatLabel && (
              <div style={{
                display: 'flex',
                fontSize: 14,
                color: C.dim,
                marginTop: 8,
                fontWeight: 500,
              }}>
                {beatLabel}
              </div>
            )}

            {/* Platform + Window badges */}
            <div style={{
              display: 'flex',
              gap: 8,
              marginTop: 28,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}>
              {platformLabel && (
                <div style={{
                  display: 'flex',
                  padding: '4px 14px',
                  borderRadius: 6,
                  background: C.purpleDim,
                  border: `1px solid ${C.border}`,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.purpleLight, letterSpacing: '0.5px' }}>
                    {platformLabel}
                  </span>
                </div>
              )}
              <div style={{
                display: 'flex',
                padding: '4px 14px',
                borderRadius: 6,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.dim, letterSpacing: '0.5px' }}>
                  {windowLabel}
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT PANEL — stats */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            padding: '48px 56px',
            justifyContent: 'space-between',
          }}>
            {/* Trader name */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.dimmer, letterSpacing: '2px', textTransform: 'uppercase', display: 'flex' }}>
                Trader
              </div>
              <div style={{
                fontSize: name.length > 18 ? 28 : 36,
                fontWeight: 900,
                color: C.white,
                letterSpacing: '-0.5px',
                display: 'flex',
                overflow: 'hidden',
              }}>
                {name.length > 22 ? name.slice(0, 22) + '...' : name}
              </div>
            </div>

            {/* ROI — the hero number */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '24px 28px',
              background: roiValid && roi >= 0
                ? 'rgba(47,229,125,0.07)'
                : 'rgba(255,85,85,0.07)',
              borderRadius: 16,
              border: roiValid && roi >= 0
                ? '1px solid rgba(47,229,125,0.25)'
                : '1px solid rgba(255,85,85,0.25)',
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                RETURN ON INVESTMENT
              </div>
              <div style={{
                fontSize: 72,
                fontWeight: 900,
                color: roiColor,
                letterSpacing: '-2px',
                lineHeight: 1,
                display: 'flex',
              }}>
                {roiStr}
              </div>
            </div>

            {/* Stats row */}
            <div style={{
              display: 'flex',
              gap: 16,
              marginTop: 20,
            }}>
              {/* Arena Score */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                padding: '16px 20px',
                background: C.purpleDim,
                borderRadius: 12,
                border: `1px solid ${C.border}`,
                gap: 6,
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.purpleLight, letterSpacing: '1.5px', display: 'flex' }}>
                  ARENA SCORE
                </div>
                <div style={{ fontSize: 36, fontWeight: 900, color: C.purpleLight, letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>
                  {scoreValid ? Math.round(score).toLocaleString() : '--'}
                </div>
              </div>

              {/* Win Rate */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                padding: '16px 20px',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.08)',
                gap: 6,
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.dim, letterSpacing: '1.5px', display: 'flex' }}>
                  WIN RATE
                </div>
                <div style={{ fontSize: 36, fontWeight: 900, color: C.offWhite, letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>
                  {winRateValid ? `${winRate.toFixed(0)}%` : '--'}
                </div>
              </div>
            </div>

            {/* Watermark */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 20,
            }}>
              <div style={{
                display: 'flex',
                width: 6,
                height: 6,
                borderRadius: 999,
                background: C.gold,
              }} />
              <span style={{ fontSize: 15, fontWeight: 800, color: C.gold, letterSpacing: '1px' }}>
                arenafi.org
              </span>
            </div>
          </div>
        </div>

        {/* Top gradient bar */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
          display: 'flex',
        }} />
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
