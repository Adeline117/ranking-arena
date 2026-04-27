/**
 * Trading Personality Quiz — Zustand store
 *
 * Manages quiz progress (current question, answers, result).
 * Persisted to localStorage so progress survives tab refresh / app switch.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { QuizState } from '@/app/(app)/quiz/components/types'

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
      partialize: (state) => ({ answers: state.answers, currentQuestion: state.currentQuestion }),
    }
  )
)
