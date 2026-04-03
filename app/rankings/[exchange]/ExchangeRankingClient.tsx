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
import { useProStatus } from '@/lib/hooks/useProStatus'
import { exportToCSV, exportToJSON, exportToPDF } from '@/lib/utils/export'
const ShareLeaderboardButton = dynamic(() => import('./ShareLeaderboardButton'), { ssr: false })

// ── Advanced Filters (Pro-gated) ────────────────────────────

interface AdvancedFilterState {
  roi_min: number | null
  roi_max: number | null
  win_rate_min: number | null
  win_rate_max: number | null
  mdd_min: number | null
  mdd_max: number | null
  sharpe_min: number | null
  sharpe_max: number | null
  min_trades: number | null
}

const EMPTY_FILTERS: AdvancedFilterState = {
  roi_min: null, roi_max: null,
  win_rate_min: null, win_rate_max: null,
  mdd_min: null, mdd_max: null,
  sharpe_min: null, sharpe_max: null,
  min_trades: null,
}

function hasActiveAdvancedFilters(f: AdvancedFilterState): boolean {
  return Object.values(f).some(v => v != null)
}

function applyAdvancedFilters(traders: TraderData[], f: AdvancedFilterState): TraderData[] {
  return traders.filter(tr => {
    if (f.roi_min != null && (tr.roi == null || tr.roi < f.roi_min)) return false
    if (f.roi_max != null && (tr.roi == null || tr.roi > f.roi_max)) return false
    if (f.win_rate_min != null && (tr.win_rate == null || tr.win_rate < f.win_rate_min)) return false
    if (f.win_rate_max != null && (tr.win_rate == null || tr.win_rate > f.win_rate_max)) return false
    if (f.mdd_min != null && (tr.max_drawdown == null || Math.abs(tr.max_drawdown) < f.mdd_min)) return false
    if (f.mdd_max != null && (tr.max_drawdown == null || Math.abs(tr.max_drawdown) > f.mdd_max)) return false
    if (f.sharpe_min != null && (tr.sharpe_ratio == null || tr.sharpe_ratio < f.sharpe_min)) return false
    if (f.sharpe_max != null && (tr.sharpe_ratio == null || tr.sharpe_ratio > f.sharpe_max)) return false
    if (f.min_trades != null && (tr.trades_count == null || tr.trades_count < f.min_trades)) return false
    return true
  })
}

function parseFilterParams(searchParams: URLSearchParams): AdvancedFilterState {
  const n = (key: string) => { const v = searchParams.get(key); return v != null ? Number(v) : null }
  return {
    roi_min: n('roi_min'), roi_max: n('roi_max'),
    win_rate_min: n('wr_min'), win_rate_max: n('wr_max'),
    mdd_min: n('mdd_min'), mdd_max: n('mdd_max'),
    sharpe_min: n('sharpe_min'), sharpe_max: n('sharpe_max'),
    min_trades: n('min_trades'),
  }
}

function serializeFilterParams(f: AdvancedFilterState, params: URLSearchParams): void {
  const map: Record<string, number | null> = {
    roi_min: f.roi_min, roi_max: f.roi_max,
    wr_min: f.win_rate_min, wr_max: f.win_rate_max,
    mdd_min: f.mdd_min, mdd_max: f.mdd_max,
    sharpe_min: f.sharpe_min, sharpe_max: f.sharpe_max,
    min_trades: f.min_trades,
  }
  for (const [key, val] of Object.entries(map)) {
    if (val != null) params.set(key, String(val))
    else params.delete(key)
  }
}

function RangeInput({ label, min, max, onMinChange, onMaxChange, step = 1, unit = '', disabled }: {
  label: string; min: number | null; max: number | null
  onMinChange: (v: number | null) => void; onMaxChange: (v: number | null) => void
  step?: number; unit?: string; disabled?: boolean
}) {
  const inputStyle: React.CSSProperties = {
    width: 80, padding: '4px 8px', borderRadius: 6,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: disabled ? tokens.colors.bg.tertiary : tokens.colors.bg.secondary,
    color: disabled ? tokens.colors.text.tertiary : tokens.colors.text.primary,
    fontSize: 12, textAlign: 'center' as const, outline: 'none',
    opacity: disabled ? 0.5 : 1,
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: tokens.colors.text.secondary, minWidth: 80 }}>{label}{unit ? ` (${unit})` : ''}</span>
      <input type="number" placeholder="Min" step={step} value={min ?? ''} disabled={disabled}
        onChange={e => onMinChange(e.target.value ? Number(e.target.value) : null)} style={inputStyle} />
      <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>-</span>
      <input type="number" placeholder="Max" step={step} value={max ?? ''} disabled={disabled}
        onChange={e => onMaxChange(e.target.value ? Number(e.target.value) : null)} style={inputStyle} />
    </div>
  )
}

