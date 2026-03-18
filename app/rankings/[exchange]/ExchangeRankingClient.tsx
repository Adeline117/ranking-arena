'use client'

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { formatROI } from '@/app/components/ranking/utils'
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
  trader_type?: string | null
  is_bot?: boolean
  captured_at?: string | null
  _source_id?: string
}

type ViewMode = 'table' | 'card'
type CardSortKey = 'rank' | 'roi' | 'pnl' | 'arena_score' | 'win_rate'
type SortKey = 'rank' | 'roi' | 'win_rate' | 'max_drawdown' | 'arena_score'
type SortDir = 'asc' | 'desc'

function getDisplayName(t: TraderData): string {
  if (t.display_name && !(t.display_name.length > 10 && /^\d+$/.test(t.display_name))) {
    return t.display_name
  }
  const shortKey = t.trader_key.length > 10
    ? `${t.trader_key.slice(0, 4)}...${t.trader_key.slice(-4)}`
    : t.trader_key
  return shortKey
}

function TraderAvatarImg({ avatarUrl, traderKey, name, size = 32 }: { avatarUrl: string | null; traderKey: string; name: string; size?: number }) {
  const [error, setError] = useState(false)
  
  // If no avatar or error loading: check if it's a wallet address → use blockie, else use initial
  if (!avatarUrl || error) {
    if (isWalletAddress(traderKey)) {
      // Generate Ethereum-style blockie for wallet addresses
      return (
        <img
          src={generateBlockieSvg(traderKey, size)}
          alt={name || 'Wallet avatar'}
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
        />
      )
    }
    // For non-wallet IDs, use single letter initial
    return <span style={{ color: tokens.colors.white, fontSize: size * 0.375, fontWeight: 700 }}>{getAvatarInitial(name)}</span>
  }
  
  // Use plain <img> to avoid next/image hostname validation crashes
  // Trader avatars come from many CDNs that can't all be whitelisted
  return (
    <img
      src={avatarSrc(avatarUrl)}
      alt={name || 'Trader avatar'}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      onError={() => setError(true)}
    />
  )
}

const RankBadge = React.memo(function RankBadge({ rank }: { rank: number }) {
  if (rank > 3) {
    return (
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: tokens.colors.text.secondary,
          minWidth: 28,
          textAlign: 'center',
          display: 'inline-block',
        }}
      >
        {rank}
      </span>
    )
  }
  const bg =
    rank === 1
      ? 'linear-gradient(135deg, #FFD700, #FFA500)'
      : rank === 2
      ? 'linear-gradient(135deg, #C0C0C0, #A0A0A0)'
      : 'linear-gradient(135deg, #CD7F32, #A0522D)'
  return (
    <span
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 700,
        background: bg,
        color: rank === 1 ? 'var(--color-bg-primary)' : 'var(--color-on-accent)',
      }}
    >
      {rank}
    </span>
  )
})

