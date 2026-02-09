/**
 * Shared score color grading utility
 * 5-tier color system for arena_score display
 * Uses CSS variables for theme support
 */

export type ScoreGrade = 'legendary' | 'great' | 'average' | 'below' | 'low'

export interface ScoreColorInfo {
  color: string
  grade: ScoreGrade
  label: string
  bgGradient: string
  borderColor: string
  fillColor: string
}

const SCORE_TIERS: { min: number; cssVar: string; fallback: string; grade: ScoreGrade; label: string }[] = [
  { min: 90, cssVar: 'var(--color-score-legendary)', fallback: '#8b5cf6', grade: 'legendary', label: 'Legendary' },
  { min: 70, cssVar: 'var(--color-score-great)', fallback: '#10b981', grade: 'great', label: 'Great' },
  { min: 50, cssVar: 'var(--color-score-average)', fallback: '#eab308', grade: 'average', label: 'Average' },
  { min: 30, cssVar: 'var(--color-score-below)', fallback: '#f97316', grade: 'below', label: 'Below Avg' },
  { min: 0, cssVar: 'var(--color-score-low)', fallback: '#ef4444', grade: 'low', label: 'Low' },
]

function getTier(score: number) {
  return SCORE_TIERS.find(t => score >= t.min) || SCORE_TIERS[SCORE_TIERS.length - 1]
}

/** Returns the CSS variable color for a given score (theme-aware) */
export function getScoreColor(score: number): string {
  return getTier(score).cssVar
}

/** Returns the grade tier name for a given score */
export function getScoreGrade(score: number): ScoreGrade {
  return getTier(score).grade
}

/**
 * Returns the resolved hex fallback for contexts that need raw hex
 * (e.g. canvas drawing, rgba computation). Prefer getScoreColor() for CSS.
 */
export function getScoreColorHex(score: number): string {
  return getTier(score).fallback
}

/** Returns full color info including gradients for badges */
export function getScoreColorInfo(score: number): ScoreColorInfo {
  const tier = getTier(score)
  const c = tier.fallback

  // Parse hex to rgba components
  const r = parseInt(c.slice(1, 3), 16)
  const g = parseInt(c.slice(3, 5), 16)
  const b = parseInt(c.slice(5, 7), 16)

  return {
    color: tier.cssVar,
    grade: tier.grade,
    label: tier.label,
    bgGradient: `linear-gradient(135deg, rgba(${r},${g},${b},0.18), rgba(${r},${g},${b},0.10))`,
    borderColor: `rgba(${r},${g},${b},0.55)`,
    fillColor: `rgba(${r},${g},${b},0.15)`,
  }
}
