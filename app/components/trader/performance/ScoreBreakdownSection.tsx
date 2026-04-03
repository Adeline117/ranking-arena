'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { ScoreRadar } from '@/app/components/ranking/ScoreRadar'
import { CompactErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { getScoreColor as getArenaScoreColor } from '@/lib/utils/score-colors'
import { ScoreBar } from './ScoreBar'
import type { ExtendedPerformance } from '../OverviewPerformanceCard'

const arenaScoreColor = (score: number) => getArenaScoreColor(score)

export interface ScoreBreakdownSectionProps {
  performance: ExtendedPerformance
  periodArenaScore: number | undefined
  periodReturnScore: number | undefined
  periodPnlScore: number | undefined
  periodDrawdownScore: number | undefined
  periodStabilityScore: number | undefined
  arenaScoreV3: number | undefined
  isVisible: boolean
  rank?: number
  totalTraders?: number
  platformName?: string
}

export function ScoreBreakdownSection({
  performance,
  periodArenaScore,
  periodReturnScore,
  periodPnlScore,
  periodDrawdownScore,
  periodStabilityScore,
  arenaScoreV3,
  isVisible,
  rank,
  totalTraders,
  platformName,
}: ScoreBreakdownSectionProps) {
  const { t } = useLanguage()

  const hasScores = periodArenaScore != null || periodReturnScore != null || periodDrawdownScore != null || periodStabilityScore != null || arenaScoreV3 != null || performance.profitability_score != null

  if (!hasScores) return null

  return (
    <Box
      style={{
        marginTop: tokens.spacing[5],
        paddingTop: tokens.spacing[5],
        borderTop: `1px solid ${tokens.colors.border.primary}40`,
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.4s',
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.warning} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: tokens.colors.bg.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            cursor: 'help',
            flexShrink: 0,
          }}
          className="score-tooltip-trigger"
        >
          <Text size="xs" style={{ color: tokens.colors.text.tertiary, fontSize: 11, fontWeight: 700, lineHeight: 1 }}>?</Text>
          <Box
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
              display: 'none',
              pointerEvents: 'none',
            }}
          >
            <Text size="xs" weight="bold" style={{ color: tokens.colors.text.secondary, marginBottom: 4, display: 'block' }}>
              {t('scoreGuide')}
            </Text>
            <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
              {t('scoreGuideDetail')}
            </Text>
          </Box>
          <style>{`
            .score-tooltip-trigger:hover .score-tooltip-content {
              display: block !important;
            }
          `}</style>
        </Box>
        {/* Arena Score 总分 */}
        <Box style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {arenaScoreV3 != null && (
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                background: `${tokens.colors.accent.success}15`,
                borderRadius: tokens.radius.full,
                border: `1px solid ${tokens.colors.accent.success}30`,
              }}
            >
              <Text size="xs" color="secondary" weight="bold">V3</Text>
              <Text
                size="sm"
                weight="black"
                style={{
                  color: tokens.colors.accent.success,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {arenaScoreV3.toFixed(0)}
              </Text>
            </Box>
          )}
          {periodArenaScore != null && (
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                background: `${arenaScoreColor(periodArenaScore)}15`,
                borderRadius: tokens.radius.full,
                border: `1px solid ${arenaScoreColor(periodArenaScore)}30`,
              }}
            >
              <Text size="xs" color="secondary" weight="bold">Arena Score</Text>
              <Text
                size="sm"
                weight="black"
                style={{
                  color: arenaScoreColor(periodArenaScore),
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                }}
              >
                {periodArenaScore.toFixed(0)}
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
          {t('traderRankTop').replace('{pct}', (rank / totalTraders * 100).toFixed(1))}
        </Text>
      )}

      {/* 分数条 + 雷达图 */}
      <Box
        className="score-breakdown-layout"
        style={{ display: 'flex', gap: tokens.spacing[5], alignItems: 'flex-start', flexWrap: 'wrap' }}
      >
        <Box style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          <ScoreBar
            label={t('returnScore')}
            score={periodReturnScore ?? null}
            maxScore={70}
            isVisible={isVisible}
            delay={500}
          />
          <ScoreBar
            label={t('pnlScore')}
            score={periodPnlScore ?? null}
            maxScore={15}
            isVisible={isVisible}
            delay={550}
          />
          <ScoreBar
            label={t('drawdownScore')}
            score={periodDrawdownScore ?? null}
            maxScore={8}
            isVisible={isVisible}
            delay={600}
          />
          <ScoreBar
            label={t('stabilityScore')}
            score={periodStabilityScore ?? null}
            maxScore={7}
            isVisible={isVisible}
            delay={700}
          />
        </Box>
        {/* 雷达图：优先使用V3三维度分数，回退到4维映射 */}
        <Box style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <CompactErrorBoundary>
            <ScoreRadar
              profitability={performance.profitability_score ?? ((periodReturnScore ?? 0) / 70) * 35}
              riskControl={performance.risk_control_score ?? (((periodDrawdownScore ?? 0) / 8 + (periodStabilityScore ?? 0) / 7) / 2) * 40}
              execution={performance.execution_score ?? ((periodPnlScore ?? 0) / 15) * 25}
              arenaScore={performance.arena_score_v3 ?? periodArenaScore ?? 0}
              size={130}
            />
          </CompactErrorBoundary>
        </Box>
      </Box>

      {/* 数据置信度提示 */}
      {performance.score_confidence && performance.score_confidence !== 'full' && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            background: performance.score_confidence === 'minimal'
              ? `${tokens.colors.accent.error}10`
              : `${tokens.colors.accent.warning}10`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${performance.score_confidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning}25`,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke={performance.score_confidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning}
            strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <Text size="xs" style={{
            color: performance.score_confidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning,
            fontWeight: 500,
          }}>
            {performance.score_confidence === 'minimal'
              ? t('confidenceMinimal')
              : t('confidencePartial')
            }
          </Text>
        </Box>
      )}

      {/* Score explanation removed - now in tooltip on header */}
    </Box>
  )
}