// Mobile card component
const TraderCardItem = React.memo(function TraderCardItem({ trader, rank }: { trader: TraderData; rank: number }) {
  const { t } = useLanguage()
  const name = getDisplayName(trader)
  const roiColor = trader.roi != null && trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <Link
      href={`/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <div
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          background: rank === 1
            ? 'linear-gradient(145deg, rgba(255,215,0,0.12) 0%, var(--overlay-hover) 60%)'
            : rank === 2
            ? 'linear-gradient(145deg, rgba(192,192,192,0.10) 0%, var(--overlay-hover) 60%)'
            : rank === 3
            ? 'linear-gradient(145deg, rgba(205,127,50,0.10) 0%, var(--overlay-hover) 60%)'
            : 'var(--overlay-hover)',
          border: rank === 1
            ? '1px solid rgba(255,215,0,0.25)'
            : rank === 2
            ? '1px solid rgba(192,192,192,0.20)'
            : rank === 3
            ? '1px solid rgba(205,127,50,0.20)'
            : '1px solid var(--glass-border-light)',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
          transition: `transform ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
          boxShadow: rank <= 3
            ? `${tokens.shadow.sm}, 0 0 12px ${rank === 1 ? 'rgba(255,215,0,0.15)' : rank === 2 ? 'rgba(192,192,192,0.12)' : 'rgba(205,127,50,0.12)'}`
            : tokens.shadow.sm,
        }}
      >
        {/* Top: rank + avatar + name + ROI */}
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <RankBadge rank={rank} />
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              background: getAvatarGradient(trader.trader_key),
            }}
          >
            <TraderAvatarImg avatarUrl={trader.avatar_url} traderKey={trader.trader_key} name={name} size={40} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </div>
            <div style={{ fontSize: 11, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 4 }}>
              {EXCHANGE_NAMES[trader.platform] || trader.platform}
              {(trader.platform === 'web3_bot' || trader.trader_type === 'bot' || trader.is_bot) && (
                <span style={{
                  padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                  color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)',
                }}>Bot</span>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: roiColor }}>
              {formatROI(trader.roi)}
            </div>
            <Sparkline roi={trader.roi ?? undefined} width={60} height={16} />
          </div>
        </div>

        {/* Bottom stats */}
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
  return (
    <div style={{ textAlign: 'center', padding: '6px 0', borderRadius: tokens.radius.md, background: 'var(--overlay-hover)' }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || tokens.colors.text.primary }}>{value}</div>
    </div>
  )
})

const SortArrow = React.memo(function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        marginLeft: 4,
        opacity: active ? 1 : 0.3,
        transition: 'opacity 0.15s',
      }}
    >
      <svg width="8" height="5" viewBox="0 0 8 5" style={{ marginBottom: 1 }}>
        <path
          d="M4 0L8 5H0z"
          fill={active && dir === 'asc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary}
        />
      </svg>
      <svg width="8" height="5" viewBox="0 0 8 5">
        <path
          d="M4 5L0 0h8z"
          fill={active && dir === 'desc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary}
        />
      </svg>
    </span>
  )
})

