/**
 * OG Image for individual trader cards
 * GET /api/og/trader?handle=xxx
 *
 * Generates a 1200x630 social card with trader avatar, ROI, arena score,
 * rank, exchange badge, and brand styling.
 * Edge runtime compatible.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { BASE_URL } from '@/lib/constants/urls'

export const runtime = 'edge'

const C = {
  bgTop: '#0A0A0F',
  bgMid: '#1a1525',
  card: '#14131A',
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  sub: '#9A9A9A',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  success: '#2FE57D',
  error: '#FF5555',
  border: 'rgba(139,92,246,0.25)',
  borderGold: 'rgba(212,175,55,0.35)',
}

const PLATFORM_COLORS: Record<string, string> = {
  binance_futures: '#F0B90B', binance_spot: '#F0B90B', binance_web3: '#F0B90B',
  bybit: '#F7A600', bybit_spot: '#F7A600',
  okx: '#FFFFFF', okx_futures: '#FFFFFF', okx_spot: '#FFFFFF', okx_web3: '#FFFFFF',
  bitget_futures: '#00D4AA', bitget_spot: '#00D4AA',
  hyperliquid: '#50E3C2', gmx: '#4B8FEE', dydx: '#6966FF',
  mexc: '#00B897', kucoin: '#24AE8F', gateio: '#2354E6',
  htx_futures: '#2E7CF6', coinex: '#3FB68B', drift: '#E040FB',
  bitunix: '#3B82F6', btcc: '#FF6B35', bitfinex: '#A7E92F',
  etoro: '#69C53E', blofin: '#00D4FF', phemex: '#D4FF00',
  jupiter_perps: '#C7F284', aevo: '#FF7A45',
}

const PLATFORM_NAMES: Record<string, string> = {
  binance_futures: 'Binance', binance_spot: 'Binance Spot', binance_web3: 'Binance Web3',
  bybit: 'Bybit', bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget', bitget_spot: 'Bitget Spot',
  okx_futures: 'OKX', okx_spot: 'OKX Spot', okx_web3: 'OKX Web3',
  hyperliquid: 'Hyperliquid', gmx: 'GMX', dydx: 'dYdX',
  mexc: 'MEXC', kucoin: 'KuCoin', gateio: 'Gate.io',
  htx_futures: 'HTX', coinex: 'CoinEx', drift: 'Drift',
  bitunix: 'Bitunix', btcc: 'BTCC', bitfinex: 'Bitfinex',
  etoro: 'eToro', blofin: 'BloFin', phemex: 'Phemex',
  weex: 'WEEX', bingx: 'BingX', xt: 'XT.COM',
  jupiter_perps: 'Jupiter Perps', aevo: 'Aevo',
  web3_bot: 'Web3 Bot', kwenta: 'Kwenta',
}

function formatRoi(roi: number): string {
  const abs = Math.abs(roi)
  const sign = roi >= 0 ? '+' : '-'
  if (abs >= 10000) return sign + Math.round(abs / 1000) + 'K%'
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + 'K%'
  return sign + abs.toFixed(1) + '%'
}

async function fetchTrader(handle: string) {
  const supabase = getSupabaseAdmin()

  let source: { handle: string | null; display_name?: string | null; avatar_url: string | null; source: string; source_trader_id: string } | null = null

  const { data: byHandle } = await supabase
    .from('trader_sources')
    .select('handle, avatar_url, source, source_trader_id')
    .ilike('handle', handle)
    .limit(1)
    .maybeSingle()

  if (byHandle) {
    source = byHandle
  } else {
    const { data: byId } = await supabase
      .from('trader_sources')
      .select('handle, avatar_url, source, source_trader_id')
      .eq('source_trader_id', decodeURIComponent(handle))
      .limit(1)
      .maybeSingle()

    if (byId) {
      source = byId
    } else {
      const { data: byLr } = await supabase
        .from('leaderboard_ranks')
        .select('handle, avatar_url, source, source_trader_id')
        .eq('source_trader_id', decodeURIComponent(handle))
        .eq('season_id', '90D')
        .limit(1)
        .maybeSingle()

      if (byLr) {
        source = byLr
      }
    }
  }

  if (!source) return null

  const { data: rankData } = await supabase
    .from('leaderboard_ranks')
    .select('roi, pnl, win_rate, max_drawdown, arena_score, rank')
    .eq('source', source.source)
    .eq('source_trader_id', source.source_trader_id)
    .eq('season_id', '90D')
    .maybeSingle()

  return { ...source, platform: source.source, ...(rankData || {}) }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')

    if (!handle) {
      return new Response('Missing handle parameter', { status: 400 })
    }

    // Only `source` is allowed as a hint for multi-platform traders.
    // ROI/score/rank overrides removed — prevents attackers from crafting
    // misleading share links with fake stats for any trader.
    const overrideSource = searchParams.get('source')

    const trader = await fetchTrader(handle)

    const displayName = trader?.display_name || trader?.handle || handle
    const roi = trader?.roi ?? null
    const score = trader?.arena_score ?? null
    const rank = trader?.rank ?? null
    const winRate = trader?.win_rate ?? null
    const mdd = trader?.max_drawdown ?? null
    const platform = overrideSource || trader?.platform || ''
    const avatarUrl = trader?.avatar_url || null

    const roiValid = roi != null
    const roiColor = roiValid && roi >= 0 ? C.success : C.error
    const roiStr = roiValid ? formatRoi(roi) : '--'
    const platformLabel = PLATFORM_NAMES[platform] || platform.replace(/_/g, ' ').toUpperCase()
    const platformColor = PLATFORM_COLORS[platform] || C.purpleLight

    // Pre-fetch avatar as base64 data URL so Satori (next/og) doesn't have to
    // make a network request itself — self-referential proxy calls from Edge
    // runtime to the Node.js avatar proxy are unreliable and produce
    // "Can't load <url>" errors in the OG image renderer.
    let avatarSrc: string | null = null
    if (avatarUrl) {
      if (avatarUrl.startsWith('data:')) {
        avatarSrc = avatarUrl
      } else {
        try {
          const proxyUrl = `${BASE_URL}/api/avatar?url=${encodeURIComponent(avatarUrl)}`
          const avatarRes = await fetch(proxyUrl, {
            signal: AbortSignal.timeout(4000),
          })
          if (avatarRes.ok) {
            const ct = avatarRes.headers.get('content-type') || 'image/png'
            if (ct.startsWith('image/')) {
              const buf = await avatarRes.arrayBuffer()
              const b64 = Buffer.from(buf).toString('base64')
              avatarSrc = `data:${ct};base64,${b64}`
            }
          }
        } catch {
          // Avatar failed to load — fall back to initials placeholder below
          avatarSrc = null
        }
      }
    }

    return new ImageResponse(
      (
        <div
          style={{
            width: 1200,
            height: 630,
            display: 'flex',
            flexDirection: 'column',
            background: `linear-gradient(135deg, ${C.bgTop} 0%, ${C.bgMid} 50%, ${C.bgTop} 100%)`,
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* Background gradient blobs */}
          <div style={{
            position: 'absolute', top: -120, left: -80, width: 500, height: 500,
            background: 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)',
            display: 'flex',
          }} />
          <div style={{
            position: 'absolute', bottom: -100, right: -60, width: 420, height: 420,
            background: 'radial-gradient(circle, rgba(212,175,55,0.10) 0%, transparent 70%)',
            display: 'flex',
          }} />

          {/* Top accent bar */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 4,
            background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
            display: 'flex',
          }} />

          {/* Main content */}
          <div style={{
            position: 'relative', display: 'flex', flexDirection: 'column',
            height: '100%', padding: '44px 60px 36px', zIndex: 1,
          }}>
            {/* Top row: Arena branding */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 36 }}>
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
              <div style={{
                display: 'flex', padding: '6px 16px', borderRadius: 8,
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>
                  90D
                </span>
              </div>
            </div>

            {/* Trader identity row: Avatar + Name + Exchange */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 32 }}>
              {/* Avatar */}
              {avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt=""
                  width={88}
                  height={88}
                  style={{
                    borderRadius: '50%',
                    border: `3px solid ${platformColor}40`,
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 88,
                    height: 88,
                    borderRadius: '50%',
                    background: `linear-gradient(135deg, ${C.purple}, #6366f1)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 36,
                    fontWeight: 800,
                    color: '#fff',
                  }}
                >
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{
                  fontSize: displayName.length > 18 ? 32 : 40,
                  fontWeight: 900,
                  color: C.white,
                  letterSpacing: '-0.5px',
                }}>
                  {displayName.length > 24 ? displayName.slice(0, 24) + '...' : displayName}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Exchange badge */}
                  {platformLabel && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 12px', borderRadius: 6,
                      background: platformColor + '18',
                      border: '1px solid ' + platformColor + '35',
                    }}>
                      <div style={{ width: 6, height: 6, borderRadius: 999, background: platformColor, display: 'flex' }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: platformColor, letterSpacing: '0.5px' }}>
                        {platformLabel}
                      </span>
                    </div>
                  )}
                  {/* Rank badge */}
                  {rank != null && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 12px', borderRadius: 6,
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.12)',
                    }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.dim, letterSpacing: '0.5px' }}>
                        #{rank}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Stats cards row */}
            <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'stretch' }}>
              {/* Arena Score */}
              <div style={{
                display: 'flex', flexDirection: 'column', flex: 1,
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
                  {score != null ? Math.round(score).toString() : '--'}
                </span>
              </div>

              {/* ROI */}
              <div style={{
                display: 'flex', flexDirection: 'column', flex: 1,
                padding: '20px 24px', borderRadius: 16,
                background: roiValid && roi >= 0 ? 'rgba(47,229,125,0.07)' : 'rgba(255,85,85,0.07)',
                border: roiValid && roi >= 0 ? '1px solid rgba(47,229,125,0.25)' : '1px solid rgba(255,85,85,0.25)',
                gap: 8,
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                  ROI (90D)
                </span>
                <span style={{
                  fontSize: 48, fontWeight: 900, color: roiColor,
                  letterSpacing: '-2px', lineHeight: 1, display: 'flex',
                }}>
                  {roiStr}
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
                  fontSize: 40, fontWeight: 900, color: C.offWhite,
                  letterSpacing: '-1px', lineHeight: 1, display: 'flex',
                }}>
                  {winRate != null ? winRate.toFixed(0) + '%' : '--'}
                </span>
              </div>

              {/* Max Drawdown */}
              <div style={{
                display: 'flex', flexDirection: 'column', flex: 0.8,
                padding: '20px 24px', borderRadius: 16,
                background: 'rgba(255,85,85,0.05)', border: '1px solid rgba(255,85,85,0.15)',
                gap: 8,
              }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                  MAX DD
                </span>
                <span style={{
                  fontSize: 40, fontWeight: 900, color: mdd != null ? C.error : C.offWhite,
                  letterSpacing: '-1px', lineHeight: 1, display: 'flex',
                }}>
                  {mdd != null ? `-${Math.abs(mdd).toFixed(0)}%` : '--'}
                </span>
              </div>
            </div>

            {/* Footer */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginTop: 20, paddingTop: 16,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}>
              <span style={{ fontSize: 14, color: C.dim }}>
                Crypto Trader Rankings
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.dim }}>
                View full profile at arenafi.org
              </span>
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
  } catch (e) {
    logger.error('[OG Trader] Error:', e)
    return new Response('Failed to generate image', { status: 500 })
  }
}
