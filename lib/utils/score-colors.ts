/**
 * Shared score color grading utility
 * 5-tier color system for arena_score display
 *
 * SINGLE SOURCE OF TRUTH: CSS variables (--color-score-*) in globals.css.
 * All alpha/gradient variants derived via color-mix() — no hex duplication.
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

const SCORE_TIERS: { min: number; cssVar: string; grade: ScoreGrade; label: string }[] = [
  { min: 90, cssVar: 'var(--color-score-legendary)', grade: 'legendary', label: 'Legendary' },
  { min: 70, cssVar: 'var(--color-score-great)', grade: 'great', label: 'Great' },
  { min: 50, cssVar: 'var(--color-score-average)', grade: 'average', label: 'Average' },
  { min: 30, cssVar: 'var(--color-score-below)', grade: 'below', label: 'Below Avg' },
  { min: 0, cssVar: 'var(--color-score-low)', grade: 'low', label: 'Low' },
]

function getTier(score: number) {
  return SCORE_TIERS.find((t) => score >= t.min) || SCORE_TIERS[SCORE_TIERS.length - 1]
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
 * Returns the score color at a given opacity via color-mix().
 * Replaces getScoreColorHex() + hex-alpha concatenation pattern.
 *
 * Usage: scoreColorAlpha(85, 25) => "color-mix(in srgb, var(--color-score-great) 25%, transparent)"
 */
export function scoreColorAlpha(score: number, percent: number): string {
  return `color-mix(in srgb, ${getScoreColor(score)} ${percent}%, transparent)`
}

/** Returns full color info including gradients for badges — all derived from CSS variables */
export function getScoreColorInfo(score: number): ScoreColorInfo {
  const tier = getTier(score)
  const v = tier.cssVar

  return {
    color: v,
    grade: tier.grade,
    label: tier.label,
    bgGradient: `linear-gradient(135deg, color-mix(in srgb, ${v} 18%, transparent), color-mix(in srgb, ${v} 10%, transparent))`,
    borderColor: `color-mix(in srgb, ${v} 55%, transparent)`,
    fillColor: `color-mix(in srgb, ${v} 15%, transparent)`,
  }
}
