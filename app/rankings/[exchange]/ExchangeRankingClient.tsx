'use client'

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { formatROI } from '@/app/components/ranking/utils'
import { formatPnL } from '@/lib/utils/format'
import { Sparkline } from '@/app/components/ui/Sparkline'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { useRealtimeRankings } from '@/lib/hooks/useRealtimeRankings'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { getScoreColor } from '@/lib/utils/score-colors'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import dynamic from 'next/dynamic'
import { useVirtualizer } from '@tanstack/react-virtual'
import PullToRefresh from '@/app/components/ui/PullToRefresh'
const ShareLeaderboardButton = dynamic(() => import('./ShareLeaderboardButton'), { ssr: false })

interface TraderData {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  platform: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  followers: number | null
  sharpe_ratio: number | null
  trades_count: number | null
  trader_type?: string | null
  is_bot?: boolean
  captured_at?: string | null
  _source_id?: string
}

type Period = '7D' | '30D' | '90D'
type ViewMode = 'table' | 'card'
type CardSortKey = 'rank' | 'roi' | 'pnl' | 'arena_score' | 'win_rate'
type SortKey = 'rank' | 'roi' | 'pnl' | 'win_rate' | 'max_drawdown' | 'arena_score' | 'followers' | 'sharpe_ratio' | 'trades_count'
type SortDir = 'asc' | 'desc'
type OptionalColumn = 'pnl' | 'followers' | 'sharpe_ratio' | 'trades_count'

const PERIOD_TO_WINDOW: Record<Period, string> = { '7D': '7d', '30D': '30d', '90D': '90d' }

function mapApiRow(row: Record<string, unknown>, exchange?: string): TraderData {
  return { trader_key: String(row.handle || row.source_trader_id || ''), display_name: row.handle ? String(row.handle) : null, avatar_url: (row.avatar_url as string | null) ?? null, platform: String(row.source || exchange || ''), roi: row.roi != null ? Number(row.roi) : null, pnl: row.pnl != null ? Number(row.pnl) : null, win_rate: row.win_rate as number | null, max_drawdown: row.max_drawdown as number | null, arena_score: row.arena_score as number | null, followers: row.followers as number | null, sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null, trades_count: row.trades_count != null ? Number(row.trades_count) : null, trader_type: (row.trader_type as string) || null, is_bot: row.source === 'web3_bot' || row.trader_type === 'bot', captured_at: (row.computed_at as string) || null, _source_id: String(row.source_trader_id || '') }
}

function getDisplayName(trader: TraderData): string {
  if (trader.display_name && !(trader.display_name.length > 10 && /^\d+$/.test(trader.display_name))) return trader.display_name
  return trader.trader_key.length > 10 ? `${trader.trader_key.slice(0, 4)}...${trader.trader_key.slice(-4)}` : trader.trader_key
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function TraderAvatarImg({ avatarUrl, traderKey, name, size = 32 }: { avatarUrl: string | null; traderKey: string; name: string; size?: number }) {
  const [error, setError] = useState(false)
  if (!avatarUrl || error) {
    if (isWalletAddress(traderKey)) return <img src={generateBlockieSvg(traderKey, size)} alt={name || 'Wallet avatar'} width={size} height={size} style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }} />
    return <span style={{ color: tokens.colors.white, fontSize: size * 0.375, fontWeight: 700 }}>{getAvatarInitial(name)}</span>
  }
  return <img src={avatarSrc(avatarUrl)} alt={name || 'Trader avatar'} width={size} height={size} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setError(true)} />
}

const RankBadge = React.memo(function RankBadge({ rank }: { rank: number }) {
  if (rank > 3) return <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary, minWidth: 28, textAlign: 'center', display: 'inline-block' }}>{rank}</span>
  const bg = rank === 1 ? 'linear-gradient(135deg, #FFD700, #FFA500)' : rank === 2 ? 'linear-gradient(135deg, #C0C0C0, #A0A0A0)' : 'linear-gradient(135deg, #CD7F32, #A0522D)'
  return <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, background: bg, color: rank === 1 ? 'var(--color-bg-primary)' : 'var(--color-on-accent)' }}>{rank}</span>
})

