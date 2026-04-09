import { ImageResponse } from 'next/og'
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const runtime = 'edge'

const C = { gold: '#D4AF37', goldLight: '#F0D060', goldDim: 'rgba(212,175,55,0.15)', white: '#FFFFFF', offWhite: '#EDEDED', dim: 'rgba(255,255,255,0.50)', dimmer: 'rgba(255,255,255,0.28)', success: '#2FE57D', error: '#FF5555', purple: '#8B5CF6', purpleLight: '#A78BFA', borderGold: 'rgba(212,175,55,0.35)' }
const PLAT_C: Record<string, string> = { binance_futures: '#F0B90B', bybit: '#F7A600', okx: '#FFFFFF', bitget_futures: '#00D4AA', hyperliquid: '#50E3C2', gmx: '#4B8FEE', dydx: '#6966FF', mexc: '#00B897', gateio: '#2E7CF6', drift: '#E3DEFF' }
const PLAT_L: Record<string, string> = { binance_futures: 'Binance', bybit: 'Bybit', okx: 'OKX', bitget_futures: 'Bitget', hyperliquid: 'Hyperliquid', gmx: 'GMX', dydx: 'dYdX', mexc: 'MEXC', gateio: 'Gate.io', htx_futures: 'HTX', drift: 'Drift', btcc: 'BTCC', bitunix: 'Bitunix', etoro: 'eToro' }
function fmtRoi(r: number) { const a = Math.abs(r), s = r >= 0 ? '+' : '-'; if (a >= 10000) return s + Math.round(a / 1000) + 'K%'; if (a >= 1000) return s + (a / 1000).toFixed(1) + 'K%'; return s + a.toFixed(1) + '%' }
function topPct(r: number, t: number) { if (!t || !r) return ''; const p = r / t; if (p <= 0.01) return 'Top 1%'; if (p <= 0.05) return 'Top 5%'; if (p <= 0.10) return 'Top 10%'; if (p <= 0.25) return 'Top 25%'; return 'Top ' + Math.ceil(p * 100) + '%' }

