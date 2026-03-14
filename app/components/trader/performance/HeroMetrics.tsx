'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { Sparkline } from '@/app/components/ui/Sparkline'
import { formatPnL as formatPnLUtil, formatROI as formatROIUtil } from '../../ranking/utils'

export interface HeroMetricsProps {
  roi: number | undefined
  pnl: number | undefined
  sparklineData: number[]
  isVisible: boolean
}

export function HeroMetrics({ roi, pnl, sparklineData, isVisible }: HeroMetricsProps) {
  const { t } = useLanguage()
  void t // used below

  const formatPnl = (value: number | undefined) => {
    if (value === undefined) return '—'
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
          background: roi !== undefined && roi >= 0
            ? `linear-gradient(135deg, ${tokens.colors.accent.success}08 0%, ${tokens.colors.accent.success}03 100%)`
            : roi !== undefined
              ? `linear-gradient(135deg, ${tokens.colors.accent.error}08 0%, ${tokens.colors.accent.error}03 100%)`
              : tokens.colors.bg.tertiary + '40',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${roi !== undefined && roi >= 0 ? tokens.colors.accent.success + '20' : roi !== undefined ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: 11, fontWeight: 500 }}>
          {t('roi')}
        </Text>
        <Box style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Text
            className="hero-metric-value"
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: roi !== undefined ? (roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
              transition: 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.1s',
            }}
          >
            {roi !== undefined ? formatROIUtil(roi) : '—'}
          </Text>
          {(sparklineData.length > 2 || roi !== undefined) && (
            <Sparkline
              data={sparklineData.length > 2 ? sparklineData : undefined}
              roi={roi}
              width={80}
              height={28}
              color={roi !== undefined && roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}
            />
          )}
        </Box>
      </Box>

      {/* PnL 卡片 */}
      <Box
        style={{
          padding: tokens.spacing[4],
          background: pnl !== undefined && pnl >= 0
            ? `linear-gradient(135deg, ${tokens.colors.accent.success}08 0%, ${tokens.colors.accent.success}03 100%)`
            : pnl !== undefined
              ? `linear-gradient(135deg, ${tokens.colors.accent.error}08 0%, ${tokens.colors.accent.error}03 100%)`
              : tokens.colors.bg.tertiary + '40',
          borderRadius: tokens.radius.lg,
          border: `1px solid ${pnl !== undefined && pnl >= 0 ? tokens.colors.accent.success + '20' : pnl !== undefined ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: 11, fontWeight: 500 }}>
          {t('pnl')}
        </Text>
        <Text
          className="hero-metric-value"
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: pnl !== undefined ? (pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary,
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
            letterSpacing: '-0.03em',
            lineHeight: 1.2,
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
            transition: 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.2s',
          }}
        >
          {formatPnl(pnl)}
        </Text>
      </Box>
    </Box>
  )
}