function AdvancedFiltersPanel({ filters, onChange, isPro, expanded, onToggle, onReset, t }: {
  filters: AdvancedFilterState; onChange: (f: AdvancedFilterState) => void
  isPro: boolean; expanded: boolean; onToggle: () => void; onReset: () => void
  t: (key: string) => string
}) {
  const hasFilters = hasActiveAdvancedFilters(filters)
  const update = (patch: Partial<AdvancedFilterState>) => onChange({ ...filters, ...patch })

  return (
    <div style={{
      marginBottom: tokens.spacing[3],
      borderRadius: tokens.radius.lg,
      border: `1px solid ${hasFilters ? tokens.colors.accent.primary + '40' : 'var(--glass-border-light)'}`,
      background: 'var(--overlay-hover)',
      overflow: 'hidden',
    }}>
      <button onClick={onToggle} style={{
        width: '100%', padding: '8px 16px', background: 'transparent', border: 'none',
        color: tokens.colors.text.primary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 13, fontWeight: 600,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        {t('advancedFilter') || 'Advanced Filters'}
        {!isPro && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
            background: 'linear-gradient(135deg, rgba(167,139,250,0.2), rgba(139,92,246,0.2))',
            color: '#a78bfa', border: '1px solid rgba(167,139,250,0.4)',
          }}>Pro</span>
        )}
        {hasFilters && (
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10,
            background: tokens.colors.accent.primary + '20', color: tokens.colors.accent.primary,
          }}>Active</span>
        )}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ marginLeft: 'auto', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div style={{
          padding: '12px 16px', borderTop: '1px solid var(--glass-border-light)',
          position: 'relative',
          ...(isPro ? {} : { filter: 'blur(1px)', pointerEvents: 'none' as const, opacity: 0.5 }),
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            <RangeInput label="ROI" unit="%" min={filters.roi_min} max={filters.roi_max}
              onMinChange={v => update({ roi_min: v })} onMaxChange={v => update({ roi_max: v })} step={1} disabled={!isPro} />
            <RangeInput label={t('rankingWinRate') || 'Win Rate'} unit="%" min={filters.win_rate_min} max={filters.win_rate_max}
              onMinChange={v => update({ win_rate_min: v })} onMaxChange={v => update({ win_rate_max: v })} step={1} disabled={!isPro} />
            <RangeInput label={t('rankingMdd') || 'Max Drawdown'} unit="%" min={filters.mdd_min} max={filters.mdd_max}
              onMinChange={v => update({ mdd_min: v })} onMaxChange={v => update({ mdd_max: v })} step={1} disabled={!isPro} />
            <RangeInput label="Sharpe Ratio" min={filters.sharpe_min} max={filters.sharpe_max}
              onMinChange={v => update({ sharpe_min: v })} onMaxChange={v => update({ sharpe_max: v })} step={0.1} disabled={!isPro} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: tokens.colors.text.secondary, minWidth: 80 }}>{t('rankingTradesCount') || 'Min Trades'}</span>
              <input type="number" placeholder="Min" value={filters.min_trades ?? ''} disabled={!isPro}
                onChange={e => update({ min_trades: e.target.value ? Number(e.target.value) : null })}
                style={{
                  width: 80, padding: '4px 8px', borderRadius: 6,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: !isPro ? tokens.colors.bg.tertiary : tokens.colors.bg.secondary,
                  color: !isPro ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  fontSize: 12, textAlign: 'center', outline: 'none', opacity: !isPro ? 0.5 : 1,
                }} />
            </div>
          </div>
          {hasFilters && isPro && (
            <button onClick={onReset} style={{
              marginTop: 8, padding: '4px 12px', fontSize: 11, fontWeight: 600,
              color: tokens.colors.accent.primary, background: 'transparent',
              border: `1px solid ${tokens.colors.accent.primary}40`, borderRadius: 6, cursor: 'pointer',
            }}>{t('resetToDefault') || 'Reset Filters'}</button>
          )}
        </div>
      )}

      {expanded && !isPro && (
        <div style={{
          position: 'relative', padding: '12px 16px', borderTop: '1px solid var(--glass-border-light)',
          textAlign: 'center',
        }}>
          <Link href="/pricing" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 20px', borderRadius: 8,
            background: 'linear-gradient(135deg, #a78bfa, #8b5cf6)',
            color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3Z" /></svg>
            Upgrade to Pro
          </Link>
        </div>
      )}
    </div>
  )
}

// ── Pro CSV Export Button ────────────────────────────────────

function ProExportButton({ traders, exchange, period, isPro, t }: {
  traders: TraderData[]; exchange?: string; period: Period; isPro: boolean
  t: (key: string) => string
}) {
  const [showMenu, setShowMenu] = React.useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  const doExport = (format: 'csv' | 'json' | 'pdf') => {
    setShowMenu(false)
    const rows = traders.map((tr, i) => ({
      Rank: i + 1,
      Trader: getDisplayName(tr),
      Platform: EXCHANGE_NAMES[tr.platform] || tr.platform,
      ROI: tr.roi != null ? `${tr.roi.toFixed(2)}%` : '',
      PnL: tr.pnl != null ? `$${tr.pnl.toFixed(2)}` : '',
      'Win Rate': tr.win_rate != null ? `${tr.win_rate.toFixed(2)}%` : '',
      MDD: tr.max_drawdown != null ? `${tr.max_drawdown.toFixed(2)}%` : '',
      Sharpe: tr.sharpe_ratio != null ? tr.sharpe_ratio.toFixed(2) : '',
      'Arena Score': tr.arena_score != null ? tr.arena_score.toFixed(1) : '',
    }))
    const filename = `arena-ranking-${exchange || 'all'}-${period}`
    if (format === 'json') exportToJSON(rows, filename)
    else if (format === 'pdf') exportToPDF(rows as unknown as Record<string, unknown>[], filename)
    else exportToCSV(rows as unknown as Record<string, unknown>[], filename)
  }

  if (!isPro) {
    return (
      <Link href="/pricing" title="Pro feature" style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '6px 12px', borderRadius: tokens.radius.md,
        border: '1px solid var(--glass-border-light)',
        background: 'var(--overlay-hover)', color: tokens.colors.text.tertiary,
        fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'none', opacity: 0.7,
      }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3Z" /></svg>
        {t('export') || 'Export'}
      </Link>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setShowMenu(o => !o)} aria-expanded={showMenu} aria-haspopup="menu" style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '6px 12px', borderRadius: tokens.radius.md,
        border: '1px solid var(--glass-border-light)',
        background: 'var(--overlay-hover)', color: tokens.colors.text.primary,
        fontSize: 12, fontWeight: 600, cursor: 'pointer',
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
        {t('export') || 'Export'}
      </button>
      {showMenu && (
        <div className="dropdown-enter" role="menu" style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md, padding: 4, zIndex: 100, minWidth: 120,
          boxShadow: tokens.shadow.md,
        }}>
          <button onClick={() => doExport('csv')} style={{
            display: 'block', width: '100%', padding: '6px 12px', background: 'transparent',
            border: 'none', color: tokens.colors.text.primary, fontSize: 13, cursor: 'pointer', textAlign: 'left',
            borderRadius: tokens.radius.sm,
          }}
            onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
            CSV
          </button>
          <button onClick={() => doExport('json')} style={{
            display: 'block', width: '100%', padding: '6px 12px', background: 'transparent',
            border: 'none', color: tokens.colors.text.primary, fontSize: 13, cursor: 'pointer', textAlign: 'left',
            borderRadius: tokens.radius.sm,
          }}
            onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
            JSON
          </button>
          <button onClick={() => doExport('pdf')} style={{
            display: 'block', width: '100%', padding: '6px 12px', background: 'transparent',
            border: 'none', color: tokens.colors.text.primary, fontSize: 13, cursor: 'pointer', textAlign: 'left',
            borderRadius: tokens.radius.sm,
          }}
            onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
            PDF
          </button>
        </div>
      )}
    </div>
  )
}

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

