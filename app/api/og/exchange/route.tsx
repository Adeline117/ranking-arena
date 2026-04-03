/**
 * OG Image for exchange ranking pages
 * GET /api/og/exchange?exchange=binance_futures
 *
 * Generates a 1200x630 social card showing exchange name, top 3 traders,
 * total trader count, and Arena branding.
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
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  white: '#FFFFFF',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  success: '#2FE57D',
  error: '#FF5555',
  borderGold: 'rgba(212,175,55,0.35)',
}

const PLATFORM_COLORS: Record<string, string> = {
  binance_futures: '#F0B90B', binance_spot: '#F0B90B', binance_web3: '#F0B90B',
  bybit: '#F7A600', bybit_spot: '#F7A600',
  okx_futures: '#FFFFFF', okx_spot: '#FFFFFF', okx_web3: '#FFFFFF',
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

interface TopTrader {
  handle: string | null
  avatar_url: string | null
  roi: number | null
  arena_score: number | null
  rank: number
}

async function fetchExchangeData(exchange: string): Promise<{ traders: TopTrader[]; total: number }> {
  const supabase = getSupabaseAdmin()

  const { data: top3, error: topErr } = await supabase
    .from('leaderboard_ranks')
    .select('handle, avatar_url, roi, arena_score, rank')
    .eq('source', exchange)
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false, nullsFirst: false })
    .limit(3)

  if (topErr) {
    logger.error('[OG Exchange] Error fetching top traders:', topErr)
  }

  const { count, error: countErr } = await supabase
    .from('leaderboard_ranks')
    .select('*', { count: 'exact', head: true })
    .eq('source', exchange)
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')

  if (countErr) {
    logger.error('[OG Exchange] Error fetching count:', countErr)
  }

  const traders: TopTrader[] = (top3 || []).map((t, i) => ({
    handle: t.handle as string | null,
    avatar_url: t.avatar_url as string | null,
    roi: t.roi as number | null,
    arena_score: t.arena_score as number | null,
    rank: i + 1,
  }))

  return { traders, total: count ?? 0 }
}

const MEDAL_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32']

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const exchange = searchParams.get('exchange')

    if (!exchange) {
      return new Response('Missing exchange parameter', { status: 400 })
    }

    const displayName = PLATFORM_NAMES[exchange] || exchange.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const platformColor = PLATFORM_COLORS[exchange] || C.purpleLight

    const { traders, total } = await fetchExchangeData(exchange)

    // Pre-fetch all trader avatars as base64 data URLs so Satori (next/og)
    // doesn't try to load them itself — self-referential proxy calls from Edge
    // runtime to the Node.js avatar proxy are unreliable and produce
    // "Can't load <url>" errors in the OG image renderer.
    const avatarDataUrls: (string | null)[] = await Promise.all(
      traders.map(async (trader) => {
        if (!trader.avatar_url) return null
        if (trader.avatar_url.startsWith('data:')) return trader.avatar_url
        try {
          const proxyUrl = `${BASE_URL}/api/avatar?url=${encodeURIComponent(trader.avatar_url)}`
          const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(4000) })
          if (!res.ok) return null
          const ct = res.headers.get('content-type') || 'image/png'
          if (!ct.startsWith('image/')) return null
          const buf = await res.arrayBuffer()
          const b64 = Buffer.from(buf).toString('base64')
          return `data:${ct};base64,${b64}`
        } catch {
          return null
        }
      })
    )

    return new ImageResponse(
      (
        <div style={{ width: 1200, height: 630, display: 'flex', flexDirection: 'column', background: `linear-gradient(135deg, ${C.bgTop} 0%, ${C.bgMid} 50%, ${C.bgTop} 100%)`, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', top: -150, right: -100, width: 600, height: 600, background: `radial-gradient(circle, ${platformColor}15 0%, transparent 70%)`, display: 'flex' }} />
          <div style={{ position: 'absolute', bottom: -120, left: -80, width: 500, height: 500, background: 'radial-gradient(circle, rgba(139,92,246,0.12) 0%, transparent 70%)', display: 'flex' }} />
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(90deg, ${platformColor} 0%, ${C.purple} 50%, ${platformColor} 100%)`, display: 'flex' }} />

          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', padding: '44px 60px 36px', zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: 999, background: C.gold, display: 'flex' }} />
                <span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>ARENA</span>
                <span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>arenafi.org</span>
              </div>
              <div style={{ display: 'flex', padding: '6px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>90D RANKINGS</span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 32 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: platformColor + '20', border: `2px solid ${platformColor}50`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 24, fontWeight: 900, color: platformColor }}>{displayName.charAt(0)}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 42, fontWeight: 900, color: C.white, letterSpacing: '-1px' }}>{displayName} Rankings</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{ fontSize: 16, color: C.dim }}>{total > 0 ? total.toLocaleString() : '0'} ranked traders</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 6, background: platformColor + '18', border: '1px solid ' + platformColor + '35' }}>
                    <div style={{ width: 5, height: 5, borderRadius: 999, background: platformColor, display: 'flex' }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: platformColor }}>{displayName}</span>
                  </div>
                </div>
              </div>
            </div>

            {traders.length > 0 ? (
              <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'stretch' }}>
                {traders.map((trader, i) => {
                  const medalColor = MEDAL_COLORS[i]
                  const roiColor = trader.roi != null && trader.roi >= 0 ? C.success : C.error
                  const roiStr = trader.roi != null ? formatRoi(trader.roi) : '--'
                  const traderName = trader.handle || `Trader ${i + 1}`
                  // avatarSrc is pre-fetched below into base64 — index i
                  const avatarSrc = avatarDataUrls[i] ?? null

                  return (
                    <div key={i} style={{
                      display: 'flex', flexDirection: 'column', flex: 1, padding: '24px 24px', borderRadius: 16, gap: 16,
                      background: i === 0 ? 'rgba(212,175,55,0.08)' : 'rgba(255,255,255,0.03)',
                      border: i === 0 ? '1px solid rgba(212,175,55,0.25)' : '1px solid rgba(255,255,255,0.08)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 999, background: medalColor + '25', border: `2px solid ${medalColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ fontSize: 14, fontWeight: 900, color: medalColor }}>{i + 1}</span>
                        </div>
                        {avatarSrc ? (
                          <img src={avatarSrc} alt="" width={40} height={40} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{ width: 40, height: 40, borderRadius: '50%', background: `linear-gradient(135deg, ${C.purple}, #6366f1)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: '#fff' }}>
                            {traderName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span style={{ fontSize: 16, fontWeight: 800, color: C.white, overflow: 'hidden' }}>
                          {traderName.length > 14 ? traderName.slice(0, 14) + '...' : traderName}
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: C.goldLight, letterSpacing: '2px', display: 'flex' }}>ARENA SCORE</span>
                        <span style={{ fontSize: 36, fontWeight: 900, color: C.goldLight, letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>
                          {trader.arena_score != null ? Math.round(trader.arena_score).toString() : '--'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>ROI</span>
                        <span style={{ fontSize: 28, fontWeight: 900, color: roiColor, letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>{roiStr}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: 24, color: C.dim }}>{t('rankingsComingSoon') || 'Rankings coming soon'}</span>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <span style={{ fontSize: 14, color: C.dim }}>Crypto Trader Rankings across 30+ exchanges</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.dim }}>View full rankings at arenafi.org</span>
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
      }
    )
  } catch (e) {
    logger.error('[OG Exchange] Error:', e)
    return new Response('Failed to generate image', { status: 500 })
  }
}
