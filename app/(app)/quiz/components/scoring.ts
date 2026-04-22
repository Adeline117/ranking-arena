/**
 * Trading Personality Quiz — Scoring algorithm
 *
 * Tallies weighted scores from all 30 answers, normalizes per-type,
 * applies softmax with temperature 1.5 for smooth probability distribution,
 * then produces primary + secondary type, match percentage (55-99%),
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

  // 3. Apply softmax with temperature 1.5
  const probabilities = softmax(normalized, 1.5)

  // 4. Primary = argmax, Secondary = second argmax
  const indexed = ALL_TYPE_IDS.map((id, i) => ({ id, prob: probabilities[i] }))
  indexed.sort((a, b) => {
    const diff = b.prob - a.prob
    if (diff !== 0) return diff
    return a.id.localeCompare(b.id)
  })

  const primaryType = indexed[0].id
  const secondaryType = indexed[1].id

  // 5. matchPercent = floor(55 + softmaxProb[primary] * 44), clamped [55, 99]
  const primaryProb = indexed[0].prob
  const matchPercent = Math.min(99, Math.max(55, Math.floor(55 + primaryProb * 44)))

  // 6. allTypePercents: softmax probabilities * 100, rounded to integers summing to 100
  const rawPercents = probabilities.map((p) => Math.round(p * 100))
  let currentSum = rawPercents.reduce((a, b) => a + b, 0)

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
