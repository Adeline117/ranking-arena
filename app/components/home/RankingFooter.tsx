import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'

interface RankingFooterProps {
  loading: boolean
  lastUpdated?: string | null
  formatLastUpdated: (dateStr: string | null | undefined) => string | null
  t: (key: string) => string
}

function isStale(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false
  try {
    const diffMs = Date.now() - new Date(dateStr).getTime()
    return diffMs > 60 * 60 * 1000 // > 1 hour
  } catch { return false }
}

export default function RankingFooter({
  loading,
  lastUpdated,
  formatLastUpdated,
  t,
}: RankingFooterProps) {
  const stale = isStale(lastUpdated)

  return (
    <>
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
            color: stale ? 'var(--color-accent-warning, #f59e0b)' : 'var(--color-text-tertiary)',
            paddingRight: tokens.spacing[3],
          }}
        >
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
          <span suppressHydrationWarning>{formatLastUpdated(lastUpdated)}</span>
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
