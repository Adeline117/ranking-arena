'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import EmptyState from '@/app/components/ui/EmptyState'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { formatPnL } from '@/lib/utils/format'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'

interface WatchlistItem {
  source: string; source_trader_id: string; handle: string | null; created_at: string
  roi?: number | null; pnl?: number | null; rank?: number | null
  arena_score?: number | null; win_rate?: number | null; avatar_url?: string | null
}

const PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance', binance_futures: 'Binance Futures', binance_spot: 'Binance Spot',
  bybit: 'Bybit', okx: 'OKX', bitget: 'Bitget', mexc: 'MEXC', kucoin: 'KuCoin',
  htx: 'HTX', coinex: 'CoinEx', hyperliquid: 'Hyperliquid', gmx: 'GMX', dydx: 'dYdX',
  drift: 'Drift', aevo: 'Aevo', gains: 'Gains Network', etoro: 'eToro',
  jupiter_perps: 'Jupiter Perps', bitfinex: 'Bitfinex', toobit: 'Toobit',
}

function formatRoi(roi: number | null | undefined): string {
  if (roi == null) return '--'
  return `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`
}
function formatScore(score: number | null | undefined): string {
  if (score == null) return '--'
  return score.toFixed(1)
}

type SortKey = 'added' | 'roi' | 'pnl' | 'score' | 'rank'

