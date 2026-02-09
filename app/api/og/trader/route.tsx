/**
 * OG Image for individual trader cards
 * GET /api/og/trader?handle=xxx
 *
 * Generates a 1200x630 social card with trader stats.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { tokens } from '@/lib/design-tokens'

export const runtime = 'edge'

const colors = {
  bg: '#0B0A10',
  card: '#14131A',
  text: '#EDEDED',
  sub: '#9A9A9A',
  brand: '#8b6fa8',
  success: '#4DFF9A',
  error: '#FF4D4D',
  gold: '#FFD700',
}

async function fetchTrader(handle: string) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  if (!url || !key) return null

  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // Try trader_sources first
  const { data: source } = await supabase
    .from('trader_sources')
    .select('trader_key, handle, display_name, avatar_url, platform')
    .eq('handle', handle)
    .limit(1)
    .maybeSingle()

  if (!source) return null

  // Get latest snapshot
  const { data: snapshot } = await supabase
    .from('trader_snapshots_v2')
    .select('roi, pnl, win_rate, max_drawdown, arena_score, rank')
    .eq('trader_key', source.trader_key)
    .eq('platform', source.platform)
    .eq('window', '90d')
    .maybeSingle()

  return { ...source, ...(snapshot || {}) }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')

    if (!handle) {
      return new Response('Missing handle parameter', { status: 400 })
    }

    // Allow overrides via query params (for layout.tsx metadata)
    const overrideRoi = searchParams.get('roi')
    const overrideScore = searchParams.get('score')
    const overrideRank = searchParams.get('rank')
    const overrideSource = searchParams.get('source')

    const trader = await fetchTrader(handle)

    const displayName = trader?.display_name || trader?.handle || handle
    const roi = overrideRoi ? parseFloat(overrideRoi) : (trader?.roi ?? null)
    const score = overrideScore ? parseFloat(overrideScore) : (trader?.arena_score ?? null)
    const rank = overrideRank ? parseInt(overrideRank) : (trader?.rank ?? null)
    const winRate = trader?.win_rate ?? null
    const mdd = trader?.max_drawdown ?? null
    const platform = overrideSource || trader?.platform || ''

    const roiColor = roi != null && roi >= 0 ? colors.success : colors.error
    const roiStr = roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%` : 'N/A'

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
            background: `linear-gradient(135deg, ${colors.bg} 0%, #1a1525 50%, ${colors.bg} 100%)`,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {/* Card container */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '48px 64px',
              borderRadius: tokens.radius['3xl'],
              background: colors.card,
              border: `1px solid rgba(139,111,168,0.3)`,
              boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
              minWidth: 700,
            }}
          >
            {/* Top: Avatar + Name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginBottom: 32 }}>
              {/* Avatar circle */}
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: '50%',
                  background: `linear-gradient(135deg, ${colors.brand}, #6366f1)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 32,
                  fontWeight: 800,
                  color: '#fff',
                }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 36, fontWeight: 800, color: colors.text }}>
                  {displayName.length > 20 ? displayName.slice(0, 20) + '...' : displayName}
                </span>
                <span style={{ fontSize: 16, color: colors.sub }}>
                  {platform.replace('_', ' ').toUpperCase()}
                  {rank != null ? ` | #${rank}` : ''}
                </span>
              </div>
            </div>

            {/* ROI big */}
            <div
              style={{
                fontSize: 64,
                fontWeight: 900,
                color: roiColor,
                marginBottom: 32,
                letterSpacing: '-2px',
              }}
            >
              {roiStr}
            </div>

            {/* Stats row */}
            <div style={{ display: 'flex', gap: 48 }}>
              <StatItem label="Arena Score" value={score != null ? score.toFixed(0) : '--'} color={colors.brand} />
              <StatItem label="胜率" value={winRate != null ? `${winRate.toFixed(0)}%` : 'N/A'} color={colors.text} />
              <StatItem label="最大回撤" value={mdd != null ? `-${Math.abs(mdd).toFixed(0)}%` : 'N/A'} color={colors.error} />
            </div>
          </div>

          {/* Branding */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 24 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: colors.brand }}>Arena</span>
            <span style={{ fontSize: 14, color: colors.sub }}>arenafi.org</span>
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

function StatItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 14, color: colors.sub }}>{label}</span>
      <span style={{ fontSize: 28, fontWeight: 800, color }}>{value}</span>
    </div>
  )
}
