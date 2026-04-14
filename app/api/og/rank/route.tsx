/**
 * Spotify Wrapped-style rank card OG image
 * GET /api/og/rank?name=xxx&handle=xxx&rank=N&roi=X&winRate=Y&score=Z&platform=xxx&window=7d&total=T
 *
 * All data is passed via query params -- no DB access.
 * Edge runtime compatible (pure ImageResponse).
 * Dimensions: 1200 x 630 (Twitter/X recommended).
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { safeParseInt } from '@/lib/utils/safe-parse'

export const runtime = 'edge'

// Brand color palette -- dark gradient theme
const C = {
  bgTop: '#0A0A0F',
  bgBottom: '#1A1A2E',
  card: '#12121F',
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

// Platform colors for badges
const PLATFORM_COLORS: Record<string, string> = {
  binance_futures: '#F0B90B', binance_spot: '#F0B90B', binance_web3: '#F0B90B',
  bybit: '#F7A600', bybit_spot: '#F7A600',
  okx: '#FFFFFF', okx_futures: '#FFFFFF', okx_spot: '#FFFFFF',
  bitget_futures: '#00D4AA', bitget_spot: '#00D4AA',
  hyperliquid: '#50E3C2', gmx: '#4B8FEE', dydx: '#6966FF',
  mexc: '#00B897', kucoin: '#24AE8F', gateio: '#2354E6',
  htx_futures: '#2E7CF6', coinex: '#3FB68B',
}

function formatRoi(roi: number): string {
  const abs = Math.abs(roi)
  const sign = roi >= 0 ? '+' : '-'
  if (abs >= 10000) return sign + Math.round(abs / 1000) + 'K%'
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K%'
  return sign + abs.toFixed(1) + '%'
}

function formatPnl(pnl: number): string {
  const abs = Math.abs(pnl)
  const sign = pnl >= 0 ? '+$' : '-$'
  if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + 'M'
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K'
  return sign + abs.toFixed(0)
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
  return 'Top ' + Math.ceil(pct * 100) + '%'
}

function formatWindow(w: string): string {
  const map: Record<string, string> = { '7d': '7D', '30d': '30D', '90d': '90D', '7D': '7D', '30D': '30D', '90D': '90D' }
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
  const rank = safeParseInt(searchParams.get('rank'), 0)
  const total = safeParseInt(searchParams.get('total'), 0)
  const roi = parseFloat(searchParams.get('roi') || 'NaN')
  const winRate = parseFloat(searchParams.get('winRate') || 'NaN')
  const score = parseFloat(searchParams.get('score') || 'NaN')
  const pnl = parseFloat(searchParams.get('pnl') || 'NaN')
  const platform = searchParams.get('platform') || ''
  const windowParam = searchParams.get('window') || '7d'

  const roiValid = !isNaN(roi)
  const winRateValid = !isNaN(winRate)
  const scoreValid = !isNaN(score)
  const pnlValid = !isNaN(pnl)
  const rankValid = rank > 0
  const roiColor = roiValid && roi >= 0 ? C.success : C.error
  const roiStr = roiValid ? formatRoi(roi) : '--'
  const topPct = rankValid && total > 0 ? getTopPercent(rank, total) : ''
  const platformLabel = platform ? formatPlatform(platform) : ''
  const windowLabel = formatWindow(windowParam)
  const platformColor = PLATFORM_COLORS[platform] || C.purpleLight

  const rankDisplay = rankValid ? (rank <= 9999 ? String(rank) : (rank / 1000).toFixed(0) + 'K') : '--'
  const totalDisplay = total > 0 ? total.toLocaleString('en-US') + '+' : '68,000+'

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(180deg, #0A0A0F 0%, #1A1A2E 100%)',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background gradient blobs */}
        <div style={{
          position: 'absolute', top: -120, left: -80, width: 480, height: 480,
          background: 'radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 70%)',
          display: 'flex',
        }} />
        <div style={{
          position: 'absolute', bottom: -100, right: -60, width: 400, height: 400,
          background: 'radial-gradient(circle, rgba(212,175,55,0.12) 0%, transparent 70%)',
          display: 'flex',
        }} />

        {/* Top accent bar */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
          display: 'flex',
        }} />

        {/* Main content */}
        <div style={{
          position: 'relative', display: 'flex', flexDirection: 'column',
          height: '100%', padding: '40px 56px 36px', zIndex: 1,
        }}>
          {/* Top row: Logo + Arena branding */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 8, height: 8, borderRadius: 999, background: C.gold, display: 'flex',
              }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>
                ARENA
              </span>
              <span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>
                arenafi.org
              </span>
            </div>
            {/* Window badge */}
            <div style={{
              display: 'flex', padding: '6px 16px', borderRadius: 8,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
            }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>
                {windowLabel}
              </span>
            </div>
          </div>

          {/* Center: Trader name + platform */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
            <div style={{
              fontSize: name.length > 18 ? 32 : 40,
              fontWeight: 900, color: C.white, letterSpacing: '-0.5px', display: 'flex',
            }}>
              {name.length > 24 ? name.slice(0, 24) + '...' : name}
            </div>
            {platformLabel && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 14px', borderRadius: 6,
                background: platformColor + '15',
                border: '1px solid ' + platformColor + '30',
                alignSelf: 'flex-start',
              }}>
                <div style={{ width: 6, height: 6, borderRadius: 999, background: platformColor, display: 'flex' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: platformColor, letterSpacing: '0.5px' }}>
                  {platformLabel}
                </span>
              </div>
            )}
          </div>

          {/* Data cards row */}
          <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'stretch' }}>
            {/* Arena Score - most prominent, gold accent */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 1.2,
              padding: '20px 24px', borderRadius: 16,
              background: C.goldDim, border: '1px solid ' + C.borderGold, gap: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.goldLight, letterSpacing: '2px', display: 'flex' }}>
                ARENA SCORE
              </span>
              <span style={{
                fontSize: 52, fontWeight: 900, color: C.goldLight,
                letterSpacing: '-2px', lineHeight: 1, display: 'flex',
              }}>
                {scoreValid ? Math.round(score).toString() : '--'}
              </span>
            </div>

            {/* ROI */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 1.2,
              padding: '20px 24px', borderRadius: 16,
              background: roiValid && roi >= 0 ? 'rgba(47,229,125,0.07)' : 'rgba(255,85,85,0.07)',
              border: roiValid && roi >= 0 ? '1px solid rgba(47,229,125,0.25)' : '1px solid rgba(255,85,85,0.25)',
              gap: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                ROI
              </span>
              <span style={{
                fontSize: 48, fontWeight: 900, color: roiColor,
                letterSpacing: '-2px', lineHeight: 1, display: 'flex',
              }}>
                {roiStr}
              </span>
            </div>

            {/* PnL */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 1,
              padding: '20px 24px', borderRadius: 16,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              gap: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                PNL
              </span>
              <span style={{
                fontSize: 36, fontWeight: 900, color: pnlValid ? (pnl >= 0 ? C.success : C.error) : C.offWhite,
                letterSpacing: '-1px', lineHeight: 1, display: 'flex',
              }}>
                {pnlValid ? formatPnl(pnl) : '--'}
              </span>
            </div>

            {/* Win Rate */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 0.8,
              padding: '20px 24px', borderRadius: 16,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              gap: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                WIN RATE
              </span>
              <span style={{
                fontSize: 36, fontWeight: 900, color: C.offWhite,
                letterSpacing: '-1px', lineHeight: 1, display: 'flex',
              }}>
                {winRateValid ? winRate.toFixed(0) + '%' : '--'}
              </span>
            </div>
          </div>

          {/* Bottom row: Rank + CTA */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 24, paddingTop: 20,
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* Rank */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.dimmer, letterSpacing: '1px' }}>
                  RANKED
                </span>
                <span style={{ fontSize: 28, fontWeight: 900, color: C.white, letterSpacing: '-1px' }}>
                  {rankDisplay}
                </span>
                <span style={{ fontSize: 14, color: C.dim }}>
                  / {totalDisplay} traders
                </span>
              </div>
              {/* Top % badge */}
              {topPct && (
                <div style={{
                  display: 'flex', padding: '4px 14px', borderRadius: 999,
                  background: C.goldDim, border: '1px solid ' + C.borderGold,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: C.goldLight, letterSpacing: '0.5px' }}>
                    {topPct}
                  </span>
                </div>
              )}
            </div>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.dim }}>
              Check your rank at arenafi.org
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
