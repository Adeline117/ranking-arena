/**
 * Trading Personality Quiz — Zustand store
 *
 * Manages quiz progress (current question, answers, result).
 * State is ephemeral — not persisted to localStorage.
 */

import { create } from 'zustand'
import type { QuizResult, QuizState } from '@/app/(app)/quiz/components/types'

export const useQuizStore = create<QuizState>((set) => ({
  currentQuestion: 0,
  answers: {},
  result: null,

  setAnswer: (questionId: number, optionId: string) =>
    set((state) => ({
      answers: { ...state.answers, [questionId]: optionId },
    })),

  goToQuestion: (n: number) => set({ currentQuestion: n }),

  goBack: () =>
    set((state) => ({
      currentQuestion: Math.max(0, state.currentQuestion - 1),
    })),

  setResult: (result: QuizResult) => set({ result }),

  reset: () => set({ currentQuestion: 0, answers: {}, result: null }),
}))
