'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { Sparkline } from '@/app/components/ui/Sparkline'
import Metric from '@/app/components/ui/Metric'
import InfoTooltip from '../../ui/InfoTooltip'
import PnlContractNotice from '../serving/PnlContractNotice'
import { isValidScore } from './ScoreBar'
import { getScoreColor } from '@/lib/utils/score-colors'
import { NULL_DISPLAY } from '@/lib/utils/format'
import type {
  GmxMaxCapitalRoiDisclosure,
  GmxRealizedNetDisclosure,
} from '@/lib/data/serving/pnl-contract'

export interface HeroMetricsProps {
  /** Period Arena Score — the primary hero figure. Invalid/absent → em-dash. */
  arenaScore?: number | null
  roi: number | undefined
  roiDisclosure?: GmxMaxCapitalRoiDisclosure
  pnl: number | undefined
  pnlDisclosure?: GmxRealizedNetDisclosure
  sparklineData: number[]
  isVisible: boolean
}

export function HeroMetrics({
  arenaScore,
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

  const finiteScore = isValidScore(arenaScore, 100) ? arenaScore : null

  return (
    <Box
      className="hero-metrics-grid"
      style={{
        // Columns/areas live in globals.css (.hero-metrics-grid): Score | ROI |
        // PnL on wide cards; Score full-width above ROI | PnL on narrow ones.
        display: 'grid',
        gap: tokens.spacing[4],
        marginBottom: tokens.spacing[5],
      }}
    >
      {/* Arena Score — the primary hero figure (owner 2026-11-13): larger
          than ROI, neutral color, tier shown only by a 1px ring border. */}
      <Box
        className="hero-metrics-score"
        data-testid="hero-arena-score"
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          border: `1px solid ${finiteScore != null ? getScoreColor(finiteScore) : tokens.colors.border.primary}`,
        }}
      >
        <Box style={{ minWidth: 0 }}>
          <Text
            size="xs"
            style={{
              color: tokens.colors.text.tertiary,
              marginBottom: tokens.spacing[1],
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.medium,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {t('arenaScore')}
            <InfoTooltip text={t('arenaScoreHeaderTooltip')} size={11} />
          </Text>
          <span
            className="hero-score-value"
            role="img"
            aria-label={
              finiteScore != null ? `Arena Score ${finiteScore.toFixed(0)}` : 'Arena Score unknown'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: tokens.spacing[1],
              ...enterStyle(50),
            }}
          >
            <span
              aria-hidden="true"
              style={{
                fontSize: tokens.typography.fontSize['4xl'],
                fontWeight: tokens.typography.fontWeight.bold,
                color: tokens.colors.text.primary,
                lineHeight: 1,
                letterSpacing: '-0.03em',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {finiteScore != null ? finiteScore.toFixed(0) : NULL_DISPLAY}
            </span>
            {finiteScore != null && (
              <span
                aria-hidden="true"
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: tokens.colors.text.tertiary,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                / 100
              </span>
            )}
          </span>
        </Box>
      </Box>

      {/* ROI 卡片 */}
      <Box
        className="hero-metrics-roi"
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
        <Box
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            // Half-width ROI card on phones: the sparkline wraps below the figure
            // instead of being clipped by the card's overflow:hidden.
            flexWrap: 'wrap',
            gap: tokens.spacing[2],
          }}
        >
          <Metric
            className="hero-metric-value"
            value={roi}
            format="roi"
            size="hero"
            style={enterStyle(100)}
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
        className="hero-metrics-pnl"
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
        <Metric value={pnl} format="pnl" size="lg" style={enterStyle(200)} />
        {pnlDisclosure && <PnlContractNotice disclosure={pnlDisclosure} compact />}
      </Box>
    </Box>
  )
}
