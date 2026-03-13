'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'

/**
 * 分数配色
 */
export function getScoreColor(score: number | null, max: number): string {
  if (score == null) return 'var(--color-text-tertiary)'
  const ratio = score / max
  if (ratio >= 0.7) return 'var(--color-accent-success)'
  if (ratio >= 0.4) return 'var(--color-accent-warning)'
  return 'var(--color-accent-error)'
}

export interface ScoreBarProps {
  label: string
  score: number | null
  maxScore: number
  isVisible?: boolean
  delay?: number
}

/**
 * 分数进度条
 */
export function ScoreBar({
  label,
  score,
  maxScore,
  delay = 0,
}: ScoreBarProps) {
  const color = getScoreColor(score, maxScore)
  // Cap display width at 100% but show indicator when over max
  const rawWidth = score != null ? (score / maxScore) * 100 : 0
  const clampedWidth = Math.min(rawWidth, 100)
  const isOverMax = score != null && score > maxScore

  // Use state-driven width with transition (avoids CSS animation class name collision
  // when switching periods — CSS @keyframes with same name don't re-run on value change)
  const [animatedWidth, setAnimatedWidth] = useState(0)
  useEffect(() => {
    // Reset to 0 first so the bar re-animates from scratch on every score change
    setAnimatedWidth(0)
    const timer = setTimeout(() => setAnimatedWidth(clampedWidth), Math.max(delay, 16))
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- delay is static per render; only re-animate on score change
  }, [clampedWidth])

  return (
    <Box>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <Text size="sm" color="secondary" weight="bold">{label}</Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="black" style={{ color, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            {score != null ? (isOverMax ? `>${maxScore}` : score.toFixed(1)) : '—'}
          </Text>
          <Text size="xs" color="tertiary">/ {maxScore}</Text>
        </Box>
      </Box>
      <Box
        style={{
          height: 6,
          background: 'var(--color-bg-hover, var(--color-bg-tertiary))',
          borderRadius: tokens.radius.full,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <Box
          style={{
            height: '100%',
            width: `${animatedWidth}%`,
            background: `linear-gradient(90deg, ${color}99 0%, ${color} 100%)`,
            borderRadius: tokens.radius.full,
            boxShadow: `0 0 8px ${color}40`,
            transition: `width 0.9s cubic-bezier(0.4, 0, 0.2, 1)`,
          }}
        />
      </Box>
    </Box>
  )
}