export async function GET(request: NextRequest) {
  const { searchParams: sp } = new URL(request.url)
  const handle = sp.get('handle'), platform = sp.get('platform') || '', windowParam = sp.get('window') || '7d', ref = sp.get('ref') || ''
  if (!handle) return NextResponse.json({ error: 'handle required' }, { status: 400 })
  const sb = getSupabaseAdmin()
  const sMap: Record<string, string> = { '7d': '7D', '30d': '30D', '90d': '90D', '7D': '7D', '30D': '30D', '90D': '90D' }
  const sId = sMap[windowParam] ?? '7D'
  let q = sb.from('trader_sources').select('handle, source, source_trader_id').or(`handle.eq.${handle},source_trader_id.eq.${handle}`).limit(1)
  if (platform) q = q.eq('source', platform)
  const { data: tr } = await q.maybeSingle()
  if (!tr) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: lr } = await sb.from('leaderboard_ranks').select('rank, roi, win_rate, arena_score').eq('source', tr.source).eq('source_trader_id', tr.source_trader_id).eq('season_id', sId).maybeSingle()
  // PERF FIX: was count:exact (25s+). Read from pre-computed cache instead.
  const { data: countCache } = await sb.from('leaderboard_count_cache').select('total_count').eq('source', tr.source).eq('season_id', sId).maybeSingle()
  const count = countCache?.total_count ?? null
  const name = tr.handle || handle, rank = lr?.rank ?? 0, total = count ?? 0, roi = lr?.roi, score = lr?.arena_score, winRate = lr?.win_rate
  const rv = roi != null && !isNaN(roi), sv = score != null && !isNaN(score), wv = winRate != null && !isNaN(winRate)
  const rc = rv && roi >= 0 ? C.success : C.error, rs = rv ? fmtRoi(roi) : '--', tp = rank > 0 && total > 0 ? topPct(rank, total) : ''
  const pl = PLAT_L[tr.source] || tr.source.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
  const pc = PLAT_C[tr.source] || C.purpleLight
  const rd = rank > 0 ? (rank <= 9999 ? String(rank) : (rank / 1000).toFixed(0) + 'K') : '--', td = total > 0 ? total.toLocaleString('en-US') + '+' : '34,000+'
  const cta = ref ? `arenafi.org/?ref=${ref}` : 'arenafi.org'

  return new ImageResponse(
    (<div style={{ width: 1200, height: 630, display: 'flex', flexDirection: 'column', background: 'linear-gradient(180deg, #0A0A0F 0%, #1A1A2E 100%)', fontFamily: 'Inter, system-ui, sans-serif', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: -120, left: -80, width: 480, height: 480, background: 'radial-gradient(circle, rgba(139,92,246,0.18) 0%, transparent 70%)', display: 'flex' }} />
      <div style={{ position: 'absolute', bottom: -100, right: -60, width: 400, height: 400, background: 'radial-gradient(circle, rgba(212,175,55,0.12) 0%, transparent 70%)', display: 'flex' }} />
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)', display: 'flex' }} />
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', padding: '40px 56px 36px', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ width: 8, height: 8, borderRadius: 999, background: C.gold, display: 'flex' }} /><span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>ARENA</span><span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>Rank Card</span></div>
          <div style={{ display: 'flex', padding: '6px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}><span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>{sId}</span></div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
          <div style={{ fontSize: name.length > 18 ? 32 : 40, fontWeight: 900, color: C.white, display: 'flex' }}>{name.length > 24 ? name.slice(0, 24) + '...' : name}</div>
          {pl && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', borderRadius: 6, background: pc + '15', border: '1px solid ' + pc + '30', alignSelf: 'flex-start' }}><div style={{ width: 6, height: 6, borderRadius: 999, background: pc, display: 'flex' }} /><span style={{ fontSize: 13, fontWeight: 700, color: pc }}>{pl}</span></div>}
        </div>
        <div style={{ display: 'flex', gap: 16, flex: 1, alignItems: 'stretch' }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1.2, padding: '20px 24px', borderRadius: 16, background: C.goldDim, border: '1px solid ' + C.borderGold, gap: 8 }}><span style={{ fontSize: 11, fontWeight: 700, color: C.goldLight, letterSpacing: '2px', display: 'flex' }}>ARENA SCORE</span><span style={{ fontSize: 52, fontWeight: 900, color: C.goldLight, letterSpacing: '-2px', lineHeight: 1, display: 'flex' }}>{sv ? Math.round(score).toString() : '--'}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1.2, padding: '20px 24px', borderRadius: 16, background: rv && roi >= 0 ? 'rgba(47,229,125,0.07)' : 'rgba(255,85,85,0.07)', border: rv && roi >= 0 ? '1px solid rgba(47,229,125,0.25)' : '1px solid rgba(255,85,85,0.25)', gap: 8 }}><span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>ROI</span><span style={{ fontSize: 48, fontWeight: 900, color: rc, letterSpacing: '-2px', lineHeight: 1, display: 'flex' }}>{rs}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: '20px 24px', borderRadius: 16, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', gap: 8 }}><span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>WIN RATE</span><span style={{ fontSize: 36, fontWeight: 900, color: C.offWhite, letterSpacing: '-1px', lineHeight: 1, display: 'flex' }}>{wv ? winRate.toFixed(0) + '%' : '--'}</span></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}><div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ fontSize: 13, fontWeight: 600, color: C.dimmer, letterSpacing: '1px' }}>RANKED</span><span style={{ fontSize: 28, fontWeight: 900, color: C.white, letterSpacing: '-1px' }}>{rd}</span><span style={{ fontSize: 14, color: C.dim }}>/ {td} traders</span></div>{tp && <div style={{ display: 'flex', padding: '4px 14px', borderRadius: 999, background: C.goldDim, border: '1px solid ' + C.borderGold }}><span style={{ fontSize: 13, fontWeight: 800, color: C.goldLight }}>{tp}</span></div>}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 13, fontWeight: 600, color: C.purple }}>via Arena</span><span style={{ fontSize: 13, color: C.dim }}>{cta}</span></div>
        </div>
      </div>
    </div>),
    { width: 1200, height: 630, headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' } }
  )
}
