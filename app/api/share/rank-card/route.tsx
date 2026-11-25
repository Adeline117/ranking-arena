import { formatScoreWhole } from '@/lib/utils/format'
import { ImageResponse } from 'next/og'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import {
  publicRankingResponseCacheHeaders,
  publicRankingResponseRejectionHeaders,
  redirectToPublicRankingResponseCacheEpoch,
} from '@/lib/rankings/public-response-cache'

export const runtime = 'edge'

const C = {
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  success: '#2FE57D',
  error: '#FF5555',
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  borderGold: 'rgba(212,175,55,0.35)',
}
const PLAT_C: Record<string, string> = {
  binance_futures: '#F0B90B',
  bybit: '#F7A600',
  okx: '#FFFFFF',
  bitget_futures: '#00D4AA',
  hyperliquid: '#50E3C2',
  gmx: '#4B8FEE',
  dydx: '#6966FF',
  mexc: '#00B897',
  gateio: '#2E7CF6',
  drift: '#E3DEFF',
}
const PLAT_L: Record<string, string> = {
  binance_futures: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  bitget_futures: 'Bitget',
  hyperliquid: 'Hyperliquid',
  gmx: 'GMX',
  dydx: 'dYdX',
  mexc: 'MEXC',
  gateio: 'Gate.io',
  htx_futures: 'HTX',
  drift: 'Drift',
  btcc: 'BTCC',
  bitunix: 'Bitunix',
  etoro: 'eToro',
}

// Every column the shared row check (isPublicRankingRowEligible) reads must be
// selected, including ones the card never draws: pnl is required, and
// max_drawdown is compared against score_completeness. Leaving either out makes
// the check reject every row and the card renders no numbers at all.
const PUBLIC_RANK_CARD_COLUMNS =
  'rank,roi,pnl,win_rate,max_drawdown,arena_score,source,source_trader_id,score_completeness,metrics_estimated,is_outlier,computed_at,season_id,idle_window'

