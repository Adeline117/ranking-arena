'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage()

  const styles: Record<string, { bg: string; color: string; key: string }> = {
    pending: { bg: 'var(--color-orange-bg-light)', color: 'var(--color-accent-warning)', key: 'pendingReview' },
    approved: { bg: 'var(--color-accent-success-20)', color: 'var(--color-accent-success)', key: 'approved' },
    rejected: { bg: 'var(--color-red-bg-light)', color: 'var(--color-accent-error)', key: 'rejected' }
  }

  const style = styles[status] || styles.pending

  return (
    <Box
      as="span"
      style={{
        display: 'inline-block',
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.md,
        background: style.bg,
        color: style.color,
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: tokens.typography.fontWeight.bold,
      }}
    >
      {t(style.key)}
    </Box>
  )
}
