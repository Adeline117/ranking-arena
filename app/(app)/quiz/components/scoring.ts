/**
 * Trading Personality Quiz — Scoring algorithm
 *
 * Tallies weighted scores from all 15 answers,
 * produces primary + secondary type and a match percentage (60-99%).
 */

import type { PersonalityTypeId, QuizOption, QuizQuestion, QuizResult } from './types'
import { PERSONALITY_TYPES, QUIZ_QUESTIONS } from './quiz-data'

const ALL_TYPE_IDS: PersonalityTypeId[] = PERSONALITY_TYPES.map((t) => t.id)

/**
 * Calculate the maximum possible score for a given type across all questions.
 * For each question, take the option that gives the highest weight for that type.
 */
function getMaxPossibleScore(typeId: PersonalityTypeId, questions: QuizQuestion[]): number {
  let max = 0
  for (const q of questions) {
    let bestForType = 0
    for (const opt of q.options) {
      const w = opt.scores[typeId] ?? 0
      if (w > bestForType) bestForType = w
    }
    max += bestForType
  }
  return max
}

export function calculateResult(answers: Record<number, string>): QuizResult {
  const questions = QUIZ_QUESTIONS

  // Tally scores
  const scores: Record<PersonalityTypeId, number> = {
    sniper: 0,
    scalper: 0,
    whale: 0,
    analyst: 0,
    contrarian: 0,
    hodler: 0,
    degen: 0,
    strategist: 0,
  }

  for (const q of questions) {
    const selectedOptionId = answers[q.id]
    if (!selectedOptionId) continue
    const option = q.options.find((o) => o.id === selectedOptionId)
    if (!option) continue
    for (const [typeId, weight] of Object.entries(option.scores)) {
      scores[typeId as PersonalityTypeId] += weight as number
    }
  }

  // Sort types by score descending, tiebreak by ID alphabetically
  const sorted = ALL_TYPE_IDS.slice().sort((a, b) => {
    const diff = scores[b] - scores[a]
    if (diff !== 0) return diff
    return a.localeCompare(b)
  })

  const primaryType = sorted[0]
  const secondaryType = sorted[1]

  // Normalize match percentage to 60-99 range
  const maxPossible = getMaxPossibleScore(primaryType, questions)
  const rawRatio = maxPossible > 0 ? scores[primaryType] / maxPossible : 0.5
  const matchPercent = Math.round(60 + rawRatio * 39)

  return {
    primaryType,
    secondaryType,
    scores,
    matchPercent: Math.min(99, Math.max(60, matchPercent)),
  }
}
