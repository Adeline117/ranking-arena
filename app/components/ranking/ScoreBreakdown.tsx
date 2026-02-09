'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { generateExplanation, getCompletenessLabel, getCompletenessColor } from '@/lib/utils/score-explain'
import { ScoreRadar } from './ScoreRadar'

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
      <Box style={{ flex: 1, height: 14, background: 'var(--color-bg-tertiary)', borderRadius: 7, overflow: 'hidden', position: 'relative' }}>
        <Box style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          borderRadius: 7,
          transition: 'width 0.4s ease',
          minWidth: score != null ? 2 : 0,
        }} />
      </Box>
      <Text size="xs" weight="bold" style={{ width: 40, textAlign: 'right', color: score != null ? color : tokens.colors.text.tertiary, fontSize: 11 }}>
        {score != null ? `${score.toFixed(0)}` : '--'}/{maxScore}
      </Text>
    </Box>
  )
}

/**
 * 评分详情展开组件 - 三维度条形图 + 雷达图 + 自然语言解读
 */
export const ScoreBreakdown = memo(function ScoreBreakdown(props: ScoreBreakdownProps) {
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

  if (!hasAnyScore) {
    return (
      <Box style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`, textAlign: 'center' }}>
        <Text size="sm" color="tertiary">暂无评分详情</Text>
      </Box>
    )
  }

  const explanation = generateExplanation({
    profitability_score,
    risk_control_score,
    execution_score,
    score_completeness,
    max_drawdown,
    win_rate,
    roi,
  })

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
      <Box style={{ flex: '1 1 200px', minWidth: 0 }}>
        <Text size="xs" weight="bold" style={{ marginBottom: 8, color: tokens.colors.text.secondary }}>
          评分构成
        </Text>
        <ScoreBar label="收益能力" score={profitability_score} maxScore={35} color="var(--color-score-profitability)" />
        <ScoreBar label="风险控制" score={risk_control_score} maxScore={40} color="var(--color-score-risk)" />
        <ScoreBar label="执行质量" score={execution_score} maxScore={25} color="var(--color-score-execution)" />

        {/* 置信度标签 */}
        <Box style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>数据置信度:</Text>
          <span style={{
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 600,
            color: completenessColor,
            background: `${completenessColor}18`,
            border: `1px solid ${completenessColor}40`,
          }}>
            {completenessLabel}
          </span>
        </Box>
      </Box>

      {/* 右侧：雷达图 */}
      <Box style={{ flex: '0 0 120px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <ScoreRadar
          profitability={profitability_score ?? 0}
          riskControl={risk_control_score ?? 0}
          execution={execution_score ?? 0}
          arenaScore={arena_score ?? 0}
          size={120}
        />
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