// Module-level style constants — avoid allocating new objects inside useCallback/render (GC pressure)
const ROW_HIGHLIGHT_RANK_1: React.CSSProperties = { background: 'linear-gradient(135deg, rgba(255,215,0,0.10) 0%, rgba(255,215,0,0.03) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #FFD700', borderRadius: 10, margin: '2px 4px' }
const ROW_HIGHLIGHT_RANK_2: React.CSSProperties = { background: 'linear-gradient(135deg, rgba(192,192,192,0.08) 0%, rgba(192,192,192,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #C0C0C0', borderRadius: 10, margin: '2px 4px' }
const ROW_HIGHLIGHT_RANK_3: React.CSSProperties = { background: 'linear-gradient(135deg, rgba(205,127,50,0.08) 0%, rgba(205,127,50,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #CD7F32', borderRadius: 10, margin: '2px 4px' }
const ROW_HIGHLIGHT_DEFAULT: React.CSSProperties = {}

// Shared cell styles for renderRowCells — static objects reused across all rows
const CELL_FLEX_CENTER: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }
const CELL_AVATAR_WRAPPER: React.CSSProperties = { width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
const CELL_NAME: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const CELL_BOT_BADGE: React.CSSProperties = { padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600, flexShrink: 0, color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)' }
const CELL_SPARKLINE: React.CSSProperties = { display: 'flex', justifyContent: 'center' }
const CELL_SCORE_NULL: React.CSSProperties = { fontSize: 13, color: tokens.colors.text.tertiary }
const CELL_SCORE_FLEX: React.CSSProperties = { textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }

function mapApiRow(row: Record<string, unknown>, exchange?: string): TraderData {
  // API returns metrics nested in a `metrics` object; SSR returns flat fields
  const m = (row.metrics as Record<string, unknown>) || {}
  return { trader_key: String(row.handle || row.source_trader_id || row.trader_key || ''), display_name: row.handle ? String(row.handle) : (row.display_name ? String(row.display_name) : null), avatar_url: (row.avatar_url as string | null) ?? null, platform: String(row.source || row.platform || exchange || ''), roi: (row.roi ?? m.roi) != null ? Number(row.roi ?? m.roi) : null, pnl: (row.pnl ?? m.pnl) != null ? Number(row.pnl ?? m.pnl) : null, win_rate: (row.win_rate ?? m.win_rate) != null ? Number(row.win_rate ?? m.win_rate) : null, max_drawdown: (row.max_drawdown ?? m.max_drawdown) != null ? Number(row.max_drawdown ?? m.max_drawdown) : null, arena_score: (row.arena_score ?? m.arena_score) != null ? Number(row.arena_score ?? m.arena_score) : null, followers: (row.followers ?? m.followers) != null ? Number(row.followers ?? m.followers) : null, sharpe_ratio: (row.sharpe_ratio ?? m.sharpe_ratio) != null ? Number(row.sharpe_ratio ?? m.sharpe_ratio) : null, trades_count: (row.trades_count ?? m.trades_count) != null ? Number(row.trades_count ?? m.trades_count) : null, trader_type: (row.trader_type as string) || null, is_bot: row.source === 'web3_bot' || row.platform === 'web3_bot' || row.trader_type === 'bot', captured_at: (row.computed_at as string) || (row.updated_at as string) || null, _source_id: String(row.source_trader_id || row.trader_key || '') }
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

// RankBadge styles — module-level to avoid allocation per row
const RANK_BADGE_DEFAULT: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary, minWidth: 28, textAlign: 'center', display: 'inline-block' }
const RANK_BADGE_1: React.CSSProperties = { width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, background: 'linear-gradient(135deg, #FFD700, #FFA500)', color: 'var(--color-bg-primary)' }
const RANK_BADGE_2: React.CSSProperties = { width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, background: 'linear-gradient(135deg, #C0C0C0, #A0A0A0)', color: 'var(--color-on-accent)' }
const RANK_BADGE_3: React.CSSProperties = { width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, background: 'linear-gradient(135deg, #CD7F32, #A0522D)', color: 'var(--color-on-accent)' }

const RankBadge = React.memo(function RankBadge({ rank }: { rank: number }) {
  if (rank > 3) return <span style={RANK_BADGE_DEFAULT}>{rank}</span>
  const style = rank === 1 ? RANK_BADGE_1 : rank === 2 ? RANK_BADGE_2 : RANK_BADGE_3
  return <span style={style}>{rank}</span>
})

// TraderCardItem wrapper styles — per-rank constants
const CARD_LINK_STYLE: React.CSSProperties = { textDecoration: 'none', display: 'block' }
const CARD_BASE = { padding: tokens.spacing[4], borderRadius: tokens.radius.lg, display: 'flex' as const, flexDirection: 'column' as const, gap: tokens.spacing[3], transition: `transform ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}` }
const CARD_WRAPPER_1: React.CSSProperties = { ...CARD_BASE, background: 'linear-gradient(145deg, rgba(255,215,0,0.12) 0%, var(--overlay-hover) 60%)', border: '1px solid rgba(255,215,0,0.25)', boxShadow: `${tokens.shadow.sm}, 0 0 12px rgba(255,215,0,0.15)` }
const CARD_WRAPPER_2: React.CSSProperties = { ...CARD_BASE, background: 'linear-gradient(145deg, rgba(192,192,192,0.10) 0%, var(--overlay-hover) 60%)', border: '1px solid rgba(192,192,192,0.20)', boxShadow: `${tokens.shadow.sm}, 0 0 12px rgba(192,192,192,0.12)` }
const CARD_WRAPPER_3: React.CSSProperties = { ...CARD_BASE, background: 'linear-gradient(145deg, rgba(205,127,50,0.10) 0%, var(--overlay-hover) 60%)', border: '1px solid rgba(205,127,50,0.20)', boxShadow: `${tokens.shadow.sm}, 0 0 12px rgba(205,127,50,0.12)` }
const CARD_WRAPPER_DEFAULT: React.CSSProperties = { ...CARD_BASE, background: 'var(--overlay-hover)', border: '1px solid var(--glass-border-light)', boxShadow: tokens.shadow.sm }
const CARD_HEADER_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }
const CARD_AVATAR_WRAPPER: React.CSSProperties = { width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }
const CARD_NAME_STYLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const CARD_PLATFORM_ROW: React.CSSProperties = { fontSize: 11, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 4 }
const CARD_STATS_GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: tokens.spacing[2] }

