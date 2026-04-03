'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { Sparkline } from '@/app/components/ui/Sparkline'
import { formatPnL as formatPnLUtil, formatROI as formatROIUtil } from '../../ranking/utils'
import InfoTooltip from '../../ui/InfoTooltip'

export interface HeroMetricsProps {
  roi: number | undefined
  pnl: number | undefined
  sparklineData: number[]
  isVisible: boolean
}

export function HeroMetrics({ roi, pnl, sparklineData, isVisible }: HeroMetricsProps) {
  const { t } = useLanguage()
  void t // used below

  const formatPnl = (value: number | undefined | null) => {
    if (value == null) return '—'
    return formatPnLUtil(value)
  }

  return (
    <Box
      className="performance-main-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: tokens.spacing[4],
        marginBottom: tokens.spacing[5],
      }}
    >
      {/* ROI 卡片 */}
      <Box
        style={{
          padding: tokens.spacing[4],
          background: roi != null && roi >= 0
            ? `linear-gradient(135deg, ${tokens.colors.accent.success}08 0%, ${tokens.colors.accent.success}03 100%)`
            : roi != null
              ? `linear-gradient(135deg, ${tokens.colors.accent.error}08 0%, ${tokens.colors.accent.error}03 100%)`
              : tokens.colors.bg.tertiary + '40',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${roi != null && roi >= 0 ? tokens.colors.accent.success + '20' : roi != null ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: tokens.typography.fontSize.xs, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
          {t('roi')}
          <InfoTooltip text={t('roiTooltip').replace('{range}', '') || 'Return on Investment: Total percentage gain or loss on the trader\'s portfolio.'} size={11} />
        </Text>
        <Box style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Text
            className="hero-metric-value"
            style={{
              fontSize: tokens.typography.fontSize.hero,
              fontWeight: 800,
              color: roi != null ? (roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? 'translateY(0)' : 'translateY(4px)',
              transition: 'opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.1s, transform 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.1s',
            }}
          >
            {roi != null ? formatROIUtil(roi) : '—'}
          </Text>
          {(sparklineData.length > 2 || roi != null) && (
            <Sparkline
              data={sparklineData.length > 2 ? sparklineData : undefined}
              roi={roi}
              width={80}
              height={28}
              color={roi != null && roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}
            />
          )}
        </Box>
      </Box>

      {/* PnL 卡片 */}
      <Box
        style={{
          padding: tokens.spacing[4],
          background: pnl != null && pnl >= 0
            ? `linear-gradient(135deg, ${tokens.colors.accent.success}08 0%, ${tokens.colors.accent.success}03 100%)`
            : pnl != null
              ? `linear-gradient(135deg, ${tokens.colors.accent.error}08 0%, ${tokens.colors.accent.error}03 100%)`
              : tokens.colors.bg.tertiary + '40',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${pnl != null && pnl >= 0 ? tokens.colors.accent.success + '20' : pnl != null ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: tokens.typography.fontSize.xs, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
          {t('pnl')}
          <InfoTooltip text={t('pnlTooltip') || 'Profit & Loss: Total dollar amount gained or lost.'} size={11} />
        </Text>
        <Text
          className="hero-metric-value"
          style={{
            fontSize: tokens.typography.fontSize.hero,
            fontWeight: 800,
            color: pnl != null ? (pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary,
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
            letterSpacing: '-0.03em',
            lineHeight: 1.2,
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translateY(0)' : 'translateY(4px)',
            transition: 'opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.2s, transform 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.2s',
          }}
        >
          {formatPnl(pnl)}
        </Text>
      </Box>
    </Box>
  )
}
