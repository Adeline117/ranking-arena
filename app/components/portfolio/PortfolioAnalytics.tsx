'use client'

import React, { useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface Position {
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  mark_price: number
  size: number
  pnl: number
  pnl_pct: number
  leverage: number
  user_portfolios?: { exchange: string; label: string }
}

interface SnapshotData {
  total_equity: number
  total_pnl: number
  total_pnl_pct: number
  snapshot_at: string
}

interface PortfolioAnalyticsProps {
  positions: Position[]
  snapshots: SnapshotData[]
}

export default function PortfolioAnalytics({ positions, snapshots }: PortfolioAnalyticsProps) {
  const { t } = useLanguage()

  const stats = useMemo(() => {
    if (positions.length === 0) return null

    const winning = positions.filter(p => p.pnl > 0)
    const losing = positions.filter(p => p.pnl < 0)
    const winRate = positions.length > 0 ? (winning.length / positions.length) * 100 : 0
    const bestPosition = positions.reduce((best, p) => p.pnl > best.pnl ? p : best, positions[0])
    const worstPosition = positions.reduce((worst, p) => p.pnl < worst.pnl ? p : worst, positions[0])
    const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0)
    const totalLongs = positions.filter(p => p.side === 'long').length
    const totalShorts = positions.filter(p => p.side === 'short').length
    const avgLeverage = positions.reduce((sum, p) => sum + (p.leverage || 1), 0) / positions.length

    // Group by exchange
    const byExchange = new Map<string, { count: number; pnl: number }>()
    for (const p of positions) {
      const ex = p.user_portfolios?.exchange || 'unknown'
      const prev = byExchange.get(ex) || { count: 0, pnl: 0 }
      byExchange.set(ex, { count: prev.count + 1, pnl: prev.pnl + p.pnl })
    }

    return {
      total: positions.length,
      winRate,
      winCount: winning.length,
      loseCount: losing.length,
      bestPosition,
      worstPosition,
      totalPnl,
      totalLongs,
      totalShorts,
      avgLeverage,
      byExchange: Array.from(byExchange.entries()).sort((a, b) => b[1].count - a[1].count),
    }
  }, [positions])

  if (!stats) {
    return null
  }

  const formatPnl = (v: number) => `${v >= 0 ? '+' : ''}$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const pnlColor = (v: number) => v >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats Cards Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
      }}>
        <StatCard label={t('winRate') || 'Win Rate'} value={`${stats.winRate.toFixed(1)}%`} color={stats.winRate >= 50 ? tokens.colors.accent.success : tokens.colors.accent.error} />
        <StatCard label={t('portfolioPositionCount') || 'Positions'} value={String(stats.total)} sublabel={`${stats.totalLongs}L / ${stats.totalShorts}S`} />
        <StatCard label={t('avgLeverage') || 'Avg Leverage'} value={`${stats.avgLeverage.toFixed(1)}x`} color={stats.avgLeverage > 10 ? tokens.colors.accent.error : tokens.colors.text.primary} />
        <StatCard label={t('bestPosition') || 'Best'} value={formatPnl(stats.bestPosition.pnl)} sublabel={stats.bestPosition.symbol} color={pnlColor(stats.bestPosition.pnl)} />
        <StatCard label={t('worstPosition') || 'Worst'} value={formatPnl(stats.worstPosition.pnl)} sublabel={stats.worstPosition.symbol} color={pnlColor(stats.worstPosition.pnl)} />
      </div>

      {/* Long/Short Distribution Bar */}
      <div style={{
        padding: 16,
        borderRadius: tokens.radius.lg,
        backgroundColor: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border-primary)',
      }}>
        <div style={{ fontSize: 13, color: tokens.colors.text.secondary, marginBottom: 10 }}>
          {t('positionDistribution') || 'Position Distribution'}
        </div>
        <div style={{ display: 'flex', height: 24, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
          {stats.totalLongs > 0 && (
            <div style={{
              flex: stats.totalLongs,
              background: tokens.colors.accent.success,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
            }}>
              Long {stats.totalLongs}
            </div>
          )}
          {stats.totalShorts > 0 && (
            <div style={{
              flex: stats.totalShorts,
              background: tokens.colors.accent.error,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
            }}>
              Short {stats.totalShorts}
            </div>
          )}
        </div>
      </div>

      {/* Exchange Breakdown */}
      {stats.byExchange.length > 1 && (
        <div style={{
          padding: 16,
          borderRadius: tokens.radius.lg,
          backgroundColor: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-primary)',
        }}>
          <div style={{ fontSize: 13, color: tokens.colors.text.secondary, marginBottom: 10 }}>
            {t('byExchange') || 'By Exchange'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stats.byExchange.map(([exchange, data]) => (
              <div key={exchange} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, textTransform: 'capitalize' }}>
                  {exchange}
                </span>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                    {data.count} {t('positions') || 'pos'}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: pnlColor(data.pnl) }}>
                    {formatPnl(data.pnl)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Equity Curve (enhanced) */}
      {snapshots.length > 1 && (
        <div style={{
          padding: 16,
          borderRadius: tokens.radius.lg,
          backgroundColor: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-primary)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: tokens.colors.text.secondary }}>
              {t('equityCurve') || 'Equity Curve'}
            </span>
            <span style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
              {snapshots.length} {t('dataPoints') || 'data points'}
            </span>
          </div>
          <EquityCurve snapshots={snapshots} />
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sublabel, color }: {
  label: string
  value: string
  sublabel?: string
  color?: string
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: 14,
      borderRadius: tokens.radius.lg,
      backgroundColor: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border-primary)',
    }}>
      <span style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: color || tokens.colors.text.primary }}>{value}</span>
      {sublabel && <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>{sublabel}</span>}
    </div>
  )
}

function EquityCurve({ snapshots }: { snapshots: SnapshotData[] }) {
  const values = snapshots.map(s => s.total_equity)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const isPositive = values[values.length - 1] >= values[0]
  const strokeColor = isPositive ? 'var(--color-success)' : 'var(--color-error)'
  const fillColor = isPositive ? 'var(--color-success)' : 'var(--color-error)'

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100
    const y = 100 - ((v - min) / range) * 90 - 5 // 5% padding top/bottom
    return `${x},${y}`
  })

  const linePoints = points.join(' ')
  // Area fill: line + close to bottom
  const areaPoints = `0,100 ${linePoints} 100,100`

  return (
    <div style={{ height: 160, width: '100%' }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={fillColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={fillColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#equityFill)" />
        <polyline
          points={linePoints}
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
