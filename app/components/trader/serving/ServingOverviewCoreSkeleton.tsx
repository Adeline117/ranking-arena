'use client'

/**
 * Stable cold-start placeholder for the default serving three-tab Overview.
 *
 * This is intentionally distinct from a no-data or degraded state: it is
 * rendered only before any truthful core module has arrived. Its shape mirrors
 * the decision-critical performance card and equity chart so loading data does
 * not first appear as an empty trader profile and then shift the page.
 */

import { Box } from '@/app/components/base'
import { Skeleton } from '@/app/components/ui/Skeleton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

export default function ServingOverviewCoreSkeleton() {
  const { t } = useLanguage()

  return (
    <Box
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      aria-label={t('loading')}
      data-testid="serving-overview-core-skeleton"
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}
    >
      {/* Keep the individual skeleton decorations out of the accessibility tree;
          the parent status above announces the one meaningful loading state. */}
      <Box
        aria-hidden="true"
        style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}
      >
        <Box
          className="glass-card"
          style={{
            padding: tokens.spacing[5],
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[5],
          }}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.spacing[3] }}>
            <Skeleton width="112px" height="20px" />
            <Skeleton width="164px" height="44px" />
          </Box>
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
              gap: tokens.spacing[4],
            }}
          >
            <Skeleton height="120px" />
            <Skeleton height="120px" />
          </Box>
          <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
            <Skeleton width="92px" height="28px" />
            <Skeleton width="108px" height="28px" />
            <Skeleton width="86px" height="28px" />
            <Skeleton width="116px" height="28px" />
          </Box>
        </Box>

        <Box
          className="glass-card"
          style={{
            padding: tokens.spacing[5],
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[4],
          }}
        >
          <Skeleton width="148px" height="20px" />
          <Skeleton height="260px" />
        </Box>
      </Box>
    </Box>
  )
}
