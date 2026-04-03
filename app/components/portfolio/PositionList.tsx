'use client'

import React, { useState, useMemo } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

interface Position {
  id: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  mark_price: number
  size: number
  pnl: number
  pnl_pct: number
  leverage: number
  updated_at: string
  user_portfolios?: { exchange: string; label: string }
}

type SortKey = 'symbol' | 'pnl' | 'pnl_pct' | 'size' | 'leverage'
type SortDir = 'asc' | 'desc'

interface PositionListProps {
  positions: Position[]
  isLoading?: boolean
}

export default function PositionList({ positions, isLoading }: PositionListProps) {
  const { t } = useLanguage()
  const [sortKey, setSortKey] = useState<SortKey>('pnl')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => {
    return [...positions].sort((a, b) => {
      const av = a[sortKey] ?? 0
      const bv = b[sortKey] ?? 0
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [positions, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return ''
    return sortDir === 'asc' ? ' ^' : ' v'
  }

  if (isLoading) {
    return (
      <div style={styles.container}>
        {[1, 2, 3].map(i => (
          <div key={i} style={styles.skeleton} />
        ))}
      </div>
    )
  }

  if (!positions.length) {
    return (
      <div style={styles.empty}>
        <span style={styles.emptyText}>{t('noOpenPositions') || 'No open positions'}</span>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Desktop table */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th} onClick={() => toggleSort('symbol')}>
                Symbol{sortIndicator('symbol')}
              </th>
              <th style={styles.th}>Side</th>
              <th style={styles.th}>Entry</th>
              <th style={styles.th}>Mark</th>
              <th style={styles.th} onClick={() => toggleSort('size')}>
                Size{sortIndicator('size')}
              </th>
              <th style={styles.th} onClick={() => toggleSort('leverage')}>
                Lev{sortIndicator('leverage')}
              </th>
              <th style={styles.th} onClick={() => toggleSort('pnl')}>
                PnL{sortIndicator('pnl')}
              </th>
              <th style={styles.th} onClick={() => toggleSort('pnl_pct')}>
                PnL %{sortIndicator('pnl_pct')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(pos => {
              const pnlColor = pos.pnl >= 0 ? 'var(--color-success)' : 'var(--color-error)'
              const sign = pos.pnl >= 0 ? '+' : ''
              return (
                <tr key={pos.id} style={styles.tr}>
                  <td style={styles.td}>
                    <span style={styles.symbol}>{pos.symbol}</span>
                    {pos.user_portfolios && (
                      <span style={styles.exchange}>{pos.user_portfolios.exchange}</span>
                    )}
                  </td>
                  <td style={{
                    ...styles.td,
                    color: pos.side === 'long' ? 'var(--color-success)' : 'var(--color-error)',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    fontSize: '12px',
                  }}>
                    {pos.side}
                  </td>
                  <td style={styles.td}>${Number(pos.entry_price).toLocaleString('en-US')}</td>
                  <td style={styles.td}>${Number(pos.mark_price).toLocaleString('en-US')}</td>
                  <td style={styles.td}>{Number(pos.size).toLocaleString('en-US')}</td>
                  <td style={styles.td}>{pos.leverage}x</td>
                  <td style={{ ...styles.td, color: pnlColor, fontWeight: 600 }}>
                    {sign}${Number(pos.pnl).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </td>
                  <td style={{ ...styles.td, color: pnlColor }}>
                    {sign}{Number(pos.pnl_pct).toFixed(2)}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div style={styles.mobileCards}>
        {sorted.map(pos => {
          const pnlColor = pos.pnl >= 0 ? 'var(--color-success)' : 'var(--color-error)'
          const sign = pos.pnl >= 0 ? '+' : ''
          return (
            <div key={pos.id} style={styles.mobileCard}>
              <div style={styles.mobileCardHeader}>
                <span style={styles.symbol}>{pos.symbol}</span>
                <span style={{
                  color: pos.side === 'long' ? 'var(--color-success)' : 'var(--color-error)',
                  fontWeight: 600,
                  fontSize: '12px',
                  textTransform: 'uppercase',
                }}>
                  {pos.side} {pos.leverage}x
                </span>
              </div>
              <div style={styles.mobileCardRow}>
                <span style={styles.mobileLabel}>Entry / Mark</span>
                <span style={styles.mobileValue}>
                  ${Number(pos.entry_price).toLocaleString('en-US')} / ${Number(pos.mark_price).toLocaleString('en-US')}
                </span>
              </div>
              <div style={styles.mobileCardRow}>
                <span style={styles.mobileLabel}>Size</span>
                <span style={styles.mobileValue}>{Number(pos.size).toLocaleString('en-US')}</span>
              </div>
              <div style={styles.mobileCardRow}>
                <span style={styles.mobileLabel}>PnL</span>
                <span style={{ ...styles.mobileValue, color: pnlColor, fontWeight: 600 }}>
                  {sign}${Number(pos.pnl).toLocaleString('en-US', { minimumFractionDigits: 2 })} ({sign}{Number(pos.pnl_pct).toFixed(2)}%)
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  tableWrap: {
    overflowX: 'auto',
    borderRadius: tokens.radius.lg,
    border: '1px solid var(--color-border-primary)',
    backgroundColor: 'var(--color-bg-secondary)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '14px',
  },
  th: {
    padding: '12px 16px',
    textAlign: 'left' as const,
    color: 'var(--color-text-secondary)',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    userSelect: 'none' as const,
    borderBottom: '1px solid var(--color-border-primary)',
    whiteSpace: 'nowrap' as const,
  },
  tr: {
    borderBottom: '1px solid var(--color-border-primary)',
  },
  td: {
    padding: '12px 16px',
    color: 'var(--color-text-primary)',
    whiteSpace: 'nowrap' as const,
  },
  symbol: {
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  },
  exchange: {
    fontSize: '11px',
    color: 'var(--color-text-tertiary)',
    marginLeft: '6px',
  },
  empty: {
    display: 'flex',
    justifyContent: 'center',
    padding: '48px 16px',
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: tokens.radius.lg,
    border: '1px solid var(--color-border-primary)',
  },
  emptyText: {
    color: 'var(--color-text-secondary)',
    fontSize: '14px',
  },
  skeleton: {
    height: '48px',
    borderRadius: tokens.radius.md,
    backgroundColor: 'var(--color-bg-tertiary)',
  },
  // Mobile cards - shown via CSS media query override
  mobileCards: {
    display: 'none',
    flexDirection: 'column',
    gap: '8px',
  },
  mobileCard: {
    padding: '12px 16px',
    borderRadius: tokens.radius.lg,
    backgroundColor: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  mobileCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  mobileCardRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  mobileLabel: {
    fontSize: '12px',
    color: 'var(--color-text-secondary)',
  },
  mobileValue: {
    fontSize: '13px',
    color: 'var(--color-text-primary)',
  },
}
