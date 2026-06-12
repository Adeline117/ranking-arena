'use client'

/**
 * Generic column-config record table for the heavy tabs (spec §2.4-3).
 * Keyset "load more" pagination — the column config is data, so every
 * record kind (positions / history / orders / transfers) shares this one
 * component and adding a source never adds table code.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatMoney } from '@/lib/utils/money'
import type { ServingCurrency } from '@/lib/data/serving/types'

export type RecordColumnFormat = 'money' | 'number' | 'pct' | 'datetime' | 'text'

export interface RecordColumn {
  key: string
  i18nKey: string
  format?: RecordColumnFormat
  align?: 'left' | 'right'
}

export interface RecordsTableProps {
  columns: RecordColumn[]
  rows: Record<string, unknown>[]
  /** Used for money cells when the row itself carries no currency. */
  currencyFallback?: ServingCurrency
  isLoading?: boolean
  hasNextPage?: boolean
  isFetchingNextPage?: boolean
  onLoadMore?: () => void
  /** i18n key for the empty state. */
  emptyKey?: string
}

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])

function formatCell(
  value: unknown,
  format: RecordColumnFormat | undefined,
  rowCurrency: ServingCurrency
): string {
  if (value === null || value === undefined || value === '') return '—'
  switch (format) {
    case 'money': {
      const n = Number(value)
      if (!Number.isFinite(n)) return String(value)
      return formatMoney({ value: n, currency: rowCurrency }, { compact: true, signed: true })
    }
    case 'pct': {
      const n = Number(value)
      return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : String(value)
    }
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n.toLocaleString() : String(value)
    }
    case 'datetime': {
      const d = new Date(String(value))
      return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
    }
    default:
      return String(value)
  }
}

function cellColor(value: unknown, format: RecordColumnFormat | undefined): string {
  if ((format === 'money' || format === 'pct') && typeof value === 'number') {
    if (value > 0) return 'var(--color-accent-success)'
    if (value < 0) return 'var(--color-accent-error)'
  }
  return tokens.colors.text.primary
}

export default function RecordsTable({
  columns,
  rows,
  currencyFallback = 'USDT',
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  emptyKey = 'recordsEmpty',
}: RecordsTableProps) {
  const { t } = useLanguage()

  if (!isLoading && rows.length === 0) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">
          {t(emptyKey)}
        </Text>
      </Box>
    )
  }

  return (
    <Box style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  textAlign: col.align ?? 'left',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderBottom: '1px solid ' + tokens.colors.border.primary,
                  color: tokens.colors.text.tertiary,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {t(col.i18nKey)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const rowCurrency =
              typeof row.currency === 'string' && CURRENCIES.has(row.currency)
                ? (row.currency as ServingCurrency)
                : currencyFallback
            return (
              <tr key={i}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={{
                      textAlign: col.align ?? 'left',
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderBottom: '1px solid ' + tokens.colors.border.primary,
                      color: cellColor(row[col.key], col.format),
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatCell(row[col.key], col.format, rowCurrency)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {hasNextPage && onLoadMore && (
        <Box style={{ textAlign: 'center', padding: tokens.spacing[3] }}>
          <button
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.md,
              border: '1px solid ' + tokens.colors.border.primary,
              background: tokens.colors.bg.tertiary,
              color: tokens.colors.text.primary,
              fontSize: 13,
              cursor: isFetchingNextPage ? 'wait' : 'pointer',
              opacity: isFetchingNextPage ? 0.6 : 1,
            }}
          >
            {isFetchingNextPage ? t('loading') : t('recordsLoadMore')}
          </button>
        </Box>
      )}
    </Box>
  )
}