export default function WatchlistClient() {
  const [email, setEmail] = useState<string | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('added')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [platformFilter, setPlatformFilter] = useState<string>('all')

  useEffect(() => {
    async function init() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setIsAuthenticated(false); setLoading(false); return }
      setIsAuthenticated(true); setEmail(user.email ?? null)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      try {
        const res = await fetch('/api/watchlist', { headers: { Authorization: `Bearer ${session.access_token}` } })
        if (res.ok) { const json = await res.json(); setWatchlist(json.watchlist || []) }
      } catch (err) { console.error('[watchlist] fetch failed:', err) }
      setLoading(false)
    }
    init()
  }, [])

  const handleRemove = useCallback(async (source: string, id: string) => {
    setRemoving(`${source}:${id}`)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch('/api/watchlist', { method: 'DELETE', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ source, source_trader_id: id }) })
      if (res.ok) setWatchlist(prev => prev.filter(w => !(w.source === source && w.source_trader_id === id)))
    } catch (err) { console.error('[watchlist] remove failed:', err) }
    finally { setRemoving(null) }
  }, [])

  const platforms = useMemo(() => Array.from(new Set(watchlist.map(w => w.source))).sort(), [watchlist])
  const displayList = useMemo(() => {
    const f = platformFilter === 'all' ? watchlist : watchlist.filter(w => w.source === platformFilter)
    return [...f].sort((a, b) => {
      const d = sortDir === 'asc' ? 1 : -1
      switch (sortBy) {
        case 'roi': return d * ((a.roi ?? -Infinity) - (b.roi ?? -Infinity))
        case 'pnl': return d * ((a.pnl ?? -Infinity) - (b.pnl ?? -Infinity))
        case 'score': return d * ((a.arena_score ?? -Infinity) - (b.arena_score ?? -Infinity))
        case 'rank': return d * ((a.rank ?? Infinity) - (b.rank ?? Infinity))
        default: return d * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      }
    })
  }, [watchlist, platformFilter, sortBy, sortDir])

  const doSort = (col: SortKey) => { if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortBy(col); setSortDir(col === 'rank' ? 'asc' : 'desc') } }
  const sa = (col: SortKey) => sortBy === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : ''

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
      <TopNav email={email} />
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 60px' }}>
        <div style={{ marginBottom: 24 }}><h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Watchlist</h1><p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginTop: 6 }}>Your saved traders. Click the star on any trader profile to add them.</p></div>
        {isAuthenticated === false && <EmptyState variant="card" icon={<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>} title="Sign in to view your watchlist" description="Create an account or log in to save and track your favorite traders." action={<Link href="/login" style={{ display:'inline-block',padding:'10px 24px',background:'var(--color-accent-primary)',color:'var(--color-bg-primary)',borderRadius:tokens.radius.md,fontWeight:600,fontSize:14,textDecoration:'none' }}>Sign In</Link>} />}
        {loading && isAuthenticated !== false && <LoadingSkeleton variant="list" count={5} />}
        {!loading && isAuthenticated && watchlist.length === 0 && <EmptyState variant="card" icon={<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" /></svg>} title="Your watchlist is empty" description="Browse the rankings and click the star icon on any trader profile to add them here." action={<Link href="/rankings" style={{ display:'inline-block',padding:'10px 24px',background:'var(--color-accent-primary)',color:'var(--color-bg-primary)',borderRadius:tokens.radius.md,fontWeight:600,fontSize:14,textDecoration:'none' }}>Browse Rankings</Link>} />}
        {!loading && isAuthenticated && watchlist.length > 0 && (<>
          <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,flexWrap:'wrap',gap:8 }}>
            <div style={{ fontSize:13,color:watchlist.length>=180?'var(--color-accent-warning)':'var(--color-text-tertiary)' }}>{watchlist.length} / 200 saved{platformFilter!=='all'?` (${displayList.length} shown)`:''}</div>
            {platforms.length>1&&<select value={platformFilter} onChange={e=>setPlatformFilter(e.target.value)} aria-label="Filter by platform" style={{ padding:'6px 10px',borderRadius:tokens.radius.sm,border:`1px solid ${tokens.colors.border.primary}`,background:tokens.colors.bg.secondary,color:tokens.colors.text.primary,fontSize:12,cursor:'pointer' }}><option value="all">All Platforms</option>{platforms.map(p=><option key={p} value={p}>{PLATFORM_LABELS[p]||p}</option>)}</select>}
          </div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%',borderCollapse:'collapse',fontSize:14 }}>
              <thead><tr style={{ borderBottom:`1px solid var(--color-border-primary)` }}>
                <th style={thStyle}>Trader</th><th style={thStyle}>Exchange</th>
                <th style={{...thStyle,textAlign:'right',cursor:'pointer'}} onClick={()=>doSort('roi')}>ROI{sa('roi')}</th>
                <th style={{...thStyle,textAlign:'right',cursor:'pointer'}} onClick={()=>doSort('pnl')}>PnL{sa('pnl')}</th>
                <th style={{...thStyle,textAlign:'center',cursor:'pointer'}} onClick={()=>doSort('rank')}>Rank{sa('rank')}</th>
                <th style={{...thStyle,textAlign:'right',cursor:'pointer'}} onClick={()=>doSort('score')}>Score{sa('score')}</th>
                <th style={{...thStyle,textAlign:'center',width:100}}>Actions</th>
              </tr></thead>
              <tbody>{displayList.map(item=>{
                const key=`${item.source}:${item.source_trader_id}`; const isRemoving=removing===key
                const roiColor=item.roi!=null?(item.roi>=0?'var(--color-sentiment-bull)':'var(--color-sentiment-bear)'):'var(--color-text-tertiary)'
                return (<tr key={key} style={{ borderBottom:'1px solid var(--color-border-secondary)',transition:'background 0.15s',opacity:isRemoving?0.5:1,cursor:'pointer' }}
                  onMouseEnter={e=>{e.currentTarget.style.background='var(--color-bg-hover)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent'}}
                  onClick={()=>{window.location.href=`/trader/${encodeURIComponent(item.handle||item.source_trader_id)}?platform=${item.source}`}}>
                  <td style={{padding:'12px 16px'}}><Link href={`/trader/${encodeURIComponent(item.handle||item.source_trader_id)}?platform=${item.source}`} style={{color:'var(--color-text-primary)',fontWeight:600,textDecoration:'none'}} onClick={e=>e.stopPropagation()}>{item.handle||item.source_trader_id}</Link></td>
                  <td style={{padding:'12px 16px',color:'var(--color-text-secondary)'}}>{PLATFORM_LABELS[item.source]||item.source}</td>
                  <td style={{padding:'12px 16px',textAlign:'right',color:roiColor,fontWeight:600,fontVariantNumeric:'tabular-nums'}}>{formatRoi(item.roi)}</td>
                  <td style={{padding:'12px 16px',textAlign:'right',color:'var(--color-text-secondary)',fontVariantNumeric:'tabular-nums'}}>{item.pnl!=null?formatPnL(item.pnl):'--'}</td>
                  <td style={{padding:'12px 16px',textAlign:'center',color:'var(--color-text-secondary)',fontVariantNumeric:'tabular-nums'}}>{item.rank!=null?`#${item.rank}`:'--'}</td>
                  <td style={{padding:'12px 16px',textAlign:'right',color:'var(--color-text-primary)',fontWeight:600,fontVariantNumeric:'tabular-nums'}}>{formatScore(item.arena_score)}</td>
                  <td style={{padding:'12px 16px',textAlign:'center'}}>
                    {confirmRemove===key?(<span style={{display:'inline-flex',gap:4}}>
                      <button onClick={e=>{e.stopPropagation();handleRemove(item.source,item.source_trader_id);setConfirmRemove(null)}} style={{padding:'4px 8px',borderRadius:tokens.radius.sm,border:'none',background:'var(--color-accent-error)',color:'#fff',fontSize:11,fontWeight:600,cursor:'pointer'}}>Yes</button>
                      <button onClick={e=>{e.stopPropagation();setConfirmRemove(null)}} style={{padding:'4px 8px',borderRadius:tokens.radius.sm,border:`1px solid ${tokens.colors.border.primary}`,background:'transparent',color:tokens.colors.text.secondary,fontSize:11,cursor:'pointer'}}>No</button>
                    </span>):(<button onClick={e=>{e.stopPropagation();setConfirmRemove(key)}} disabled={isRemoving}
                      style={{padding:'4px 12px',borderRadius:tokens.radius.sm,border:'1px solid var(--color-accent-error)',background:'transparent',color:'var(--color-accent-error)',fontSize:12,fontWeight:500,cursor:isRemoving?'not-allowed':'pointer',transition:'background 0.15s'}}
                      onMouseEnter={e=>{if(!isRemoving)e.currentTarget.style.background='rgba(255,59,48,0.1)'}} onMouseLeave={e=>{e.currentTarget.style.background='transparent'}}>Remove</button>)}
                  </td>
                </tr>)
              })}</tbody>
            </table>
          </div>
        </>)}
      </div>
      <FloatingActionButton />
    </div>
  )
}

const thStyle: React.CSSProperties = { padding:'12px 16px',textAlign:'left',fontWeight:600,color:'var(--color-text-secondary)',fontSize:12,textTransform:'uppercase',letterSpacing:'0.5px' }