type VerifiedRankCardRow = {
  rank: number
  roi: number | null
  winRate: number | null
  arenaScore: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function verifiedRankCardRow(
  value: unknown,
  source: string,
  sourceTraderId: string,
  period: string
): VerifiedRankCardRow | null {
  const sanitized = sanitizePublicRankingPayload(
    { traders: value === null ? [] : [value], period },
    { expectedPeriod: period }
  ) as { traders?: unknown[] }
  const row = sanitized.traders?.[0]
  if (
    !isRecord(row) ||
    row.source !== source ||
    row.source_trader_id !== sourceTraderId ||
    typeof row.rank !== 'number' ||
    !Number.isSafeInteger(row.rank) ||
    row.rank <= 0
  ) {
    return null
  }
  return {
    rank: row.rank,
    roi: typeof row.roi === 'number' && Number.isFinite(row.roi) ? row.roi : null,
    winRate:
      typeof row.win_rate === 'number' && Number.isFinite(row.win_rate) ? row.win_rate : null,
    // An idle-window row is ranked but not scored: no score on the card.
    arenaScore:
      row.idle_window !== true &&
      typeof row.arena_score === 'number' &&
      Number.isFinite(row.arena_score)
        ? row.arena_score
        : null,
  }
}

function fmtRoi(r: number) {
  const a = Math.abs(r),
    s = r >= 0 ? '+' : '-'
  if (a >= 10000) return s + Math.round(a / 1000) + 'K%'
  if (a >= 1000) return s + (a / 1000).toFixed(1) + 'K%'
  return s + a.toFixed(1) + '%'
}

export async function GET(request: NextRequest) {
  const { searchParams: sp } = new URL(request.url)
  const handle = sp.get('handle'),
    platform = sp.get('platform') || '',
    windowParam = sp.get('window') || '7d'
  if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 })
  if (platform && !isPublicRankingSourceAllowed(platform)) {
    return NextResponse.json(
      { error: 'Unknown or unavailable ranking source' },
      { status: 404, headers: publicRankingResponseRejectionHeaders() }
    )
  }
  const epochRedirect = redirectToPublicRankingResponseCacheEpoch(request)
  if (epochRedirect) return epochRedirect
  const sb = getSupabaseAdmin()
  const sMap: Record<string, string> = {
    '7d': '7D',
    '30d': '30D',
    '90d': '90D',
    '7D': '7D',
    '30D': '30D',
    '90D': '90D',
  }
  const sId = sMap[windowParam] ?? '7D'
  const safeHandle = handle.replace(/[,.()\[\]\\%_]/g, '')
  let q = sb
    .from('trader_sources')
    .select('handle, source, source_trader_id')
    .or(`handle.eq.${safeHandle},source_trader_id.eq.${safeHandle}`)
    .limit(1)
  if (platform) q = q.eq('source', platform)
  const { data: tr } = await q.maybeSingle()
  if (!tr) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!isPublicRankingSourceAllowed(tr.source)) {
    return NextResponse.json(
      { error: 'Not found' },
      { status: 404, headers: publicRankingResponseRejectionHeaders() }
    )
  }
  const { data: candidate } = await sb
    .from('public_ranked_leaderboard')
    .select(PUBLIC_RANK_CARD_COLUMNS)
    .eq('source', tr.source)
    .eq('source_trader_id', tr.source_trader_id)
    .eq('season_id', sId)
    .maybeSingle()

  // A valid global rank may be rendered, but no generation-bound denominator
  // is available on this image path. Deliberately omit “Top X%” rather than
  // infer it from a raw or stale count cache.
  const lr = verifiedRankCardRow(candidate, tr.source, tr.source_trader_id, sId)
  const name = tr.handle || handle,
    rank = lr?.rank ?? 0,
    roi = lr?.roi ?? null,
    score = lr?.arenaScore ?? null,
    winRate = lr?.winRate ?? null
  const rv = typeof roi === 'number' && Number.isFinite(roi),
    sv = typeof score === 'number' && Number.isFinite(score),
    wv = typeof winRate === 'number' && Number.isFinite(winRate)
  const rc = rv && roi >= 0 ? C.success : C.error,
    rs = rv ? fmtRoi(roi) : '--'
  const pl =
    PLAT_L[tr.source] ||
    tr.source.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
  const pc = PLAT_C[tr.source] || C.purpleLight
  const rd = rank > 0 ? (rank <= 9999 ? String(rank) : (rank / 1000).toFixed(0) + 'K') : '--'
  // Rank-card sharing remains available during the V1 referral hold, but the
  // public asset must not publish a caller-provided referral destination.
  const cta = 'arenafi.org'

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(180deg, #0A0A0F 0%, #1A1A2E 100%)',
        fontFamily: 'Inter, system-ui, sans-serif',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -120,
          left: -80,
          width: 480,
          height: 480,
          background: 'radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 70%)',
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: -100,
          right: -60,
          width: 400,
          height: 400,
          background: 'radial-gradient(circle, rgba(212,175,55,0.12) 0%, transparent 70%)',
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
          display: 'flex',
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: '40px 56px 36px',
          zIndex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 32,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: C.gold,
                display: 'flex',
              }}
            />
            <span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>
              ARENA
            </span>
            <span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>Rank Card</span>
          </div>
          <div
            style={{
              display: 'flex',
              padding: '6px 16px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>
              {sId}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
          <div
            style={{
              fontSize: name.length > 18 ? 32 : 40,
              fontWeight: 900,
              color: C.white,
              display: 'flex',
            }}
          >
            {name.length > 24 ? name.slice(0, 24) + '...' : name}
          </div>
          {pl && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 14px',
                borderRadius: 6,
                background: pc + '15',
                border: '1px solid ' + pc + '30',
                alignSelf: 'flex-start',
              }}
            >
              <div
                style={{ width: 6, height: 6, borderRadius: 999, background: pc, display: 'flex' }}
              />
              <span style={{ fontSize: 13, fontWeight: 700, color: pc }}>{pl}</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'stretch' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1.2,
              padding: '20px 24px',
              borderRadius: 16,
              background: C.goldDim,
              border: '1px solid ' + C.borderGold,
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.goldLight,
                letterSpacing: '2px',
                display: 'flex',
              }}
            >
              ARENA SCORE
            </span>
            <span
              style={{
                fontSize: 52,
                fontWeight: 900,
                color: C.goldLight,
                letterSpacing: '-2px',
                lineHeight: 1,
                display: 'flex',
              }}
            >
              {sv ? formatScoreWhole(score) : '--'}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1.2,
              padding: '20px 24px',
              borderRadius: 16,
              background: rv && roi >= 0 ? 'rgba(47,229,125,0.07)' : 'rgba(255,85,85,0.07)',
              border:
                rv && roi >= 0
                  ? '1px solid rgba(47,229,125,0.25)'
                  : '1px solid rgba(255,85,85,0.25)',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.dimmer,
                letterSpacing: '2px',
                display: 'flex',
              }}
            >
              ROI
            </span>
            <span
              style={{
                fontSize: 48,
                fontWeight: 900,
                color: rc,
                letterSpacing: '-2px',
                lineHeight: 1,
                display: 'flex',
              }}
            >
              {rs}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              padding: '20px 24px',
              borderRadius: 16,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.dimmer,
                letterSpacing: '2px',
                display: 'flex',
              }}
            >
              WIN RATE
            </span>
            <span
              style={{
                fontSize: 36,
                fontWeight: 900,
                color: C.offWhite,
                letterSpacing: '-1px',
                lineHeight: 1,
                display: 'flex',
              }}
            >
              {/* Win rate is optional on the public board: null means the
                  source did not provide it, which is not the same as 0%. */}
              {wv ? winRate.toFixed(0) + '%' : '—'}
            </span>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 24,
            paddingTop: 20,
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span
                style={{ fontSize: 13, fontWeight: 600, color: C.dimmer, letterSpacing: '1px' }}
              >
                RANKED
              </span>
              <span
                style={{ fontSize: 28, fontWeight: 900, color: C.white, letterSpacing: '-1px' }}
              >
                {rd}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.purple }}>via Arena</span>
            <span style={{ fontSize: 13, color: C.dim }}>{cta}</span>
          </div>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: publicRankingResponseCacheHeaders(
        'public, s-maxage=300, stale-while-revalidate=3600'
      ),
    }
  )
}
