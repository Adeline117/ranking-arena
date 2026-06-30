'use client'

import { useRouter } from 'next/navigation'
import { useQuizStore } from '@/lib/stores/quizStore'

export default function QuizStartButton() {
  const router = useRouter()

  const handleStart = () => {
    // Reset if previously completed
    if (useQuizStore.getState().result) {
      useQuizStore.getState().reset()
    }
    router.push('/quiz/questions')
  }

  // Check if user has in-progress answers — show "Continue" instead
  const hasProgress =
    typeof window !== 'undefined' && Object.keys(useQuizStore.getState().answers).length > 0

  return (
    <button type="button" onClick={handleStart} className="quiz-start-btn">
      <span>{hasProgress ? 'Continue Quiz' : 'Start Test'}</span>
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </button>
  )
}
