/**
 * Trading Personality Quiz — Scoring algorithm
 *
 * Tallies weighted scores from all 15 answers, normalizes per-type,
 * applies softmax with temperature 0.8 for peaked probability distribution,
 * then produces primary + secondary type, match percentage (62-97%),
 * and allTypePercents (summing to 100).
 */

import type { PersonalityTypeId, QuizQuestion, QuizResult } from './types'
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

/**
 * Softmax with temperature for smooth probability distribution.
 * Higher temperature → flatter distribution; lower → more peaked.
 * Uses max-subtraction for numerical stability.
 */
function softmax(values: number[], temperature: number = 1.5): number[] {
  const scaled = values.map((v) => v / temperature)
  const maxVal = Math.max(...scaled)
  const exps = scaled.map((s) => Math.exp(s - maxVal))
  const sumExps = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sumExps)
}

export function calculateResult(answers: Record<number, string>): QuizResult {
  const questions = QUIZ_QUESTIONS

  // 1. Tally raw scores for all 12 types
  const scores: Record<PersonalityTypeId, number> = {
    sniper: 0,
    scalper: 0,
    whale: 0,
    analyst: 0,
    contrarian: 0,
    hodler: 0,
    degen: 0,
    strategist: 0,
    copycat: 0,
    tourist: 0,
    paperhands: 0,
    narrator: 0,
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

  // 2. Normalize each type: normalized[i] = rawScore[i] / maxPossible[i]
  const normalized = ALL_TYPE_IDS.map((typeId) => {
    const maxPossible = getMaxPossibleScore(typeId, questions)
    return maxPossible > 0 ? scores[typeId] / maxPossible : 0
  })

  // 3. Apply softmax with temperature 0.8 (lower = more peaked, primary type stands out)
  const probabilities = softmax(normalized, 0.8)

  // 4. Primary = argmax, Secondary = second argmax
  const indexed = ALL_TYPE_IDS.map((id, i) => ({ id, prob: probabilities[i] }))
  indexed.sort((a, b) => {
    const diff = b.prob - a.prob
    if (diff !== 0) return diff
    return a.id.localeCompare(b.id)
  })

  const primaryType = indexed[0].id
  const secondaryType = indexed[1].id

  // 5. matchPercent — map softmax probability to a meaningful 62-97% range
  // With 12 types, uniform = 8.3%, strong primary ≈ 19%. Map [0.083, 0.20] → [62, 97].
  const primaryProb = indexed[0].prob
  const minProb = 1 / ALL_TYPE_IDS.length // ~0.0833
  const maxProb = 0.22 // practical ceiling
  const t = Math.min(1, Math.max(0, (primaryProb - minProb) / (maxProb - minProb)))
  const matchPercent = Math.min(97, Math.max(62, Math.round(62 + t * 35)))

  // 6. allTypePercents: softmax probabilities * 100, rounded to integers summing to 100
  const rawPercents = probabilities.map((p) => Math.round(p * 100))
  const currentSum = rawPercents.reduce((a, b) => a + b, 0)

  // Adjust the largest value so the total sums to exactly 100
  if (currentSum !== 100) {
    let largestIdx = 0
    for (let i = 1; i < rawPercents.length; i++) {
      if (rawPercents[i] > rawPercents[largestIdx]) largestIdx = i
    }
    rawPercents[largestIdx] += 100 - currentSum
  }

  const allTypePercents = {} as Record<PersonalityTypeId, number>
  ALL_TYPE_IDS.forEach((id, i) => {
    allTypePercents[id] = rawPercents[i]
  })

  return {
    primaryType,
    secondaryType,
    scores,
    matchPercent,
    allTypePercents,
  }
}
