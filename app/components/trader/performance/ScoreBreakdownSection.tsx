'use client'

import { formatScoreWhole } from '@/lib/utils/format'
import { useId } from 'react'

import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { ScoreRadar } from '@/app/components/ranking/ScoreRadar'
import { CompactErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { getScoreColor as getArenaScoreColor } from '@/lib/utils/score-colors'
import { isValidScore, ScoreBar } from './ScoreBar'
import type { NormalizedScoreConfidence } from '@/lib/data/trader/mappers'

const arenaScoreColor = (score: number) => getArenaScoreColor(score)

export interface ScoreBreakdownSectionProps {
  periodArenaScore: number | undefined
  periodProfitabilityScore: number | undefined
  periodRiskControlScore: number | undefined
  arenaScoreV3: number | undefined
  scoreConfidence: NormalizedScoreConfidence | null | undefined
  isVisible: boolean
  rank?: number
  totalTraders?: number
  platformName?: string
}

export function ScoreBreakdownSection({
  periodArenaScore,
  periodProfitabilityScore,
  periodRiskControlScore,
  arenaScoreV3,
  scoreConfidence,
  isVisible,
  rank,
  totalTraders,
  platformName,
}: ScoreBreakdownSectionProps) {
  const { t } = useLanguage()
  const tooltipId = useId()
  const profitabilityScore = isValidScore(periodProfitabilityScore, 100)
    ? periodProfitabilityScore
    : null
  const riskControlScore = isValidScore(periodRiskControlScore, 100) ? periodRiskControlScore : null
  const canonicalArenaScore =
    periodArenaScore != null
      ? isValidScore(periodArenaScore, 100)
        ? periodArenaScore
        : null
      : isValidScore(arenaScoreV3, 100)
        ? arenaScoreV3
        : null

  const hasScores =
    canonicalArenaScore != null || profitabilityScore != null || riskControlScore != null
  const confidenceState = scoreConfidence ?? 'unknown'
  const showConfidenceWarning = confidenceState !== 'full'
  const severeConfidence =
    confidenceState === 'minimal' ||
    confidenceState === 'insufficient' ||
    confidenceState === 'unknown'
  const confidenceColor = severeConfidence
    ? tokens.colors.accent.error
    : tokens.colors.accent.warning
  const confidenceMessage =
    confidenceState === 'minimal'
      ? t('confidenceMinimal')
      : confidenceState === 'partial'
        ? t('confidencePartial')
        : confidenceState === 'insufficient'
          ? t('confidenceInsufficient')
          : t('confidenceUnknown')

  if (!hasScores) return null

  return (
    <Box
      style={{
        marginTop: tokens.spacing[5],
        paddingTop: tokens.spacing[5],
        borderTop: `1px solid ${alpha(tokens.colors.border.primary, 25)}`,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.4s',
        overflow: 'hidden',
      }}
    >
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
          flexWrap: 'wrap',
        }}
      >
        {/* Decorative section icon — kept neutral so the score badges are the
            single signal accent on this header (one accent per surface). */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.text.tertiary}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
          {t('scoreBreakdown')}
        </Text>
        {/* Score explanation tooltip */}
        <Box
          style={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="score-tooltip-trigger"
            aria-label={t('scoreGuide')}
            aria-describedby={tooltipId}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: '50%',
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              cursor: 'help',
              color: tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              lineHeight: 1,
            }}
          >
            <span aria-hidden="true">?</span>
          </button>
          <Box
            id={tooltipId}
            role="tooltip"
            className="score-tooltip-content"
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginTop: 8,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              boxShadow: '0 8px 24px var(--color-overlay-medium)',
              width: 280,
              zIndex: 50,
              display: 'block',
              visibility: 'hidden',
              opacity: 0,
              pointerEvents: 'none',
              transition: 'opacity 0.15s ease',
            }}
          >
            <Text
              size="xs"
              weight="bold"
              style={{ color: tokens.colors.text.secondary, marginBottom: 4, display: 'block' }}
            >
              {t('scoreGuide')}
            </Text>
            <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
              {t('scoreGuideDetail')}
            </Text>
          </Box>
          <style>{`
            .score-tooltip-trigger:hover + .score-tooltip-content,
            .score-tooltip-trigger:focus-visible + .score-tooltip-content {
              visibility: visible !important;
              opacity: 1 !important;
            }
            .score-label-short { display: none; }
            @media (max-width: 480px) {
              .score-badges-row { margin-left: 0 !important; }
              .score-label-full { display: none !important; }
              .score-label-short { display: inline !important; }
            }
          `}</style>
        </Box>
        {/* Arena Score 总分 */}
        <Box
          className="score-badges-row"
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}
        >
          {canonicalArenaScore != null && (
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                background: `${alpha(arenaScoreColor(canonicalArenaScore), 8)}`,
                borderRadius: tokens.radius.full,
                border: `1px solid ${alpha(arenaScoreColor(canonicalArenaScore), 19)}`,
              }}
            >
              <Text className="score-label-full" size="xs" color="secondary" weight="bold">
                {t('arenaScore')}
              </Text>
              <Text className="score-label-short" size="xs" color="secondary" weight="bold">
                Score
              </Text>
              <Text
                size="sm"
                weight="black"
                style={{
                  color: arenaScoreColor(canonicalArenaScore),
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {formatScoreWhole(canonicalArenaScore)}
              </Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Rank position & percentile */}
      {rank != null && rank > 0 && totalTraders != null && totalTraders > 0 && platformName && (
        <Text
          size="xs"
          color="secondary"
          style={{
            fontSize: 12,
            marginTop: tokens.spacing[1],
            marginBottom: tokens.spacing[2],
            textAlign: 'right',
          }}
        >
          {t('traderRankOf')
            .replace('{rank}', rank.toLocaleString('en-US'))
            .replace('{total}', totalTraders.toLocaleString('en-US'))
            .replace('{platform}', platformName)}
          {' · '}
          {t('traderRankTop').replace('{pct}', ((rank / totalTraders) * 100).toFixed(1))}
        </Text>
      )}

      {/* 分数条 + 雷达图 */}
      <Box
        className="score-breakdown-layout"
        style={{
          display: 'flex',
          gap: tokens.spacing[5],
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <Box
          style={{
            flex: '1 1 200px',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[3],
          }}
        >
          {/* Current-period v4 dimensions (0-100 percentiles) are resolved by the caller.
              This section never reaches back to a different period for a visual fallback. */}
          <ScoreBar
            label={t('scoreProfit')}
            score={profitabilityScore}
            maxScore={100}
            isVisible={isVisible}
            delay={500}
          />
          <ScoreBar
            label={t('scoreRisk')}
            score={riskControlScore}
            maxScore={100}
            isVisible={isVisible}
            delay={550}
          />
        </Box>
        {/* 雷达图：优先使用V3三维度分数，回退到4维映射 */}
        <Box
          style={{
            flex: '0 0 auto',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <CompactErrorBoundary>
            <ScoreRadar
              profitability={profitabilityScore}
              riskControl={riskControlScore}
              execution={null}
              arenaScore={canonicalArenaScore}
              size={130}
            />
          </CompactErrorBoundary>
        </Box>
      </Box>

      {/* Confidence is period-specific; unknown inputs never masquerade as ranked data. */}
      {showConfidenceWarning && (
        <Box
          role="status"
          style={{
            marginTop: tokens.spacing[3],
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            background: `${alpha(confidenceColor, 6)}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${alpha(confidenceColor, 15)}`,
            maxWidth: '100%',
            boxSizing: 'border-box',
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke={confidenceColor}
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <Text
            size="xs"
            style={{
              color: confidenceColor,
              fontWeight: tokens.typography.fontWeight.medium,
            }}
          >
            {confidenceMessage}
          </Text>
        </Box>
      )}

      {/* Score explanation removed - now in tooltip on header */}
    </Box>
  )
}
