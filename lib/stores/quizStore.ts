/**
 * Trading Personality Quiz — Zustand store
 *
 * Manages quiz progress (current question, answers, result).
 * Persisted to localStorage so progress survives tab refresh / app switch.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { QuizState } from '@/app/(quiz)/quiz/components/types'

// Bump this when question count or IDs change to auto-clear stale localStorage
const QUIZ_STORE_VERSION = 2

export const useQuizStore = create<QuizState>()(
  persist(
    (set) => ({
      currentQuestion: 0,
      answers: {},
      result: null,

      setAnswer: (questionId: number, optionId: string) =>
        set((state) => ({
          answers: { ...state.answers, [questionId]: optionId },
        })),

      goToQuestion: (n: number) => set({ currentQuestion: n }),

      setResult: (result) => set({ result }),

      reset: () => set({ currentQuestion: 0, answers: {}, result: null }),
    }),
    {
      name: 'arena-quiz-progress',
      version: QUIZ_STORE_VERSION,
      partialize: (state) => ({
        answers: state.answers,
        currentQuestion: state.currentQuestion,
        result: state.result,
      }),
      // When version changes, discard old data and start fresh
      migrate: () => ({
        currentQuestion: 0,
        answers: {},
        result: null,
      }),
    }
  )
)