const TraderCardItem = React.memo(function TraderCardItem({ trader, rank }: { trader: TraderData; rank: number }) {
  const { t } = useLanguage()
  const name = getDisplayName(trader)
  const roiColor = trader.roi != null && trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return (
    <Link href={`/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`} style={{ textDecoration: 'none', display: 'block' }}>
      <div style={{ padding: tokens.spacing[4], borderRadius: tokens.radius.lg, background: rank === 1 ? 'linear-gradient(145deg, rgba(255,215,0,0.12) 0%, var(--overlay-hover) 60%)' : rank === 2 ? 'linear-gradient(145deg, rgba(192,192,192,0.10) 0%, var(--overlay-hover) 60%)' : rank === 3 ? 'linear-gradient(145deg, rgba(205,127,50,0.10) 0%, var(--overlay-hover) 60%)' : 'var(--overlay-hover)', border: rank === 1 ? '1px solid rgba(255,215,0,0.25)' : rank === 2 ? '1px solid rgba(192,192,192,0.20)' : rank === 3 ? '1px solid rgba(205,127,50,0.20)' : '1px solid var(--glass-border-light)', display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], transition: `transform ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`, boxShadow: rank <= 3 ? `${tokens.shadow.sm}, 0 0 12px ${rank === 1 ? 'rgba(255,215,0,0.15)' : rank === 2 ? 'rgba(192,192,192,0.12)' : 'rgba(205,127,50,0.12)'}` : tokens.shadow.sm }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <RankBadge rank={rank} />
          <div style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: getAvatarGradient(trader.trader_key) }}><TraderAvatarImg avatarUrl={trader.avatar_url} traderKey={trader.trader_key} name={name} size={40} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 4 }}>{EXCHANGE_NAMES[trader.platform] || trader.platform}{(trader.platform === 'web3_bot' || trader.trader_type === 'bot' || trader.is_bot) && <span style={{ padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600, color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)' }}>Bot</span>}</div>
          </div>
          <div style={{ textAlign: 'right' }}><div style={{ fontSize: 18, fontWeight: 800, color: roiColor }}>{formatROI(trader.roi)}</div><Sparkline roi={trader.roi ?? undefined} width={60} height={16} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: tokens.spacing[2] }}>
          <StatBlock label="PnL" value={trader.pnl != null ? `$${trader.pnl >= 1000 ? `${(trader.pnl / 1000).toFixed(1)}K` : trader.pnl.toFixed(0)}` : NULL_DISPLAY} color={trader.pnl != null ? (trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : undefined} />
          <StatBlock label={t('rankingWinRate')} value={trader.win_rate != null ? `${trader.win_rate.toFixed(1)}%` : NULL_DISPLAY} color={trader.win_rate != null ? (trader.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error) : undefined} />
          <StatBlock label={t('rankingMdd')} value={trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(1)}%` : NULL_DISPLAY} color={trader.max_drawdown != null ? tokens.colors.accent.error + 'cc' : undefined} />
          <StatBlock label={t('rankingArenaScore')} value={trader.arena_score != null ? trader.arena_score.toFixed(0) : NULL_DISPLAY} color={trader.arena_score != null ? getScoreColor(trader.arena_score) : undefined} />
        </div>
      </div>
    </Link>
  )
})

const StatBlock = React.memo(function StatBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (<div style={{ textAlign: 'center', padding: '6px 0', borderRadius: tokens.radius.md, background: 'var(--overlay-hover)' }}><div style={{ fontSize: 10, color: tokens.colors.text.tertiary, marginBottom: 2 }}>{label}</div><div style={{ fontSize: 13, fontWeight: 700, color: color || tokens.colors.text.primary }}>{value}</div></div>)
})

const SortArrow = React.memo(function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  return (<span style={{ display: 'inline-flex', flexDirection: 'column', marginLeft: 4, opacity: active ? 1 : 0.3, transition: 'opacity 0.15s' }}><svg width="8" height="5" viewBox="0 0 8 5" style={{ marginBottom: 1 }}><path d="M4 0L8 5H0z" fill={active && dir === 'asc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary} /></svg><svg width="8" height="5" viewBox="0 0 8 5"><path d="M4 5L0 0h8z" fill={active && dir === 'desc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary} /></svg></span>)
})

const SortHeader = React.memo(function SortHeader({ label, sortKey: sk, currentKey, currentDir, onSort, align = 'right', tooltip }: { label: string; sortKey: SortKey; currentKey: SortKey; currentDir: SortDir; onSort: (key: SortKey) => void; align?: 'left' | 'right' | 'center'; tooltip?: string }) {
  const active = currentKey === sk
  return (<button onClick={() => onSort(sk)} aria-label={`Sort by ${label}`} style={{ textAlign: align, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start', color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary, transition: 'color 0.15s', background: 'none', border: 'none', padding: 0, font: 'inherit', gap: 2 }}>{label}{tooltip && <span title={tooltip} style={{ cursor: 'help', opacity: 0.6, fontSize: 11, flexShrink: 0 }} aria-label={tooltip}>&#9432;</span>}<SortArrow active={active} dir={currentDir} /></button>)
})

function ColumnToggle({ columns, onToggle, label }: { columns: Record<OptionalColumn, boolean>; onToggle: (col: OptionalColumn) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()
  useEffect(() => { if (!open) return; const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }; document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler) }, [open])
  const columnLabels: Record<OptionalColumn, string> = { pnl: t('rankingPnl'), followers: t('rankingFollowers'), sharpe_ratio: t('rankingSharpeRatio'), trades_count: t('rankingTradesCount') }
  return (<div ref={ref} style={{ position: 'relative' }}><button onClick={() => setOpen(o => !o)} style={{ padding: '6px 12px', minHeight: 36, borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', fontSize: 12, fontWeight: 600, background: 'var(--overlay-hover)', color: tokens.colors.text.secondary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3h7a2 2 0 012 2v14a2 2 0 01-2 2h-7m0-18H5a2 2 0 00-2 2v14a2 2 0 002 2h7m0-18v18" /></svg>{label}</button>{open && (<div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--color-bg-primary)', border: '1px solid var(--glass-border-light)', borderRadius: tokens.radius.md, padding: '8px 0', zIndex: 100, minWidth: 160, boxShadow: tokens.shadow.lg }}>{(Object.keys(columnLabels) as OptionalColumn[]).map((col) => (<label key={col} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, color: tokens.colors.text.primary }}><input type="checkbox" checked={columns[col]} onChange={() => onToggle(col)} style={{ accentColor: tokens.colors.accent.brand }} />{columnLabels[col]}</label>))}</div>)}</div>)
}

function PeriodSelector({ period, onChange, loading }: { period: Period; onChange: (p: Period) => void; loading: boolean }) {
  const { t } = useLanguage()
  const periods: Period[] = ['7D', '30D', '90D']
  const labels: Record<Period, string> = { '7D': t('days7'), '30D': t('days30'), '90D': t('days90') }
  return (<div style={{ display: 'inline-flex', gap: 0, padding: 2, background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: '1px solid var(--glass-border-light)' }}>{periods.map((p) => (<button key={p} onClick={() => onChange(p)} disabled={loading} style={{ padding: '6px 14px', minHeight: 36, borderRadius: tokens.radius.md, border: 'none', fontSize: 13, fontWeight: period === p ? 700 : 500, background: period === p ? tokens.colors.accent.brand + '20' : 'transparent', color: period === p ? tokens.colors.accent.brand : tokens.colors.text.tertiary, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1, transition: 'all 0.15s' }}>{labels[p]}</button>))}</div>)
}

export default function ExchangeRankingClient({ traders: initialTraders, exchange, totalCount }: { traders: TraderData[]; exchange?: string; totalCount?: number }) {
  const { language, t } = useLanguage()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlPeriod = (searchParams.get('period')?.toUpperCase() || '90D') as Period
  const validPeriod = (['7D', '30D', '90D'] as const).includes(urlPeriod as Period) ? urlPeriod : '90D'
  const [period, setPeriod] = useState<Period>(validPeriod)
  const [periodLoading, setPeriodLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [optionalColumns, setOptionalColumns] = useState<Record<OptionalColumn, boolean>>({ pnl: true, followers: false, sharpe_ratio: false, trades_count: false })
  // Initialize with 'table' for SSR to avoid hydration mismatch.
  // The useEffect below immediately corrects to 'card' on mobile after mount.
  // We use suppressHydrationWarning or accept the single no-CLS swap since
  // ExchangeRankingClient is wrapped in a Suspense on the server (skeleton shown).
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [cardSortKey, setCardSortKey] = useState<CardSortKey>('rank')
  const [cardSortDir, setCardSortDir] = useState<SortDir>('desc')
  const [traders, setTraders] = useState(initialTraders)
  useEffect(() => { setTraders(initialTraders) }, [initialTraders])
  useEffect(() => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); searchTimerRef.current = setTimeout(() => setDebouncedSearch(searchQuery), 300); return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) } }, [searchQuery])
  const handlePeriodChange = useCallback((newPeriod: Period) => { setPeriod(newPeriod); const params = new URLSearchParams(searchParams.toString()); if (newPeriod === '90D') { params.delete('period') } else { params.set('period', newPeriod) }; const qs = params.toString(); router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false }) }, [pathname, router, searchParams])
  useEffect(() => { if (!exchange) return; let cancelled = false; setPeriodLoading(true); const win = PERIOD_TO_WINDOW[period]; fetch('/api/rankings?window=' + win + '&platform=' + encodeURIComponent(exchange) + '&limit=5000').then(r => r.ok ? r.json() : null).then(json => { if (cancelled || !json?.data?.length) { setPeriodLoading(false); return }; setTraders(json.data.map((row: Record<string, unknown>) => mapApiRow(row, exchange))); setPeriodLoading(false) }).catch(() => setPeriodLoading(false)); return () => { cancelled = true } }, [exchange, period]) // eslint-disable-line react-hooks/exhaustive-deps
  const handleRealtimeUpdate = useCallback((updates: Array<{ id: string; source: string; roi: number; pnl: number | null; win_rate: number | null; max_drawdown: number | null; arena_score: number | null; [key: string]: unknown }>) => { setTraders(prev => { const updateMap = new Map(updates.map(u => [u.id, u])); let changed = false; const next = prev.map(tr => { const u = updateMap.get(tr._source_id || '') || updateMap.get(tr.trader_key); if (!u) return tr; changed = true; return { ...tr, roi: u.roi, pnl: u.pnl ?? tr.pnl, win_rate: u.win_rate, max_drawdown: u.max_drawdown, arena_score: u.arena_score } }); return changed ? next : prev }) }, [])
  useRealtimeRankings({ onUpdate: handleRealtimeUpdate })
  const filteredTraders = useMemo(() => { if (!debouncedSearch.trim()) return traders; const q = debouncedSearch.toLowerCase().trim(); return traders.filter(tr => getDisplayName(tr).toLowerCase().includes(q) || tr.trader_key.toLowerCase().includes(q)) }, [traders, debouncedSearch])
  const { lastUpdatedText, isStale } = useMemo(() => { let latestTs: string | null = null; for (const tr of traders) { if (tr.captured_at && (!latestTs || tr.captured_at > latestTs)) latestTs = tr.captured_at }; if (!latestTs) return { lastUpdatedText: null, isStale: false }; const diffHours = (Date.now() - new Date(latestTs).getTime()) / (1000 * 60 * 60); const locale: Locale = language === 'zh' ? 'zh' : language === 'ja' ? 'ja' : language === 'ko' ? 'ko' : 'en'; return { lastUpdatedText: formatTimeAgo(latestTs, locale), isStale: diffHours > 6 } }, [traders, language])
  const rankMap = useMemo(() => { const m = new Map<TraderData, number>(); filteredTraders.forEach((tr, i) => m.set(tr, i + 1)); return m }, [filteredTraders])
  const handleSort = (key: SortKey) => { if (sortKey === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc') } else { setSortKey(key); setSortDir(key === 'rank' ? 'asc' : 'desc') } }
  const sortedTraders = useMemo(() => { if (sortKey === 'rank') return sortDir === 'asc' ? filteredTraders : [...filteredTraders].reverse(); return [...filteredTraders].sort((a, b) => { const av = a[sortKey as keyof TraderData] as number | null; const bv = b[sortKey as keyof TraderData] as number | null; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; return sortDir === 'desc' ? bv - av : av - bv }) }, [filteredTraders, sortKey, sortDir])
  const cardSortedTraders = useMemo(() => { if (cardSortKey === 'rank') return cardSortDir === 'asc' ? filteredTraders : [...filteredTraders].reverse(); return [...filteredTraders].sort((a, b) => { const av = a[cardSortKey]; const bv = b[cardSortKey]; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; return cardSortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number) }) }, [filteredTraders, cardSortKey, cardSortDir])
  const activeTraders = viewMode === 'card' ? cardSortedTraders : sortedTraders
  useEffect(() => { const mq = window.matchMedia('(max-width: 768px)'); setViewMode(mq.matches ? 'card' : 'table'); const handler = (e: MediaQueryListEvent) => setViewMode(e.matches ? 'card' : 'table'); mq.addEventListener('change', handler); return () => mq.removeEventListener('change', handler) }, [])
  const handleRefresh = useCallback(async () => { try { const win = PERIOD_TO_WINDOW[period]; const res = await fetch('/api/rankings?window=' + win + '&platform=' + encodeURIComponent(exchange || '') + '&limit=5000'); if (res.ok) { const json = await res.json(); if (Array.isArray(json.data) && json.data.length > 0) { setTraders(json.data.map((row: Record<string, unknown>) => mapApiRow(row, exchange))); return } } } catch { /* fallback */ } router.refresh() }, [exchange, router, period])
  const handleColumnToggle = useCallback((col: OptionalColumn) => { setOptionalColumns(prev => ({ ...prev, [col]: !prev[col] })) }, [])
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualize = viewMode === 'table' && activeTraders.length > 50
  const rowVirtualizer = useVirtualizer({ count: shouldVirtualize ? activeTraders.length : 0, getScrollElement: () => tableScrollRef.current, estimateSize: () => 48, overscan: 10 })
  const cardScrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualizeCards = viewMode === 'card' && activeTraders.length > 50
  const cardVirtualizer = useVirtualizer({ count: shouldVirtualizeCards ? activeTraders.length : 0, getScrollElement: () => cardScrollRef.current, estimateSize: () => 160, overscan: 8 })
  const gridCols = useMemo(() => { const cols = ['40px', 'minmax(140px, 0.35fr)', '90px', '80px', '80px', '80px']; if (optionalColumns.pnl) cols.push('90px'); if (optionalColumns.followers) cols.push('80px'); if (optionalColumns.sharpe_ratio) cols.push('70px'); if (optionalColumns.trades_count) cols.push('70px'); cols.push('90px'); return cols.join(' ') }, [optionalColumns])
  const gridColsMobile = useMemo(() => { const cols = ['36px', 'minmax(100px, 1fr)', '72px', '64px', '64px', '64px']; if (optionalColumns.pnl) cols.push('72px'); if (optionalColumns.followers) cols.push('64px'); if (optionalColumns.sharpe_ratio) cols.push('56px'); if (optionalColumns.trades_count) cols.push('56px'); cols.push('72px'); return cols.join(' ') }, [optionalColumns])
  const renderRowCells = useCallback((td: TraderData, originalRank: number) => { const name = getDisplayName(td); const roiColor = td.roi != null && td.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error; const wrColor = td.win_rate != null ? (td.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary; return (<><div><RankBadge rank={originalRank} /></div><div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}><div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: getAvatarGradient(td.trader_key) }}><TraderAvatarImg avatarUrl={td.avatar_url} traderKey={td.trader_key} name={name} size={32} /></div><span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>{(td.platform === 'web3_bot' || td.trader_type === 'bot' || td.is_bot) && <span style={{ padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600, flexShrink: 0, color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)' }}>Bot</span>}</div><div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: roiColor }}>{formatROI(td.roi)}</div><div style={{ display: 'flex', justifyContent: 'center' }}><Sparkline roi={td.roi ?? undefined} width={72} height={20} /></div><div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: wrColor }}>{td.win_rate != null ? `${td.win_rate.toFixed(2)}%` : NULL_DISPLAY}</div><div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: td.max_drawdown != null ? tokens.colors.accent.error + 'cc' : tokens.colors.text.tertiary }}>{td.max_drawdown != null ? `-${Math.abs(td.max_drawdown).toFixed(2)}%` : NULL_DISPLAY}</div>{optionalColumns.pnl && <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: td.pnl != null ? (td.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary }}>{formatPnL(td.pnl)}</div>}{optionalColumns.followers && <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>{td.followers != null ? formatNumber(td.followers) : NULL_DISPLAY}</div>}{optionalColumns.sharpe_ratio && <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: td.sharpe_ratio != null ? (td.sharpe_ratio >= 1 ? tokens.colors.accent.success : td.sharpe_ratio >= 0 ? tokens.colors.text.primary : tokens.colors.accent.error) : tokens.colors.text.tertiary }}>{td.sharpe_ratio != null ? td.sharpe_ratio.toFixed(2) : NULL_DISPLAY}</div>}{optionalColumns.trades_count && <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>{td.trades_count != null ? formatNumber(td.trades_count) : NULL_DISPLAY}</div>}<div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>{td.arena_score != null ? <span style={{ width: 32, height: 32, borderRadius: '50%', border: `2px solid ${getScoreColor(td.arena_score)}`, background: `color-mix(in srgb, ${getScoreColor(td.arena_score)} 10%, transparent)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: getScoreColor(td.arena_score) }}>{td.arena_score.toFixed(0)}</span> : <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>{NULL_DISPLAY}</span>}</div></>) }, [optionalColumns])
  const getRowHighlightStyle = useCallback((rank: number): React.CSSProperties => { if (rank === 1) return { background: 'linear-gradient(135deg, rgba(255,215,0,0.10) 0%, rgba(255,215,0,0.03) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #FFD700', borderRadius: 10, margin: '2px 4px' }; if (rank === 2) return { background: 'linear-gradient(135deg, rgba(192,192,192,0.08) 0%, rgba(192,192,192,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #C0C0C0', borderRadius: 10, margin: '2px 4px' }; if (rank === 3) return { background: 'linear-gradient(135deg, rgba(205,127,50,0.08) 0%, rgba(205,127,50,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #CD7F32', borderRadius: 10, margin: '2px 4px' }; return {} }, [])
  if (traders.length === 0) return (<div style={{ textAlign: 'center', padding: tokens.spacing[8], color: tokens.colors.text.tertiary }}><div style={{ marginBottom: tokens.spacing[3] }}><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, color: tokens.colors.text.tertiary, margin: '0 auto' }}><path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 4-6" /></svg></div><div style={{ fontSize: tokens.typography.fontSize.base, fontWeight: 600, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2] }}>{t('rankingNoData')}</div><div style={{ fontSize: tokens.typography.fontSize.sm }}>{t('rankingNoDataDesc')}</div></div>)
  return (
    <PullToRefresh onRefresh={handleRefresh}><div>
      <div style={{ display: 'flex', gap: 8, marginBottom: tokens.spacing[4], justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><PeriodSelector period={period} onChange={handlePeriodChange} loading={periodLoading} /><button onClick={() => setViewMode('table')} style={{ padding: '6px 16px', minHeight: 36, borderRadius: tokens.radius.md, border: 'none', fontSize: 13, fontWeight: viewMode === 'table' ? 700 : 500, background: viewMode === 'table' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)', color: viewMode === 'table' ? tokens.colors.accent.brand : tokens.colors.text.secondary, cursor: 'pointer' }}>{t('rankingTableView')}</button><button onClick={() => setViewMode('card')} style={{ padding: '6px 16px', minHeight: 36, borderRadius: tokens.radius.md, border: 'none', fontSize: 13, fontWeight: viewMode === 'card' ? 700 : 500, background: viewMode === 'card' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)', color: viewMode === 'card' ? tokens.colors.accent.brand : tokens.colors.text.secondary, cursor: 'pointer' }}>{t('rankingCardView')}</button></div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{viewMode === 'table' && <ColumnToggle columns={optionalColumns} onToggle={handleColumnToggle} label={t('rankingColumns')} />}<ShareLeaderboardButton traders={traders} exchange={exchange} /></div></div>
      <div style={{ marginBottom: tokens.spacing[3], position: 'relative' }}><div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, pointerEvents: 'none' }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg><input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder={t('rankingSearch')} style={{ width: '100%', padding: '8px 12px 8px 36px', borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', background: 'var(--overlay-hover)', color: tokens.colors.text.primary, fontSize: 13, outline: 'none' }} />{searchQuery && <button onClick={() => setSearchQuery('')} style={{ position: 'absolute', right: 8, padding: '4px 8px', borderRadius: tokens.radius.sm, border: 'none', background: 'var(--glass-border-light)', color: tokens.colors.text.secondary, fontSize: 11, cursor: 'pointer' }}>{t('rankingClearSearch')}</button>}</div>{debouncedSearch.trim() && <div style={{ fontSize: 12, color: tokens.colors.text.tertiary, marginTop: 4 }}>{t('rankingSearchResults').replace('{count}', String(filteredTraders.length))}</div>}</div>
      {lastUpdatedText && (<div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginBottom: tokens.spacing[3], padding: isStale ? '4px 10px' : undefined, borderRadius: isStale ? tokens.radius.md : undefined, background: isStale ? 'rgba(202, 138, 4, 0.08)' : undefined, border: isStale ? '1px solid rgba(202, 138, 4, 0.20)' : undefined, fontSize: 12, color: isStale ? '#ca8a04' : tokens.colors.text.tertiary }}>{isStale ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}<span suppressHydrationWarning>{isStale ? `${t('dataStaleWarning')} \u00b7 ` : ''}{t('lastUpdated')} {lastUpdatedText}</span></div>)}
      {periodLoading && <div style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}><div style={{ width: 24, height: 24, border: `2px solid ${tokens.colors.accent.brand}30`, borderTopColor: tokens.colors.accent.brand, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /><style>{'@keyframes spin { to { transform: rotate(360deg) } }'}</style></div>}
      {viewMode === 'card' ? (<div><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: tokens.spacing[3] }}><span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{t('sortBy')}:</span><select value={cardSortKey} onChange={e => setCardSortKey(e.target.value as CardSortKey)} style={{ padding: '4px 8px', borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', background: 'var(--overlay-hover)', color: tokens.colors.text.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}><option value="rank">{t('rankingRank')}</option><option value="roi">ROI</option><option value="pnl">PnL</option><option value="arena_score">{t('rankingScore')}</option><option value="win_rate">{t('rankingWinRate')}</option></select><button onClick={() => setCardSortDir(d => d === 'desc' ? 'asc' : 'desc')} style={{ padding: '4px 8px', borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', background: 'var(--overlay-hover)', color: tokens.colors.text.primary, fontSize: 12, cursor: 'pointer' }} title={cardSortDir === 'desc' ? 'Descending' : 'Ascending'}>{cardSortDir === 'desc' ? '\u2193' : '\u2191'}</button></div>{shouldVirtualizeCards ? (<div ref={cardScrollRef} style={{ height: '80vh', overflow: 'auto' }}><div style={{ height: cardVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>{cardVirtualizer.getVirtualItems().map((virtualRow) => { const td = activeTraders[virtualRow.index]; const originalRank = rankMap.get(td) || 0; return <div key={`${td.platform}:${td.trader_key}:${virtualRow.index}`} data-index={virtualRow.index} ref={cardVirtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)`, padding: `0 0 ${tokens.spacing[3]} 0` }}><TraderCardItem trader={td} rank={originalRank} /></div> })}</div></div>) : (<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacing[3], paddingBottom: tokens.spacing[4] }}>{activeTraders.map((td, i) => { const originalRank = rankMap.get(td) || 0; return <TraderCardItem key={`${td.platform}:${td.trader_key}:${i}`} trader={td} rank={originalRank} /> })}</div>)}<div style={{ textAlign: 'center', padding: `${tokens.spacing[3]} 0`, fontSize: 12, color: tokens.colors.text.tertiary }}>{t('tradersOnExchange').replace('{count}', String(activeTraders.length))}</div></div>) : (<><style>{`.exchange-table-grid-dynamic { grid-template-columns: ${gridCols}; } @media (max-width: 900px) { .exchange-table-grid-dynamic { grid-template-columns: ${gridColsMobile}; } } .exchange-row:hover { background: var(--overlay-hover) !important; } .exchange-table-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }`}</style><div className="exchange-table-wrapper" ref={shouldVirtualize ? tableScrollRef : undefined} style={shouldVirtualize ? { height: '80vh', overflow: 'auto' } : undefined}><div style={{ borderRadius: tokens.radius.lg, overflow: 'visible', background: 'var(--overlay-hover)', border: '1px solid var(--glass-border-light)' }}><div className="exchange-table-grid-dynamic" style={{ display: 'grid', gap: 8, padding: '12px 16px', fontSize: 12, fontWeight: 600, color: tokens.colors.text.secondary, borderBottom: '1px solid var(--glass-border-light)', position: 'sticky', top: shouldVirtualize ? 0 : 56, zIndex: 10, background: 'var(--color-bg-primary)', borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0` }}><SortHeader label={t('rankingRank')} sortKey="rank" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="left" /><div>{t('rankingTrader')}</div><SortHeader label={`${t('rankingRoi')} (${period})`} sortKey="roi" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} /><div style={{ textAlign: 'center' }}>{t('rankingTrend')}</div><SortHeader label={t('rankingWinRate')} sortKey="win_rate" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Percentage of profitable trading days." /><SortHeader label={t('rankingMdd')} sortKey="max_drawdown" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Largest peak-to-trough decline. Lower is better." />{optionalColumns.pnl && <SortHeader label={t('rankingPnl')} sortKey="pnl" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}{optionalColumns.followers && <SortHeader label={t('rankingFollowers')} sortKey="followers" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}{optionalColumns.sharpe_ratio && <SortHeader label={t('rankingSharpeRatio')} sortKey="sharpe_ratio" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Risk-adjusted return. >1 is good, >2 is excellent." />}{optionalColumns.trades_count && <SortHeader label={t('rankingTradesCount')} sortKey="trades_count" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}<SortHeader label={t('rankingScore')} sortKey="arena_score" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Arena Score: 0-100 composite of ROI (60%) and PnL (40%)." /></div>{shouldVirtualize ? (<div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>{rowVirtualizer.getVirtualItems().map((virtualRow) => { const i = virtualRow.index; const td = activeTraders[i]; const originalRank = rankMap.get(td) || 0; return <Link key={`${td.platform}:${td.trader_key}:${i}`} href={`/trader/${encodeURIComponent(td.trader_key)}?platform=${td.platform}`} className="exchange-table-grid-dynamic exchange-row" data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)`, display: 'grid', gap: 8, padding: '10px 16px', alignItems: 'center', textDecoration: 'none', borderBottom: originalRank <= 3 ? undefined : '1px solid var(--overlay-hover)', transition: 'background 0.15s', ...getRowHighlightStyle(originalRank) }}>{renderRowCells(td, originalRank)}</Link> })}</div>) : (activeTraders.map((td, i) => { const originalRank = rankMap.get(td) || 0; return <Link key={`${td.platform}:${td.trader_key}:${i}`} href={`/trader/${encodeURIComponent(td.trader_key)}?platform=${td.platform}`} className="exchange-table-grid-dynamic exchange-row" style={{ display: 'grid', gap: 8, padding: '10px 16px', alignItems: 'center', textDecoration: 'none', borderBottom: originalRank <= 3 ? undefined : '1px solid var(--overlay-hover)', transition: 'background 0.15s', ...getRowHighlightStyle(originalRank) }}>{renderRowCells(td, originalRank)}</Link> }))}</div></div></>)}
    </div></PullToRefresh>
  )
}