const SortHeader = React.memo(function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  align = 'right',
  tooltip,
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  currentDir: SortDir
  onSort: (key: SortKey) => void
  align?: 'left' | 'right' | 'center'
  tooltip?: string
}) {
  const active = currentKey === sortKey
  return (
    <button
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label}`}
      style={{
        textAlign: align,
        cursor: 'pointer',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
        color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary,
        transition: 'color 0.15s',
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        gap: 2,
      }}
    >
      {label}
      {tooltip && (
        <span title={tooltip} style={{ cursor: 'help', opacity: 0.6, fontSize: 11, flexShrink: 0 }} aria-label={tooltip}>&#9432;</span>
      )}
      <SortArrow active={active} dir={currentDir} />
    </button>
  )
})

export default function ExchangeRankingClient({
  traders: initialTraders,
  exchange,
}: {
  traders: TraderData[]
  exchange?: string
}) {
  const { language, t } = useLanguage()
  const [viewMode, setViewMode] = useState<ViewMode>(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? 'card' : 'table'
  )
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [cardSortKey, setCardSortKey] = useState<CardSortKey>('rank')
  const [cardSortDir, setCardSortDir] = useState<SortDir>('desc')
  // Live-updating traders state (starts from server props, updates via Realtime)
  const [traders, setTraders] = useState(initialTraders)
  useEffect(() => { setTraders(initialTraders) }, [initialTraders])

  const handleRealtimeUpdate = useCallback((updates: Array<{ id: string; source: string; roi: number; pnl: number | null; win_rate: number | null; max_drawdown: number | null; arena_score: number | null; [key: string]: unknown }>) => {
    setTraders(prev => {
      const updateMap = new Map(updates.map(u => [u.id, u]))
      let changed = false
      const next = prev.map(t => {
        // Match on _source_id (source_trader_id) first, fall back to trader_key (handle)
        const u = updateMap.get(t._source_id || '') || updateMap.get(t.trader_key)
        if (!u) return t
        changed = true
        return { ...t, roi: u.roi, pnl: u.pnl ?? t.pnl, win_rate: u.win_rate, max_drawdown: u.max_drawdown, arena_score: u.arena_score }
      })
      return changed ? next : prev
    })
  }, [])

  useRealtimeRankings({ onUpdate: handleRealtimeUpdate })

  // Compute data freshness from the most recent captured_at timestamp
  const { lastUpdatedText, isStale } = useMemo(() => {
    let latestTs: string | null = null
    for (const tr of traders) {
      if (tr.captured_at && (!latestTs || tr.captured_at > latestTs)) {
        latestTs = tr.captured_at
      }
    }
    if (!latestTs) return { lastUpdatedText: null, isStale: false }
    const diffHours = (Date.now() - new Date(latestTs).getTime()) / (1000 * 60 * 60)
    const locale: Locale = language === 'zh' ? 'zh' : language === 'ja' ? 'ja' : language === 'ko' ? 'ko' : 'en'
    return {
      lastUpdatedText: formatTimeAgo(latestTs, locale),
      isStale: diffHours > 6,
    }
  }, [traders, language])

  // Pre-compute rank map to avoid O(n*m) indexOf in render loop
  const rankMap = useMemo(() => {
    const m = new Map<TraderData, number>()
    traders.forEach((t, i) => m.set(t, i + 1))
    return m
  }, [traders])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'rank' ? 'asc' : 'desc')
    }
  }

  const sortedTraders = React.useMemo(() => {
    if (sortKey === 'rank') {
      return sortDir === 'asc' ? traders : [...traders].reverse()
    }
    return [...traders].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      // Nulls always sort to bottom regardless of direction
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
    })
  }, [traders, sortKey, sortDir])

  const cardSortedTraders = React.useMemo(() => {
    if (cardSortKey === 'rank') return cardSortDir === 'asc' ? traders : [...traders].reverse()
    return [...traders].sort((a, b) => {
      const av = a[cardSortKey]
      const bv = b[cardSortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return cardSortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
    })
  }, [traders, cardSortKey, cardSortDir])

  const activeTraders = viewMode === 'card' ? cardSortedTraders : sortedTraders

  // Auto-detect mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setViewMode(mq.matches ? 'card' : 'table')
    const handler = (e: MediaQueryListEvent) => setViewMode(e.matches ? 'card' : 'table')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Pull-to-refresh: refetch exchange data from server
  const router = useRouter()
  const handleRefresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/rankings/exchange?exchange=${encodeURIComponent(exchange || '')}`)
      if (res.ok) {
        const json = await res.json()
        if (Array.isArray(json.data) && json.data.length > 0) {
          setTraders(json.data)
          return
        }
      }
    } catch { /* fallback to router refresh */ }
    router.refresh()
  }, [exchange, router])

  // Virtualize table rows when count > 50 for smooth scrolling on large lists
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const ROW_HEIGHT = 48
  const shouldVirtualize = viewMode === 'table' && activeTraders.length > 50
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? activeTraders.length : 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  if (traders.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: tokens.spacing[8], color: tokens.colors.text.tertiary }}>
        <div style={{ marginBottom: tokens.spacing[3] }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, color: tokens.colors.text.tertiary, margin: '0 auto' }}>
            <path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 4-6" />
          </svg>
        </div>
        <div style={{ fontSize: tokens.typography.fontSize.base, fontWeight: 600, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2] }}>
          {t('rankingNoData')}
        </div>
        <div style={{ fontSize: tokens.typography.fontSize.sm }}>
          {t('rankingNoDataDesc')}
        </div>
      </div>
    )
  }

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <div>
      {/* View toggle + Share button */}
      <div style={{ display: 'flex', gap: 8, marginBottom: tokens.spacing[4], justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => setViewMode('table')}
          style={{
            padding: '6px 16px',
            minHeight: 44,
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: viewMode === 'table' ? 700 : 500,
            background: viewMode === 'table' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)',
            color: viewMode === 'table' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          {t('rankingTableView')}
        </button>
        <button
          onClick={() => setViewMode('card')}
          style={{
            padding: '6px 16px',
            minHeight: 44,
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: viewMode === 'card' ? 700 : 500,
            background: viewMode === 'card' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)',
            color: viewMode === 'card' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          {t('rankingCardView')}
        </button>
        </div>
        <ShareLeaderboardButton traders={traders} exchange={exchange} />
      </div>

      {/* Data freshness timestamp */}
      {lastUpdatedText && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 6,
            marginBottom: tokens.spacing[3],
            padding: isStale ? '4px 10px' : undefined,
            borderRadius: isStale ? tokens.radius.md : undefined,
            background: isStale ? 'rgba(202, 138, 4, 0.08)' : undefined,
            border: isStale ? '1px solid rgba(202, 138, 4, 0.20)' : undefined,
            fontSize: 12,
            color: isStale ? '#ca8a04' : tokens.colors.text.tertiary,
          }}
        >
          {isStale ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          )}
          <span suppressHydrationWarning>
            {isStale ? `${t('dataStaleWarning')} · ` : ''}
            {t('lastUpdated')} {lastUpdatedText}
          </span>
        </div>
      )}

      {viewMode === 'card' ? (
        <div>
          {/* Card sort dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: tokens.spacing[3] }}>
            <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{t('sortBy')}:</span>
            <select
              value={cardSortKey}
              onChange={e => setCardSortKey(e.target.value as CardSortKey)}
              style={{
                padding: '4px 8px',
                borderRadius: tokens.radius.md,
                border: '1px solid var(--glass-border-light)',
                background: 'var(--overlay-hover)',
                color: tokens.colors.text.primary,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <option value="rank">{t('rankingRank')}</option>
              <option value="roi">ROI</option>
              <option value="pnl">PnL</option>
              <option value="arena_score">{t('rankingScore')}</option>
              <option value="win_rate">{t('rankingWinRate')}</option>
            </select>
            <button
              onClick={() => setCardSortDir(d => d === 'desc' ? 'asc' : 'desc')}
              style={{
                padding: '4px 8px',
                borderRadius: tokens.radius.md,
                border: '1px solid var(--glass-border-light)',
                background: 'var(--overlay-hover)',
                color: tokens.colors.text.primary,
                fontSize: 12,
                cursor: 'pointer',
              }}
              title={cardSortDir === 'desc' ? 'Descending' : 'Ascending'}
            >
              {cardSortDir === 'desc' ? '↓' : '↑'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacing[3], paddingBottom: tokens.spacing[4] }}>
            {activeTraders.map((t, i) => {
              const originalRank = rankMap.get(t) || 0
              return (
                <TraderCardItem key={`${t.platform}:${t.trader_key}:${i}`} trader={t} rank={originalRank} />
              )
            })}
          </div>
          {/* Total count */}
          <div style={{ textAlign: 'center', padding: `${tokens.spacing[3]} 0`, fontSize: 12, color: tokens.colors.text.tertiary }}>
            {t('tradersOnExchange').replace('{count}', String(activeTraders.length))}
          </div>
        </div>
      ) : (
        <>
        <style>{`
          .exchange-table-grid {
            grid-template-columns: 40px minmax(180px, 0.35fr) 90px 80px 80px 80px 90px;
          }
          @media (max-width: 900px) {
            .exchange-table-grid {
              grid-template-columns: 36px minmax(120px, 1fr) 72px 64px 64px 64px 72px;
            }
          }
          .exchange-row:hover {
            background: var(--overlay-hover) !important;
          }
          .exchange-table-wrapper {
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
          }
        `}</style>
        <div className="exchange-table-wrapper" ref={shouldVirtualize ? tableScrollRef : undefined} style={shouldVirtualize ? { height: '80vh', overflow: 'auto' } : undefined}><div
          style={{
            borderRadius: tokens.radius.lg,
            overflow: 'visible',
            background: 'var(--overlay-hover)',
            border: '1px solid var(--glass-border-light)',
          }}
        >
          {/* Header */}
          <div
            className="exchange-table-grid"
            style={{
              display: 'grid',
              gap: 8,
              padding: '12px 16px',
              fontSize: 12,
              fontWeight: 600,
              color: tokens.colors.text.secondary,
              borderBottom: '1px solid var(--glass-border-light)',
              position: 'sticky',
              top: shouldVirtualize ? 0 : 56,
              zIndex: 10,
              background: 'var(--color-bg-primary)',
              borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
            }}
          >
            <SortHeader label={t('rankingRank')} sortKey="rank" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="left" />
            <div>{t('rankingTrader')}</div>
            <SortHeader label={`${t('rankingRoi')} (90D)`} sortKey="roi" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
            <div style={{ textAlign: 'center' }}>{t('rankingTrend')}</div>
            <SortHeader label={t('rankingWinRate')} sortKey="win_rate" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Percentage of profitable trading days." />
            <SortHeader label={t('rankingMdd')} sortKey="max_drawdown" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Largest peak-to-trough decline. Lower is better." />
            <SortHeader label={t('rankingScore')} sortKey="arena_score" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} tooltip="Arena Score is a 0-100 composite metric combining ROI (60%) and PnL (40%), adjusted for confidence and platform trust." />
          </div>
          {/* Rows — virtualized when > 50 items for smooth scrolling */}
          {shouldVirtualize ? (
            <div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const i = virtualRow.index
                const t = activeTraders[i]
                const name = getDisplayName(t)
                const roiColor = t.roi != null && t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
                const wrColor = t.win_rate != null
                  ? t.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error
                  : tokens.colors.text.tertiary
                const originalRank = rankMap.get(t) || 0
                return (
                  <Link
                    key={`${t.platform}:${t.trader_key}:${i}`}
                    href={`/trader/${encodeURIComponent(t.trader_key)}?platform=${t.platform}`}
                    className="exchange-table-grid exchange-row"
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                      display: 'grid',
                      gap: 8,
                      padding: '10px 16px',
                      alignItems: 'center',
                      textDecoration: 'none',
                      borderBottom: originalRank <= 3 ? undefined : '1px solid var(--overlay-hover)',
                      transition: 'background 0.15s',
                      ...(originalRank === 1
                        ? { background: 'linear-gradient(135deg, rgba(255,215,0,0.10) 0%, rgba(255,215,0,0.03) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #FFD700', borderRadius: 10, margin: '2px 4px' }
                        : originalRank === 2
                        ? { background: 'linear-gradient(135deg, rgba(192,192,192,0.08) 0%, rgba(192,192,192,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #C0C0C0', borderRadius: 10, margin: '2px 4px' }
                        : originalRank === 3
                        ? { background: 'linear-gradient(135deg, rgba(205,127,50,0.08) 0%, rgba(205,127,50,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #CD7F32', borderRadius: 10, margin: '2px 4px' }
                        : {}),
                    }}
                  >
                    <div><RankBadge rank={originalRank} /></div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: getAvatarGradient(t.trader_key) }}>
                        <TraderAvatarImg avatarUrl={t.avatar_url} traderKey={t.trader_key} name={name} size={32} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                      {(t.platform === 'web3_bot' || t.trader_type === 'bot' || t.is_bot) && (
                        <span style={{ padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600, flexShrink: 0, color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)' }}>Bot</span>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: roiColor }}>{formatROI(t.roi)}</div>
                    <div style={{ display: 'flex', justifyContent: 'center' }}><Sparkline roi={t.roi ?? undefined} width={72} height={20} /></div>
                    <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: wrColor }}>{t.win_rate != null ? `${t.win_rate.toFixed(2)}%` : NULL_DISPLAY}</div>
                    <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: t.max_drawdown != null ? tokens.colors.accent.error + 'cc' : tokens.colors.text.tertiary }}>{t.max_drawdown != null ? `-${Math.abs(t.max_drawdown).toFixed(2)}%` : NULL_DISPLAY}</div>
                    <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
                      {t.arena_score != null ? (
                        <span style={{ width: 32, height: 32, borderRadius: '50%', border: `2px solid ${getScoreColor(t.arena_score)}`, background: `color-mix(in srgb, ${getScoreColor(t.arena_score)} 10%, transparent)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: getScoreColor(t.arena_score) }}>{t.arena_score.toFixed(0)}</span>
                      ) : (
                        <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>{NULL_DISPLAY}</span>
                      )}
                    </div>
                  </Link>
                )
              })}
            </div>
          ) : (
          activeTraders.map((t, i) => {
            const name = getDisplayName(t)
            const roiColor = t.roi != null && t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
            const wrColor = t.win_rate != null
              ? t.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error
              : tokens.colors.text.tertiary
            // Determine original rank (index in unsorted array + 1)
            const originalRank = rankMap.get(t) || 0
            return (
              <Link
                key={`${t.platform}:${t.trader_key}:${i}`}
                href={`/trader/${encodeURIComponent(t.trader_key)}?platform=${t.platform}`}
                className="exchange-table-grid exchange-row"
                style={{
                  display: 'grid',
                  gap: 8,
                  padding: '10px 16px',
                  alignItems: 'center',
                  textDecoration: 'none',
                  borderBottom: originalRank <= 3 ? undefined : '1px solid var(--overlay-hover)',
                  transition: 'background 0.15s',
                  ...(originalRank === 1
                    ? { background: 'linear-gradient(135deg, rgba(255,215,0,0.10) 0%, rgba(255,215,0,0.03) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #FFD700', borderRadius: 10, margin: '2px 4px' }
                    : originalRank === 2
                    ? { background: 'linear-gradient(135deg, rgba(192,192,192,0.08) 0%, rgba(192,192,192,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #C0C0C0', borderRadius: 10, margin: '2px 4px' }
                    : originalRank === 3
                    ? { background: 'linear-gradient(135deg, rgba(205,127,50,0.08) 0%, rgba(205,127,50,0.02) 40%, transparent 80%)', boxShadow: 'inset 3px 0 0 #CD7F32', borderRadius: 10, margin: '2px 4px' }
                    : {}),
                }}
              >
                <div><RankBadge rank={originalRank} /></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      background: getAvatarGradient(t.trader_key),
                    }}
                  >
                    <TraderAvatarImg avatarUrl={t.avatar_url} traderKey={t.trader_key} name={name} size={32} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                  </span>
                  {(t.platform === 'web3_bot' || t.trader_type === 'bot' || t.is_bot) && (
                    <span style={{
                      padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600, flexShrink: 0,
                      color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)',
                    }}>Bot</span>
                  )}
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: roiColor }}>
                  {formatROI(t.roi)}
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Sparkline roi={t.roi ?? undefined} width={72} height={20} />
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: wrColor }}>
                  {t.win_rate != null ? `${t.win_rate.toFixed(2)}%` : NULL_DISPLAY}
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: t.max_drawdown != null ? tokens.colors.accent.error + 'cc' : tokens.colors.text.tertiary }}>
                  {t.max_drawdown != null ? `-${Math.abs(t.max_drawdown).toFixed(2)}%` : NULL_DISPLAY}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
                  {t.arena_score != null ? (
                    <span style={{
                      width: 32, height: 32, borderRadius: '50%',
                      border: `2px solid ${getScoreColor(t.arena_score)}`,
                      background: `color-mix(in srgb, ${getScoreColor(t.arena_score)} 10%, transparent)`,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 800, color: getScoreColor(t.arena_score),
                    }}>
                      {t.arena_score.toFixed(0)}
                    </span>
                  ) : (
                    <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>{NULL_DISPLAY}</span>
                  )}
                </div>
              </Link>
            )
          })
          )}
        </div>
        </div>
        </>
      )}


    </div>
    </PullToRefresh>
  )
}
