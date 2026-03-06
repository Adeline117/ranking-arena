'use client'

import React, { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatROI } from '@/app/components/ranking/utils'
import { Sparkline } from '@/app/components/ui/Sparkline'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

interface TraderData {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  platform: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  followers: number | null
}

type ViewMode = 'table' | 'card'
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

function TraderAvatarImg({ avatarUrl, traderKey: _traderKey, name, size = 32 }: { avatarUrl: string | null; traderKey: string; name: string; size?: number }) {
  const [error, setError] = useState(false)
  if (!avatarUrl || error) {
    return <span style={{ color: tokens.colors.white, fontSize: size * 0.375, fontWeight: 700 }}>{getAvatarInitial(name)}</span>
  }
  // Use plain <img> to avoid next/image hostname validation crashes
  // Trader avatars come from many CDNs that can't all be whitelisted
  return (
    <img
      src={`/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
      alt={name || 'Trader avatar'}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      onError={() => setError(true)}
    />
  )
}

function RankBadge({ rank }: { rank: number }) {
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
}

// Mobile card component
function TraderCardItem({ trader, rank }: { trader: TraderData; rank: number }) {
  const name = getDisplayName(trader)
  const roiColor = trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <Link
      href={`/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <div
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          background: 'var(--overlay-hover)',
          border: '1px solid var(--glass-border-light)',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
          transition: `transform ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
          boxShadow: tokens.shadow.sm,
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
            <div style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
              {EXCHANGE_NAMES[trader.platform] || trader.platform}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: roiColor }}>
              {formatROI(trader.roi)}
            </div>
            <Sparkline roi={trader.roi} width={60} height={16} />
          </div>
        </div>

        {/* Bottom stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[2] }}>
          <StatBlock label="Win%" value={trader.win_rate != null ? `${trader.win_rate.toFixed(1)}%` : 'N/A'} color={trader.win_rate != null ? (trader.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error) : undefined} />
          <StatBlock label="MDD" value={trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(1)}%` : 'N/A'} color={trader.max_drawdown != null ? tokens.colors.accent.error + 'cc' : undefined} />
          <StatBlock label="Arena Score" value={trader.arena_score != null ? trader.arena_score.toFixed(0) : '--'} color={trader.arena_score ? tokens.colors.accent.brand : undefined} />
        </div>
      </div>
    </Link>
  )
}

function StatBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '6px 0', borderRadius: tokens.radius.md, background: 'var(--overlay-hover)' }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || tokens.colors.text.primary }}>{value}</div>
    </div>
  )
}

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
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
}

function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  align = 'right',
}: {
  label: string
  sortKey: SortKey
  currentKey: SortKey
  currentDir: SortDir
  onSort: (key: SortKey) => void
  align?: 'left' | 'right' | 'center'
}) {
  const active = currentKey === sortKey
  return (
    <div
      onClick={() => onSort(sortKey)}
      style={{
        textAlign: align,
        cursor: 'pointer',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
        color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary,
        transition: 'color 0.15s',
      }}
    >
      {label}
      <SortArrow active={active} dir={currentDir} />
    </div>
  )
}

