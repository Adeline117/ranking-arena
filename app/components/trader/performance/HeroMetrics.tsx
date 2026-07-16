'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { Sparkline } from '@/app/components/ui/Sparkline'
import Metric from '@/app/components/ui/Metric'
import InfoTooltip from '../../ui/InfoTooltip'
import PnlContractNotice from '../serving/PnlContractNotice'
import type {
  GmxMaxCapitalRoiDisclosure,
  GmxRealizedNetDisclosure,
} from '@/lib/data/serving/pnl-contract'

export interface HeroMetricsProps {
  roi: number | undefined
  roiDisclosure?: GmxMaxCapitalRoiDisclosure
  pnl: number | undefined
  pnlDisclosure?: GmxRealizedNetDisclosure
  sparklineData: number[]
  isVisible: boolean
}

export function HeroMetrics({
  roi,
  roiDisclosure,
  pnl,
  pnlDisclosure,
  sparklineData,
  isVisible,
}: HeroMetricsProps) {
  const { t } = useLanguage()

  // Shared entrance animation for the headline figures.
  const enterStyle = (delayMs: number) => ({
    opacity: isVisible ? 1 : 0,
    transform: isVisible ? 'translateY(0)' : 'translateY(4px)',
    transition: `opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1) ${delayMs}ms, transform 0.5s cubic-bezier(0.4, 0, 0.2, 1) ${delayMs}ms`,
  })

  return (
    <Box
      className="performance-main-grid"
      style={{
        display: 'grid',
        // ROI is the single dominant hero → give it the wider column. Collapses
        // to a single column ≤768px (see .performance-main-grid in globals.css),
        // so the hero never gets cramped on narrow / 320px viewports.
        gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
        gap: tokens.spacing[4],
        marginBottom: tokens.spacing[5],
      }}
    >
      {/* ROI 卡片 */}
      <Box
        style={{
          padding: tokens.spacing[4],
          background:
            roi != null && roi >= 0
              ? `linear-gradient(135deg, ${alpha(tokens.colors.accent.success, 3)} 0%, ${alpha(tokens.colors.accent.success, 1)} 100%)`
              : roi != null
                ? `linear-gradient(135deg, ${alpha(tokens.colors.accent.error, 3)} 0%, ${alpha(tokens.colors.accent.error, 1)} 100%)`
                : alpha(tokens.colors.bg.tertiary, 25),
          borderRadius: tokens.radius.lg,
          border: `1px solid ${roi != null && roi >= 0 ? alpha(tokens.colors.accent.success, 13) : roi != null ? alpha(tokens.colors.accent.error, 13) : tokens.colors.border.primary}`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Text
          size="xs"
          style={{
            color: tokens.colors.text.tertiary,
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {t(roiDisclosure ? 'gmxMaxCapitalRoiLabel' : 'roi')}
          <InfoTooltip
            text={
              roiDisclosure
                ? t('gmxMaxCapitalRoiTooltip')
                : t('roiTooltip').replace('{range}', '') ||
                  "Return on Investment: Total percentage gain or loss on the trader's portfolio."
            }
            size={11}
          />
        </Text>
        <Box style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Metric
            className="hero-metric-value"
            value={roi}
            format="roi"
            size="hero"
            style={{
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              ...enterStyle(100),
            }}
          />
          {(sparklineData.length > 2 || roi != null) && (
            <Sparkline
              data={sparklineData.length > 2 ? sparklineData : undefined}
              roi={roi}
              width={80}
              height={28}
              color={
                roi != null && roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
              }
            />
          )}
        </Box>
      </Box>

      {/* PnL 卡片 */}
      <Box
        style={{
          padding: tokens.spacing[4],
          background:
            pnl != null && pnl >= 0
              ? `linear-gradient(135deg, ${alpha(tokens.colors.accent.success, 3)} 0%, ${alpha(tokens.colors.accent.success, 1)} 100%)`
              : pnl != null
                ? `linear-gradient(135deg, ${alpha(tokens.colors.accent.error, 3)} 0%, ${alpha(tokens.colors.accent.error, 1)} 100%)`
                : alpha(tokens.colors.bg.tertiary, 25),
          borderRadius: tokens.radius.lg,
          border: `1px solid ${pnl != null && pnl >= 0 ? alpha(tokens.colors.accent.success, 13) : pnl != null ? alpha(tokens.colors.accent.error, 13) : tokens.colors.border.primary}`,
        }}
      >
        <Text
          size="xs"
          style={{
            color: tokens.colors.text.tertiary,
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {t(pnlDisclosure ? 'gmxRealizedNetPnlLabel' : 'pnl')}
          <InfoTooltip
            text={t(pnlDisclosure ? 'gmxRealizedNetPnlTooltip' : 'pnlTooltip')}
            size={11}
          />
        </Text>
        {/* Secondary supporting figure — demoted below the ROI hero. */}
        <Metric
          value={pnl}
          format="pnl"
          size="lg"
          style={{
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
            ...enterStyle(200),
          }}
        />
        {pnlDisclosure && <PnlContractNotice disclosure={pnlDisclosure} compact />}
      </Box>
    </Box>
  )
}
