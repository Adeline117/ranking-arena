'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { generateExplanation, getCompletenessLabel, getCompletenessColor } from '@/lib/utils/score-explain'
import { ScoreRadar } from './ScoreRadar'
import { CompactErrorBoundary } from '../utils/ErrorBoundary'

interface ScoreBreakdownProps {
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  score_completeness?: 'full' | 'partial' | 'minimal' | null
  max_drawdown?: number | null
  win_rate?: number | null
  roi?: number | null
  arena_score?: number | null
}

interface BarProps {
  label: string
  score: number | null | undefined
  maxScore: number
  color: string
}

function ScoreBar({ label, score, maxScore, color }: BarProps) {
  const value = score ?? 0
  const pct = Math.min((value / maxScore) * 100, 100)

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <Text size="xs" style={{ width: 56, flexShrink: 0, color: tokens.colors.text.secondary, fontSize: 11 }}>
        {label}
      </Text>
      <Box style={{ flex: 1, height: 20, background: 'var(--color-bg-tertiary)', borderRadius: tokens.radius.md, overflow: 'hidden', position: 'relative', border: '1px solid var(--color-border-primary)' }}>
        <Box style={{
          width: `${pct}%`,
          height: '100%',
          background: `linear-gradient(90deg, ${color}, ${color}dd)`,
          borderRadius: tokens.radius.md,
          transition: 'width 0.6s ease',
          minWidth: score != null ? 4 : 0,
          boxShadow: `0 0 6px ${color}40`,
        }} />
        <Text size="xs" weight="bold" style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 11,
          color: pct > 60 ? 'white' : (score != null ? color : tokens.colors.text.tertiary),
          textShadow: pct > 60 ? 'var(--text-shadow-sm)' : 'none',
        }}>
          {score != null ? `${score.toFixed(1)}` : '—'} / {maxScore}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * 评分详情展开组件 - 三维度条形图 + 雷达图 + 自然语言解读
 */
export const ScoreBreakdown = memo(function ScoreBreakdown(props: ScoreBreakdownProps) {
  const { t } = useLanguage()
  const {
    profitability_score,
    risk_control_score,
    execution_score,
    score_completeness,
    max_drawdown,
    win_rate,
    roi,
    arena_score,
  } = props

  const hasAnyScore = profitability_score != null || risk_control_score != null || execution_score != null

  const explanation = hasAnyScore ? generateExplanation({
    profitability_score,
    risk_control_score,
    execution_score,
    score_completeness,
    max_drawdown,
    win_rate,
    roi,
  }) : (arena_score != null
    ? (t('scoreBasisRoiPnl') || 'Score based on ROI and PnL data. Detailed breakdown not yet available for this trader.')
    : (t('scoreNoDetails') || 'Score breakdown not yet computed. Data will populate as trading history accumulates.'))

  const completenessLabel = getCompletenessLabel(score_completeness)
  const completenessColor = getCompletenessColor(score_completeness)

  return (
    <Box style={{
      padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
      background: 'var(--color-bg-tertiary)',
      borderTop: `1px solid var(--color-border-secondary)`,
      display: 'flex',
      gap: tokens.spacing[5],
      flexWrap: 'wrap',
      alignItems: 'flex-start',
    }}>
      {/* 左侧：条形图 */}
      <Box style={{ flex: '1 1 200px', minWidth: 0, opacity: hasAnyScore ? 1 : 0.5 }}>
        <Text size="xs" weight="bold" style={{ marginBottom: 8, color: tokens.colors.text.secondary }}>
          {t('scoreBreakdownTitle')}
        </Text>
        <ScoreBar label={t('scoreProfit')} score={profitability_score} maxScore={60} color="var(--color-score-profitability)" />
        <ScoreBar label={t('scoreRisk')} score={risk_control_score} maxScore={40} color="var(--color-score-risk)" />

        {/* 置信度标签 */}
        <Box style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>{t('scoreDataConfidence')}</Text>
            <span style={{
              display: 'inline-block',
              padding: '1px 8px',
              borderRadius: tokens.radius.md,
              fontSize: 11,
              fontWeight: 600,
              color: completenessColor,
              background: `${completenessColor}18`,
              border: `1px solid ${completenessColor}40`,
            }}>
              {completenessLabel}
            </span>
          </Box>
          {(score_completeness === 'partial' || score_completeness === 'minimal') && (
            <Text size="xs" style={{ color: completenessColor, opacity: 0.85, lineHeight: 1.5 }}>
              {score_completeness === 'minimal'
                ? (t('confidenceMinimalReason') || `Score based on limited data: ${[!win_rate && 'win rate', !max_drawdown && 'drawdown'].filter(Boolean).join(' and ')} not available`)
                : (t('confidencePartialReason') || `Score adjusted: ${[!win_rate && 'win rate', !max_drawdown && 'drawdown'].filter(Boolean).join(' and ')} not available from this exchange`)}
            </Text>
          )}
        </Box>
      </Box>

      {/* 右侧：雷达图 */}
      <Box style={{ flex: '0 0 120px', display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: hasAnyScore ? 1 : 0.5 }}>
        <CompactErrorBoundary>
          <ScoreRadar
            profitability={profitability_score ?? 0}
            riskControl={risk_control_score ?? 0}
            execution={execution_score ?? 0}
            arenaScore={arena_score ?? 0}
            size={120}
          />
        </CompactErrorBoundary>
      </Box>

      {/* 底部：自然语言解读 */}
      <Box style={{ flex: '1 1 100%', marginTop: 4 }}>
        <Text size="xs" style={{
          color: tokens.colors.text.secondary,
          lineHeight: 1.6,
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.md,
          border: `1px solid var(--color-border-secondary)`,
        }}>
          {explanation}
        </Text>
      </Box>
    </Box>
  )
})

export default ScoreBreakdown