function getCardWrapperStyle(rank: number): React.CSSProperties {
  if (rank === 1) return CARD_WRAPPER_1
  if (rank === 2) return CARD_WRAPPER_2
  if (rank === 3) return CARD_WRAPPER_3
  return CARD_WRAPPER_DEFAULT
}

const TraderCardItem = React.memo(function TraderCardItem({ trader, rank }: { trader: TraderData; rank: number }) {
  const { t } = useLanguage()
  const name = getDisplayName(trader)
  const roiColor = trader.roi != null && trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  return (
    <Link href={`/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`} prefetch={false} style={CARD_LINK_STYLE}>
      <div style={getCardWrapperStyle(rank)}>
        <div style={CARD_HEADER_ROW}>
          <RankBadge rank={rank} />
          <div style={{ ...CARD_AVATAR_WRAPPER, background: getAvatarGradient(trader.trader_key) }}><TraderAvatarImg avatarUrl={trader.avatar_url} traderKey={trader.trader_key} name={name} size={40} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={CARD_NAME_STYLE}>{name}</div>
            <div style={CARD_PLATFORM_ROW}>{EXCHANGE_NAMES[trader.platform] || trader.platform}{(trader.platform === 'web3_bot' || trader.trader_type === 'bot' || trader.is_bot) && <span style={CELL_BOT_BADGE}>Bot</span>}</div>
          </div>
          <div style={{ textAlign: 'right' }}><div style={{ fontSize: 18, fontWeight: 800, color: roiColor }}>{formatROI(trader.roi)}</div><Sparkline roi={trader.roi ?? undefined} width={60} height={16} /></div>
        </div>
        <div style={CARD_STATS_GRID}>
          <StatBlock label="PnL" value={trader.pnl != null ? `$${trader.pnl >= 1000 ? `${(trader.pnl / 1000).toFixed(1)}K` : trader.pnl.toFixed(0)}` : NULL_DISPLAY} color={trader.pnl != null ? (trader.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : undefined} />
          <StatBlock label={t('rankingWinRate')} value={trader.win_rate != null ? `${trader.win_rate.toFixed(1)}%` : NULL_DISPLAY} color={trader.win_rate != null ? (trader.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.text.tertiary) : undefined} />
          <StatBlock label={t('rankingMdd')} value={trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(1)}%` : NULL_DISPLAY} color={trader.max_drawdown != null ? tokens.colors.accent.error + 'cc' : undefined} />
          <StatBlock label={t('rankingArenaScore')} value={trader.arena_score != null ? trader.arena_score.toFixed(0) : NULL_DISPLAY} color={trader.arena_score != null ? getScoreColor(trader.arena_score) : undefined} />
        </div>
      </div>
    </Link>
  )
})

// StatBlock styles — module-level constants
const STAT_BLOCK_OUTER: React.CSSProperties = { textAlign: 'center', padding: '6px 0', borderRadius: tokens.radius.md, background: 'var(--overlay-hover)' }
const STAT_BLOCK_LABEL: React.CSSProperties = { fontSize: 10, color: tokens.colors.text.tertiary, marginBottom: 2 }

const StatBlock = React.memo(function StatBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (<div style={STAT_BLOCK_OUTER}><div style={STAT_BLOCK_LABEL}>{label}</div><div style={{ fontSize: 13, fontWeight: 700, color: color || tokens.colors.text.primary }}>{value}</div></div>)
})

const SortArrow = React.memo(function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  return (<span style={{ display: 'inline-flex', flexDirection: 'column', marginLeft: 4, opacity: active ? 1 : 0.3, transition: 'opacity 0.15s' }}><svg width="8" height="5" viewBox="0 0 8 5" style={{ marginBottom: 1 }}><path d="M4 0L8 5H0z" fill={active && dir === 'asc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary} /></svg><svg width="8" height="5" viewBox="0 0 8 5"><path d="M4 5L0 0h8z" fill={active && dir === 'desc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary} /></svg></span>)
})

const SortHeader = React.memo(function SortHeader({ label, sortKey: sk, currentKey, currentDir, onSort, align = 'right', tooltip }: { label: string; sortKey: SortKey; currentKey: SortKey; currentDir: SortDir; onSort: (key: SortKey) => void; align?: 'left' | 'right' | 'center'; tooltip?: string }) {
  const active = currentKey === sk
  const ariaSort: 'ascending' | 'descending' | 'none' = active ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'
  return (<div role="columnheader" aria-sort={ariaSort}><button onClick={() => onSort(sk)} aria-label={`Sort by ${label}`} style={{ textAlign: align, cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start', color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary, transition: 'color 0.15s', background: 'none', border: 'none', padding: 0, font: 'inherit', gap: 2 }}>{label}{tooltip && <span title={tooltip} style={{ cursor: 'help', opacity: 0.6, fontSize: 11, flexShrink: 0 }} aria-label={tooltip}>&#9432;</span>}<SortArrow active={active} dir={currentDir} /></button></div>)
})

function ColumnToggle({ columns, onToggle, label }: { columns: Record<OptionalColumn, boolean>; onToggle: (col: OptionalColumn) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()
  useEffect(() => { if (!open) return; const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }; document.addEventListener('mousedown', handler); return () => document.removeEventListener('mousedown', handler) }, [open])
  const columnLabels: Record<OptionalColumn, string> = { pnl: t('rankingPnl'), followers: t('rankingFollowers'), sharpe_ratio: t('rankingSharpeRatio'), trades_count: t('rankingTradesCount') }
  return (<div ref={ref} style={{ position: 'relative' }}><button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu" style={{ padding: '6px 12px', minHeight: 36, borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', fontSize: 12, fontWeight: 600, background: 'var(--overlay-hover)', color: tokens.colors.text.secondary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3h7a2 2 0 012 2v14a2 2 0 01-2 2h-7m0-18H5a2 2 0 00-2 2v14a2 2 0 002 2h7m0-18v18" /></svg>{label}</button>{open && (<div className="dropdown-enter" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--color-bg-primary)', border: '1px solid var(--glass-border-light)', borderRadius: tokens.radius.md, padding: '8px 0', zIndex: 100, minWidth: 160, boxShadow: tokens.shadow.lg }}>{(Object.keys(columnLabels) as OptionalColumn[]).map((col) => (<label key={col} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13, color: tokens.colors.text.primary }}><input type="checkbox" checked={columns[col]} onChange={() => onToggle(col)} style={{ accentColor: tokens.colors.accent.brand }} />{columnLabels[col]}</label>))}</div>)}</div>)
}

function PeriodSelector({ period, onChange, loading }: { period: Period; onChange: (p: Period) => void; loading: boolean }) {
  const { t } = useLanguage()
  const periods: Period[] = ['7D', '30D', '90D']
  const labels: Record<Period, string> = { '7D': t('days7'), '30D': t('days30'), '90D': t('days90') }
  return (<div role="group" aria-label="Select time period" style={{ display: 'inline-flex', gap: 0, padding: 2, background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: '1px solid var(--glass-border-light)' }}>{periods.map((p) => (<button key={p} onClick={() => onChange(p)} disabled={loading} aria-label={`Show ${labels[p]} rankings`} aria-pressed={period === p} style={{ padding: '6px 14px', minHeight: 36, borderRadius: tokens.radius.md, border: 'none', fontSize: 13, fontWeight: period === p ? 700 : 500, background: period === p ? tokens.colors.accent.brand + '20' : 'transparent', color: period === p ? tokens.colors.accent.brand : tokens.colors.text.tertiary, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1, transition: 'all 0.15s' }}>{labels[p]}</button>))}</div>)
}

export default function ExchangeRankingClient({ traders: initialTraders, exchange, totalCount: _totalCount }: { traders: TraderData[]; exchange?: string; totalCount?: number }) {
  const { language, t } = useLanguage()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlPeriod = (searchParams.get('period')?.toUpperCase() || '90D') as Period
  const validPeriod = (['7D', '30D', '90D'] as const).includes(urlPeriod as Period) ? urlPeriod : '90D'
  const [period, setPeriod] = useState<Period>(validPeriod)
  const [periodLoading, setPeriodLoading] = useState(false)
  const { isPro } = useProStatus()
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterState>(() => parseFilterParams(searchParams))
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(() => hasActiveAdvancedFilters(parseFilterParams(searchParams)))
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
  const handleAdvancedFilterChange = useCallback((f: AdvancedFilterState) => {
    setAdvancedFilters(f)
    const params = new URLSearchParams(searchParams.toString())
    serializeFilterParams(f, params)
    const qs = params.toString()
    router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false })
  }, [pathname, router, searchParams])
  const handlePeriodChange = useCallback((newPeriod: Period) => { setPeriod(newPeriod); const params = new URLSearchParams(searchParams.toString()); if (newPeriod === '90D') { params.delete('period') } else { params.set('period', newPeriod) }; const qs = params.toString(); router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false }) }, [pathname, router, searchParams])
  useEffect(() => { if (!exchange) return; let cancelled = false; setPeriodLoading(true); const win = PERIOD_TO_WINDOW[period]; fetch('/api/rankings?window=' + win + '&platform=' + encodeURIComponent(exchange) + '&limit=5000').then(r => r.ok ? r.json() : null).then(json => { const rows = Array.isArray(json?.data) ? json.data : json?.data?.traders; if (cancelled || !rows?.length) { setPeriodLoading(false); return }; setTraders(rows.map((row: Record<string, unknown>) => mapApiRow(row, exchange))); setPeriodLoading(false) }).catch(() => setPeriodLoading(false)); return () => { cancelled = true } }, [exchange, period])
  const handleRealtimeUpdate = useCallback((updates: Array<{ id: string; source: string; roi: number; pnl: number | null; win_rate: number | null; max_drawdown: number | null; arena_score: number | null; [key: string]: unknown }>) => { setTraders(prev => { const updateMap = new Map(updates.map(u => [u.id, u])); let changed = false; const next = prev.map(tr => { const u = updateMap.get(tr._source_id || '') || updateMap.get(tr.trader_key); if (!u) return tr; changed = true; return { ...tr, roi: u.roi, pnl: u.pnl ?? tr.pnl, win_rate: u.win_rate, max_drawdown: u.max_drawdown, arena_score: u.arena_score } }); return changed ? next : prev }) }, [])
  useRealtimeRankings({ onUpdate: handleRealtimeUpdate })
  const filteredTraders = useMemo(() => {
    let result = traders
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.toLowerCase().trim()
      result = result.filter(tr => getDisplayName(tr).toLowerCase().includes(q) || tr.trader_key.toLowerCase().includes(q))
    }
    if (isPro && hasActiveAdvancedFilters(advancedFilters)) {
      result = applyAdvancedFilters(result, advancedFilters)
    }
    return result
  }, [traders, debouncedSearch, advancedFilters, isPro])
  const { lastUpdatedText, isStale } = useMemo(() => { let latestTs: string | null = null; for (const tr of traders) { if (tr.captured_at && (!latestTs || tr.captured_at > latestTs)) latestTs = tr.captured_at }; if (!latestTs) return { lastUpdatedText: null, isStale: false }; const diffHours = (Date.now() - new Date(latestTs).getTime()) / (1000 * 60 * 60); const locale: Locale = language === 'zh' ? 'zh' : language === 'ja' ? 'ja' : language === 'ko' ? 'ko' : 'en'; return { lastUpdatedText: formatTimeAgo(latestTs, locale), isStale: diffHours > 6 } }, [traders, language])
  const rankMap = useMemo(() => { const m = new Map<TraderData, number>(); filteredTraders.forEach((tr, i) => m.set(tr, i + 1)); return m }, [filteredTraders])
  const handleSort = (key: SortKey) => { if (sortKey === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc') } else { setSortKey(key); setSortDir(key === 'rank' ? 'asc' : 'desc') } }
  const sortedTraders = useMemo(() => { if (sortKey === 'rank') return sortDir === 'asc' ? filteredTraders : [...filteredTraders].reverse(); return [...filteredTraders].sort((a, b) => { const av = a[sortKey as keyof TraderData] as number | null; const bv = b[sortKey as keyof TraderData] as number | null; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; return sortDir === 'desc' ? bv - av : av - bv }) }, [filteredTraders, sortKey, sortDir])
  const cardSortedTraders = useMemo(() => { if (cardSortKey === 'rank') return cardSortDir === 'asc' ? filteredTraders : [...filteredTraders].reverse(); return [...filteredTraders].sort((a, b) => { const av = a[cardSortKey]; const bv = b[cardSortKey]; if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1; return cardSortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number) }) }, [filteredTraders, cardSortKey, cardSortDir])
  const activeTraders = viewMode === 'card' ? cardSortedTraders : sortedTraders
  useEffect(() => { const mq = window.matchMedia('(max-width: 768px)'); setViewMode(mq.matches ? 'card' : 'table'); const handler = (e: MediaQueryListEvent) => setViewMode(e.matches ? 'card' : 'table'); mq.addEventListener('change', handler); return () => mq.removeEventListener('change', handler) }, [])
  const handleRefresh = useCallback(async () => { try { const win = PERIOD_TO_WINDOW[period]; const res = await fetch('/api/rankings?window=' + win + '&platform=' + encodeURIComponent(exchange || '') + '&limit=5000'); if (res.ok) { const json = await res.json(); const rows = Array.isArray(json.data) ? json.data : json.data?.traders; if (rows?.length > 0) { setTraders(rows.map((row: Record<string, unknown>) => mapApiRow(row, exchange))); return } } } catch { /* fallback */ } router.refresh() }, [exchange, router, period])
  const handleColumnToggle = useCallback((col: OptionalColumn) => { setOptionalColumns(prev => ({ ...prev, [col]: !prev[col] })) }, [])
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualize = viewMode === 'table' && activeTraders.length > 50
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is inherently incompatible with React Compiler
  const rowVirtualizer = useVirtualizer({ count: shouldVirtualize ? activeTraders.length : 0, getScrollElement: () => tableScrollRef.current, estimateSize: () => 48, overscan: 10 })
  const cardScrollRef = useRef<HTMLDivElement>(null)
  const shouldVirtualizeCards = viewMode === 'card' && activeTraders.length > 50
  const cardVirtualizer = useVirtualizer({ count: shouldVirtualizeCards ? activeTraders.length : 0, getScrollElement: () => cardScrollRef.current, estimateSize: () => 160, overscan: 8 })
  const gridCols = useMemo(() => { const cols = ['40px', 'minmax(140px, 0.35fr)', '90px', '80px', '80px', '80px']; if (optionalColumns.pnl) cols.push('90px'); if (optionalColumns.followers) cols.push('80px'); if (optionalColumns.sharpe_ratio) cols.push('70px'); if (optionalColumns.trades_count) cols.push('70px'); cols.push('90px'); return cols.join(' ') }, [optionalColumns])
  const gridColsMobile = useMemo(() => { const cols = ['36px', 'minmax(100px, 1fr)', '72px', '64px', '64px', '64px']; if (optionalColumns.pnl) cols.push('72px'); if (optionalColumns.followers) cols.push('64px'); if (optionalColumns.sharpe_ratio) cols.push('56px'); if (optionalColumns.trades_count) cols.push('56px'); cols.push('72px'); return cols.join(' ') }, [optionalColumns])
  const renderRowCells = useCallback((td: TraderData, originalRank: number) => { const name = getDisplayName(td); const roiColor = td.roi != null && td.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error; const wrColor = td.win_rate != null ? (td.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary; return (<><div role="cell"><RankBadge rank={originalRank} /></div><div role="cell" style={CELL_FLEX_CENTER}><div style={{ ...CELL_AVATAR_WRAPPER, background: getAvatarGradient(td.trader_key) }}><TraderAvatarImg avatarUrl={td.avatar_url} traderKey={td.trader_key} name={name} size={32} /></div><span style={CELL_NAME}>{name}</span>{(td.platform === 'web3_bot' || td.trader_type === 'bot' || td.is_bot) && <span style={CELL_BOT_BADGE}>Bot</span>}</div><div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: roiColor }}>{formatROI(td.roi)}</div><div role="cell" style={CELL_SPARKLINE}><Sparkline roi={td.roi ?? undefined} width={72} height={20} /></div><div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: wrColor }}>{td.win_rate != null ? `${td.win_rate.toFixed(2)}%` : NULL_DISPLAY}</div><div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: td.max_drawdown != null ? tokens.colors.accent.error + 'cc' : tokens.colors.text.tertiary }}>{td.max_drawdown != null ? `-${Math.abs(td.max_drawdown).toFixed(2)}%` : NULL_DISPLAY}</div>{optionalColumns.pnl && <div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: td.pnl != null ? (td.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary }}>{formatPnL(td.pnl)}</div>}{optionalColumns.followers && <div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>{td.followers != null ? formatNumber(td.followers) : NULL_DISPLAY}</div>}{optionalColumns.sharpe_ratio && <div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: td.sharpe_ratio != null ? (td.sharpe_ratio >= 1 ? tokens.colors.accent.success : td.sharpe_ratio >= 0 ? tokens.colors.text.primary : tokens.colors.accent.error) : tokens.colors.text.tertiary }}>{td.sharpe_ratio != null ? td.sharpe_ratio.toFixed(2) : NULL_DISPLAY}</div>}{optionalColumns.trades_count && <div role="cell" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: tokens.colors.text.secondary }}>{td.trades_count != null ? formatNumber(td.trades_count) : NULL_DISPLAY}</div>}<div role="cell" style={CELL_SCORE_FLEX}>{td.arena_score != null ? <span style={{ width: 32, height: 32, borderRadius: '50%', border: `2px solid ${getScoreColor(td.arena_score)}`, background: `color-mix(in srgb, ${getScoreColor(td.arena_score)} 10%, transparent)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: getScoreColor(td.arena_score) }}>{td.arena_score.toFixed(0)}</span> : <span style={CELL_SCORE_NULL}>{NULL_DISPLAY}</span>}</div></>) }, [optionalColumns])
  const getRowHighlightStyle = useCallback((rank: number): React.CSSProperties => { if (rank === 1) return ROW_HIGHLIGHT_RANK_1; if (rank === 2) return ROW_HIGHLIGHT_RANK_2; if (rank === 3) return ROW_HIGHLIGHT_RANK_3; return ROW_HIGHLIGHT_DEFAULT }, [])
  if (traders.length === 0) return (<div style={{ textAlign: 'center', padding: tokens.spacing[8], color: tokens.colors.text.tertiary }}><div style={{ marginBottom: tokens.spacing[3] }}><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, color: tokens.colors.text.tertiary, margin: '0 auto' }}><path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 4-6" /></svg></div><div style={{ fontSize: tokens.typography.fontSize.base, fontWeight: 600, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2] }}>{t('rankingNoData')}</div><div style={{ fontSize: tokens.typography.fontSize.sm }}>{t('rankingNoDataDesc')}</div></div>)
  return (
    <PullToRefresh onRefresh={handleRefresh}><div>
      <div style={{ display: 'flex', gap: 8, marginBottom: tokens.spacing[4], justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><PeriodSelector period={period} onChange={handlePeriodChange} loading={periodLoading} /><button onClick={() => setViewMode('table')} aria-label="Switch to table view" aria-pressed={viewMode === 'table'} style={{ padding: '6px 16px', minHeight: 36, borderRadius: tokens.radius.md, border: 'none', fontSize: 13, fontWeight: viewMode === 'table' ? 700 : 500, background: viewMode === 'table' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)', color: viewMode === 'table' ? tokens.colors.accent.brand : tokens.colors.text.secondary, cursor: 'pointer' }}>{t('rankingTableView')}</button><button onClick={() => setViewMode('card')} aria-label="Switch to card view" aria-pressed={viewMode === 'card'} style={{ padding: '6px 16px', minHeight: 36, borderRadius: tokens.radius.md, border: 'none', fontSize: 13, fontWeight: viewMode === 'card' ? 700 : 500, background: viewMode === 'card' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)', color: viewMode === 'card' ? tokens.colors.accent.brand : tokens.colors.text.secondary, cursor: 'pointer' }}>{t('rankingCardView')}</button></div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><ProExportButton traders={activeTraders} exchange={exchange} period={period} isPro={isPro} t={t} />{viewMode === 'table' && <ColumnToggle columns={optionalColumns} onToggle={handleColumnToggle} label={t('rankingColumns')} />}<ShareLeaderboardButton traders={traders} exchange={exchange} /></div></div>
      <AdvancedFiltersPanel filters={advancedFilters} onChange={handleAdvancedFilterChange} isPro={isPro} expanded={showAdvancedFilters} onToggle={() => setShowAdvancedFilters(v => !v)} onReset={() => handleAdvancedFilterChange(EMPTY_FILTERS)} t={t} />
      <div style={{ marginBottom: tokens.spacing[3], position: 'relative' }}><div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 12, pointerEvents: 'none' }}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg><input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder={t('rankingSearch')} aria-label="Search traders" style={{ width: '100%', padding: '8px 12px 8px 36px', borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', background: 'var(--overlay-hover)', color: tokens.colors.text.primary, fontSize: 13, outline: 'none' }} />{searchQuery && <button onClick={() => setSearchQuery('')} aria-label="Clear search" style={{ position: 'absolute', right: 8, padding: '4px 8px', borderRadius: tokens.radius.sm, border: 'none', background: 'var(--glass-border-light)', color: tokens.colors.text.secondary, fontSize: 11, cursor: 'pointer' }}>{t('rankingClearSearch')}</button>}</div>{debouncedSearch.trim() && <div aria-live="polite" style={{ fontSize: 12, color: tokens.colors.text.tertiary, marginTop: 4 }}>{t('rankingSearchResults').replace('{count}', String(filteredTraders.length))}</div>}</div>
      {lastUpdatedText && (<div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginBottom: tokens.spacing[3], padding: isStale ? '4px 10px' : undefined, borderRadius: isStale ? tokens.radius.md : undefined, background: isStale ? 'rgba(202, 138, 4, 0.08)' : undefined, border: isStale ? '1px solid rgba(202, 138, 4, 0.20)' : undefined, fontSize: 12, color: isStale ? '#ca8a04' : tokens.colors.text.tertiary }}>{isStale ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}<span suppressHydrationWarning>{isStale ? `${t('dataStaleWarning')} \u00b7 ` : ''}{t('lastUpdated')} {lastUpdatedText}</span></div>)}
      {periodLoading && <div style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}><div style={{ width: 24, height: 24, border: `2px solid ${tokens.colors.accent.brand}30`, borderTopColor: tokens.colors.accent.brand, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /><style>{'@keyframes spin { to { transform: rotate(360deg) } }'}</style></div>}
      {viewMode === 'card' ? (<div><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: tokens.spacing[3] }}><span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{t('sortBy')}:</span><select value={cardSortKey} onChange={e => setCardSortKey(e.target.value as CardSortKey)} aria-label="Sort traders by" style={{ padding: '4px 8px', borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', background: 'var(--overlay-hover)', color: tokens.colors.text.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}><option value="rank">{t('rankingRank')}</option><option value="roi">ROI</option><option value="pnl">PnL</option><option value="arena_score">{t('rankingScore')}</option><option value="win_rate">{t('rankingWinRate')}</option></select><button onClick={() => setCardSortDir(d => d === 'desc' ? 'asc' : 'desc')} aria-label={`Sort direction: ${cardSortDir === 'desc' ? 'descending' : 'ascending'}`} style={{ padding: '4px 8px', borderRadius: tokens.radius.md, border: '1px solid var(--glass-border-light)', background: 'var(--overlay-hover)', color: tokens.colors.text.primary, fontSize: 12, cursor: 'pointer' }} title={cardSortDir === 'desc' ? 'Descending' : 'Ascending'}>{cardSortDir === 'desc' ? '\u2193' : '\u2191'}</button></div>{shouldVirtualizeCards ? (<div ref={cardScrollRef} style={{ height: '80vh', overflow: 'auto' }}><div style={{ height: cardVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>{cardVirtualizer.getVirtualItems().map((virtualRow) => { const td = activeTraders[virtualRow.index]; const originalRank = rankMap.get(td) || 0; return <div key={`${td.platform}:${td.trader_key}:${virtualRow.index}`} data-index={virtualRow.index} ref={cardVirtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)`, padding: `0 0 ${tokens.spacing[3]} 0` }}><TraderCardItem trader={td} rank={originalRank} /></div> })}</div></div>) : (<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacing[3], paddingBottom: tokens.spacing[4] }}>{activeTraders.map((td, i) => { const originalRank = rankMap.get(td) || 0; return <TraderCardItem key={`${td.platform}:${td.trader_key}:${i}`} trader={td} rank={originalRank} /> })}</div>)}<div aria-live="polite" style={{ textAlign: 'center', padding: `${tokens.spacing[3]} 0`, fontSize: 12, color: tokens.colors.text.tertiary }}>{t('tradersOnExchange').replace('{count}', String(activeTraders.length))}</div></div>) : (<><style>{`.exchange-table-grid-dynamic { grid-template-columns: ${gridCols}; } @media (max-width: 900px) { .exchange-table-grid-dynamic { grid-template-columns: ${gridColsMobile}; } } .exchange-row:hover { background: var(--overlay-hover) !important; } .exchange-table-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }`}</style><div className="exchange-table-wrapper" ref={shouldVirtualize ? tableScrollRef : undefined} style={shouldVirtualize ? { height: '80vh', overflow: 'auto' } : undefined}><div role="table" aria-label="Trader rankings" style={{ borderRadius: tokens.radius.lg, overflow: 'visible', background: 'var(--overlay-hover)', border: '1px solid var(--glass-border-light)' }}><div role="row" className="exchange-table-grid-dynamic" style={{ display: 'grid', gap: 8, padding: '12px 16px', fontSize: 12, fontWeight: 600, color: tokens.colors.text.secondary, borderBottom: '1px solid var(--glass-border-light)', position: 'sticky', top: shouldVirtualize ? 0 : 56, zIndex: 10, background: 'var(--color-bg-primary)', borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0` }}><SortHeader label={t('rankingRank')} sortKey="rank" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="left" /><div role="columnheader">{t('rankingTrader')}</div><SortHeader label={`${t('rankingRoi')} (${period})`} sortKey="roi" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} /><div role="columnheader" style={{ textAlign: 'center' }}>{t('rankingTrend')}</div><SortHeader label={t('rankingWinRate')} sortKey="win_rate" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Percentage of profitable trading days." /><SortHeader label={t('rankingMdd')} sortKey="max_drawdown" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Largest peak-to-trough decline. Lower is better." />{optionalColumns.pnl && <SortHeader label={t('rankingPnl')} sortKey="pnl" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}{optionalColumns.followers && <SortHeader label={t('rankingFollowers')} sortKey="followers" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}{optionalColumns.sharpe_ratio && <SortHeader label={t('rankingSharpeRatio')} sortKey="sharpe_ratio" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Risk-adjusted return. >1 is good, >2 is excellent." />}{optionalColumns.trades_count && <SortHeader label={t('rankingTradesCount')} sortKey="trades_count" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />}<SortHeader label={t('rankingScore')} sortKey="arena_score" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Arena Score: 0-100 composite of ROI (60%) and PnL (40%)." /></div>{shouldVirtualize ? (<div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>{rowVirtualizer.getVirtualItems().map((virtualRow) => { const i = virtualRow.index; const td = activeTraders[i]; const originalRank = rankMap.get(td) || 0; return <Link key={`${td.platform}:${td.trader_key}:${i}`} href={`/trader/${encodeURIComponent(td.trader_key)}?platform=${td.platform}`} prefetch={false} className="exchange-table-grid-dynamic exchange-row" role="row" aria-label={`Rank ${originalRank}, ${getDisplayName(td)}`} tabIndex={0} onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); const next = e.currentTarget.nextElementSibling as HTMLElement | null; next?.focus() } else if (e.key === 'ArrowUp') { e.preventDefault(); const prev = e.currentTarget.previousElementSibling as HTMLElement | null; prev?.focus() } }} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)`, display: 'grid', gap: 8, padding: '10px 16px', alignItems: 'center', textDecoration: 'none', borderBottom: originalRank <= 3 ? undefined : '1px solid var(--overlay-hover)', transition: 'background 0.15s', ...getRowHighlightStyle(originalRank) }}>{renderRowCells(td, originalRank)}</Link> })}</div>) : (activeTraders.map((td, i) => { const originalRank = rankMap.get(td) || 0; return <Link key={`${td.platform}:${td.trader_key}:${i}`} href={`/trader/${encodeURIComponent(td.trader_key)}?platform=${td.platform}`} prefetch={false} className="exchange-table-grid-dynamic exchange-row" role="row" aria-label={`Rank ${originalRank}, ${getDisplayName(td)}`} tabIndex={0} onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); const next = e.currentTarget.nextElementSibling as HTMLElement | null; next?.focus() } else if (e.key === 'ArrowUp') { e.preventDefault(); const prev = e.currentTarget.previousElementSibling as HTMLElement | null; prev?.focus() } }} style={{ display: 'grid', gap: 8, padding: '10px 16px', alignItems: 'center', textDecoration: 'none', borderBottom: originalRank <= 3 ? undefined : '1px solid var(--overlay-hover)', transition: 'background 0.15s', ...getRowHighlightStyle(originalRank) }}>{renderRowCells(td, originalRank)}</Link> }))}</div></div></>)}
    </div></PullToRefresh>
  )
}