export default function ExchangeRankingClient({
  traders,
}: {
  traders: TraderData[]
  exchange?: string
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const PAGE_SIZE = 50
  const [page, setPage] = useState(1)

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
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number)
    })
  }, [traders, sortKey, sortDir])

  // Reset page when sort changes
  useEffect(() => { setPage(1) }, [sortKey, sortDir])

  const totalPages = Math.ceil(sortedTraders.length / PAGE_SIZE)
  const pagedTraders = sortedTraders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Auto-detect mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setViewMode(mq.matches ? 'card' : 'table')
    const handler = (e: MediaQueryListEvent) => setViewMode(e.matches ? 'card' : 'table')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  if (traders.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: tokens.spacing[8], color: tokens.colors.text.tertiary }}>
        <div style={{ marginBottom: tokens.spacing[3] }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, color: tokens.colors.text.tertiary, margin: '0 auto' }}>
            <path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 4-6" />
          </svg>
        </div>
        <div style={{ fontSize: tokens.typography.fontSize.base, fontWeight: 600, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2] }}>
          暂无排行数据
        </div>
        <div style={{ fontSize: tokens.typography.fontSize.sm }}>
          该平台的排行数据正在收集中，请稍后再来查看
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* View toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: tokens.spacing[4] }}>
        <button
          onClick={() => setViewMode('table')}
          style={{
            padding: '6px 16px',
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: viewMode === 'table' ? 700 : 500,
            background: viewMode === 'table' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)',
            color: viewMode === 'table' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          表格
        </button>
        <button
          onClick={() => setViewMode('card')}
          style={{
            padding: '6px 16px',
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: viewMode === 'card' ? 700 : 500,
            background: viewMode === 'card' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)',
            color: viewMode === 'card' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          卡片
        </button>
      </div>

      {viewMode === 'card' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: tokens.spacing[3] }}>
          {pagedTraders.map((t, i) => {
            const originalRank = rankMap.get(t) || 0
            return (
              <TraderCardItem key={`${t.platform}:${t.trader_key}:${i}`} trader={t} rank={originalRank} />
            )
          })}
        </div>
      ) : (
        <div
          style={{
            borderRadius: tokens.radius.lg,
            overflow: 'hidden',
            background: 'var(--overlay-hover)',
            border: '1px solid var(--glass-border-light)',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr 80px 80px 70px 70px 70px',
              gap: 8,
              padding: '12px 16px',
              fontSize: 12,
              fontWeight: 600,
              color: tokens.colors.text.secondary,
              borderBottom: '1px solid var(--glass-border-light)',
            }}
          >
            <SortHeader label="#" sortKey="rank" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} align="left" />
            <div>Trader</div>
            <SortHeader label="ROI" sortKey="roi" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
            <div style={{ textAlign: 'center' }}>Trend</div>
            <SortHeader label="Win%" sortKey="win_rate" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
            <SortHeader label="MDD" sortKey="max_drawdown" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
            <SortHeader label="Score" sortKey="arena_score" currentKey={sortKey} currentDir={sortDir} onSort={handleSort} />
          </div>
          {/* Rows */}
          {pagedTraders.map((t, i) => {
            const name = getDisplayName(t)
            const roiColor = t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
            const wrColor = t.win_rate != null
              ? t.win_rate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error
              : tokens.colors.text.tertiary
            // Determine original rank (index in unsorted array + 1)
            const originalRank = rankMap.get(t) || 0
            return (
              <Link
                key={`${t.platform}:${t.trader_key}:${i}`}
                href={`/trader/${encodeURIComponent(t.trader_key)}?platform=${t.platform}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 80px 80px 70px 70px 70px',
                  gap: 8,
                  padding: '10px 16px',
                  alignItems: 'center',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--overlay-hover)',
                  transition: 'background 0.15s',
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
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: roiColor }}>
                  {formatROI(t.roi)}
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Sparkline roi={t.roi} width={72} height={20} />
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: wrColor }}>
                  {t.win_rate != null ? `${t.win_rate.toFixed(1)}%` : 'N/A'}
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: t.max_drawdown != null ? tokens.colors.accent.error + 'cc' : tokens.colors.text.tertiary }}>
                  {t.max_drawdown != null ? `-${Math.abs(t.max_drawdown).toFixed(1)}%` : 'N/A'}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {t.arena_score != null ? (
                    <span style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.accent.brand }}>
                      {t.arena_score.toFixed(0)}
                    </span>
                  ) : (
                    <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>--</span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: tokens.spacing[6] }}>
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            style={{
              padding: '8px 16px',
              borderRadius: tokens.radius.md,
              border: 'none',
              fontSize: 13,
              fontWeight: 600,
              background: page <= 1 ? 'var(--glass-border-light)' : tokens.colors.accent.brand + '25',
              color: page <= 1 ? tokens.colors.text.tertiary : tokens.colors.accent.brand,
              cursor: page <= 1 ? 'not-allowed' : 'pointer',
              opacity: page <= 1 ? 0.5 : 1,
            }}
          >
            ← 上一页
          </button>
          <span style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
            {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            style={{
              padding: '8px 16px',
              borderRadius: tokens.radius.md,
              border: 'none',
              fontSize: 13,
              fontWeight: 600,
              background: page >= totalPages ? 'var(--glass-border-light)' : tokens.colors.accent.brand + '25',
              color: page >= totalPages ? tokens.colors.text.tertiary : tokens.colors.accent.brand,
              cursor: page >= totalPages ? 'not-allowed' : 'pointer',
              opacity: page >= totalPages ? 0.5 : 1,
            }}
          >
            下一页 →
          </button>
        </div>
      )}
    </div>
  )
}
