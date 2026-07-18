'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface RankingFooterProps {
  loading: boolean
  lastUpdated?: string | null
  formatLastUpdated: (dateStr: string | null | undefined) => string | null
  t: (key: string) => string
  onRefresh?: () => void
  lastRefreshFailed?: boolean
  /** Authoritative source-watermark freshness; do not infer it from score compute time. */
  isStale: boolean
}

export default function RankingFooter({
  loading,
  lastUpdated,
  formatLastUpdated,
  t,
  onRefresh,
  lastRefreshFailed,
  isStale,
}: RankingFooterProps) {
  const { language } = useLanguage()

  // Live relative timestamp: re-render every 10s so "12s ago" keeps ticking.
  // The absolute time stays available as the title attribute.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastUpdated) return
    const id = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [lastUpdated])

  return (
    <>
      {/* Stale data warning banner */}
      {!loading && isStale && (
        <Box
          style={{
            margin: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: '6px',
            backgroundColor: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            fontSize: tokens.typography.fontSize.xs,
            color: 'var(--color-accent-warning, #f59e0b)',
            textAlign: 'center',
          }}
        >
          {t('dataStaleWarning')}
        </Box>
      )}

      {/* Last updated timestamp — exchange sources shown in chip bar above */}
      {!loading && lastUpdated && (
        <Box
          suppressHydrationWarning
          style={{
            marginTop: tokens.spacing[2],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 4,
            fontSize: tokens.typography.fontSize.xs,
            color: isStale ? 'var(--color-accent-warning, #f59e0b)' : 'var(--color-text-tertiary)',
            paddingRight: tokens.spacing[3],
          }}
        >
          <svg
            width={11}
            height={11}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <span suppressHydrationWarning title={formatLastUpdated(lastUpdated) ?? undefined}>
            {formatTimeAgo(lastUpdated, language as Locale)}
          </span>
          {lastRefreshFailed && (
            <span
              title={t('refreshFailed')}
              style={{ color: 'var(--color-accent-warning, #f59e0b)', display: 'inline-flex' }}
            >
              <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
            </span>
          )}
          {onRefresh && (
            <button
              onClick={onRefresh}
              aria-label={t('refresh')}
              className="tap-target"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'inherit',
              }}
              title={t('refresh')}
            >
              <svg
                width={11}
                height={11}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M1 4v6h6M23 20v-6h-6" />
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
              </svg>
            </button>
          )}
        </Box>
      )}

      {/* Compliance disclaimer */}
      <Box
        style={{
          marginTop: tokens.spacing[2],
          textAlign: 'center',
          fontSize: tokens.typography.fontSize.xs,
          color: 'var(--color-text-tertiary)',
        }}
      >
        {t('notInvestmentAdvice')}
      </Box>
    </>
  )
}
