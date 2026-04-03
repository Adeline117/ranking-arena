'use client'

import { useState, useMemo, memo, CSSProperties } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface Column<T> {
  key: string
  label: string
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  width?: string
  render?: (row: T, index: number) => React.ReactNode
  getValue?: (row: T) => number | string | null
}

interface MarketTableProps<T> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  defaultSortKey?: string
  defaultSortDir?: 'asc' | 'desc'
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
}

function MarketTableInner<T>({
  columns,
  data,
  loading,
  defaultSortKey,
  defaultSortDir = 'desc',
  rowKey,
  onRowClick,
}: MarketTableProps<T>) {
  const { t } = useLanguage()
  const [sortKey, setSortKey] = useState(defaultSortKey || '')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir)

  const sorted = useMemo(() => {
    if (!sortKey) return data
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return data
    const getValue = col.getValue || ((row: T) => (row as Record<string, unknown>)[sortKey])
    return [...data].sort((a, b) => {
      const va = getValue(a)
      const vb = getValue(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [data, sortKey, sortDir, columns])

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const headerStyle: CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: tokens.colors.bg.secondary,
    borderBottom: `1px solid ${tokens.colors.border.primary}`,
  }

  const thStyle = (col: Column<T>): CSSProperties => ({
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    textAlign: col.align || 'right',
    fontSize: tokens.typography.fontSize.xs,
    fontWeight: tokens.typography.fontWeight.medium,
    color: tokens.colors.text.secondary,
    cursor: col.sortable ? 'pointer' : 'default',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    width: col.width,
  })

  if (loading) {
    return (
      <div style={{ padding: tokens.spacing[8], textAlign: 'center', color: tokens.colors.text.secondary }}>
        <div className="skeleton" style={{ height: 400, borderRadius: tokens.radius.md }} />
      </div>
    )
  }

  return (
    <div
      style={{
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
        overflow: 'hidden',
        maxWidth: '100%',
      }}
    >
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: tokens.typography.fontSize.sm,
          tableLayout: 'fixed',
        }}
      >
        <thead>
          <tr style={headerStyle}>
            {columns.map((col) => (
              <th
                key={col.key}
                style={thStyle(col)}
                onClick={() => col.sortable && handleSort(col.key)}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {col.label}
                  {col.sortable && (
                    <span style={{ opacity: sortKey === col.key ? 1 : 0.3, fontSize: 10 }}>
                      {sortKey === col.key ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : '\u25B2\u25BC'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                style={{ padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`, textAlign: 'center', color: tokens.colors.text.tertiary }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="3" y1="9" x2="21" y2="9" />
                    <line x1="9" y1="21" x2="9" y2="9" />
                  </svg>
                  <span style={{ fontSize: 13 }}>{t('noDataAvailable')}</span>
                </div>
              </td>
            </tr>
          ) : (
            sorted.map((row, i) => (
              <tr
                key={rowKey(row)}
                onClick={() => onRowClick?.(row)}
                style={{
                  background: i % 2 === 0 ? 'transparent' : tokens.colors.bg.tertiary,
                  cursor: onRowClick ? 'pointer' : 'default',
                  transition: tokens.transition.fast,
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background = tokens.colors.bg.hover
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLElement).style.background =
                    i % 2 === 0 ? 'transparent' : tokens.colors.bg.tertiary
                }}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      textAlign: col.align || 'right',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    {col.render ? col.render(row, i) : (row as Record<string, unknown>)[col.key] as React.ReactNode ?? '—'}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
    </div>
  )
}

const MarketTable = memo(MarketTableInner) as typeof MarketTableInner
export default MarketTable
