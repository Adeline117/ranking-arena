'use client'

import React from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

interface SnapshotData {
  total_equity: number
  total_pnl: number
  total_pnl_pct: number
  snapshot_at: string
}

interface PortfolioOverviewProps {
  totalEquity: number
  totalPnl: number
  totalPnlPct: number
  snapshots: SnapshotData[]
  isLoading?: boolean
}

export default function PortfolioOverview({
  totalEquity,
  totalPnl,
  totalPnlPct,
  snapshots,
  isLoading,
}: PortfolioOverviewProps) {
  const { t } = useLanguage()
  const pnlColor = totalPnl >= 0 ? 'var(--color-success)' : 'var(--color-error)'
  const pnlSign = totalPnl >= 0 ? '+' : ''

  if (isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.skeleton} />
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.grid}>
        <div style={styles.card}>
          <span style={styles.label}>{t('totalEquity') || 'Total Equity'}</span>
          <span style={styles.value}>${totalEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div style={styles.card}>
          <span style={styles.label}>{t('unrealizedPnl') || 'Unrealized PnL'}</span>
          <span style={{ ...styles.value, color: pnlColor }}>
            {pnlSign}${totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div style={styles.card}>
          <span style={styles.label}>PnL %</span>
          <span style={{ ...styles.value, color: pnlColor }}>
            {pnlSign}{totalPnlPct.toFixed(2)}%
          </span>
        </div>
      </div>

      {snapshots.length > 1 && (
        <div style={styles.chartContainer}>
          <span style={styles.label}>Equity History</span>
          <div style={styles.miniChart}>
            {(() => {
              const values = snapshots.map(s => s.total_equity)
              const min = Math.min(...values)
              const max = Math.max(...values)
              const range = max - min || 1
              const width = 100 / (values.length - 1)

              const points = values.map((v, i) => {
                const x = i * width
                const y = 100 - ((v - min) / range) * 100
                return `${x},${y}`
              }).join(' ')

              return (
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={styles.svg}>
                  <polyline
                    points={points}
                    fill="none"
                    stroke={totalPnl >= 0 ? 'var(--color-success)' : 'var(--color-error)'}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '12px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '16px',
    borderRadius: tokens.radius.lg,
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
  },
  label: {
    fontSize: '13px',
    color: 'var(--color-text-secondary)',
  },
  value: {
    fontSize: '20px',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  },
  chartContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '16px',
    borderRadius: tokens.radius.lg,
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
  },
  miniChart: {
    height: '120px',
    width: '100%',
  },
  svg: {
    width: '100%',
    height: '100%',
  },
  skeleton: {
    height: '200px',
    borderRadius: tokens.radius.lg,
    backgroundColor: 'var(--color-bg-tertiary)',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
}
