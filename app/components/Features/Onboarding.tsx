'use client'

import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

// ============================================
// 3 步引导内容
// ============================================

const ONBOARDING_STEPS = [
  {
    id: 'ranking',
    title: '发现顶级交易员',
    description: '浏览多个交易所的实盘交易员排行榜，按 ROI、胜率、回撤等多维度筛选，找到适合你的交易策略。',
    illustration: (
      <div className="flex items-center justify-center gap-2 py-6">
        <div className="w-12 h-16 bg-gradient-to-t from-[var(--color-accent-primary)] to-[var(--color-accent-primary)]/50 rounded" />
        <div className="w-12 h-24 bg-gradient-to-t from-[var(--color-success)] to-[var(--color-success)]/50 rounded" />
        <div className="w-12 h-20 bg-gradient-to-t from-[var(--color-warning)] to-[var(--color-warning)]/50 rounded" />
      </div>
    ),
  },
  {
    id: 'follow',
    title: '关注感兴趣的交易员',
    description: '点击交易员查看详细的历史业绩、持仓组合和交易风格，关注你看好的交易员，随时追踪动态。',
    illustration: (
      <div className="flex items-center justify-center py-6">
        <div className="relative">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[var(--color-accent-primary)] to-purple-600 flex items-center justify-center text-lg font-bold text-white">
            T
          </div>
          <div className="absolute -right-1 -bottom-1 w-6 h-6 bg-[var(--color-success)] rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>
      </div>
    ),
  },
  {
    id: 'community',
    title: '加入交易社区',
    description: '与其他投资者交流观点，参与讨论，分享你的交易心得。还可以绑定自己的交易所账户参与排名！',
    illustration: (
      <div className="flex items-center justify-center gap-3 py-6">
        <div className="w-10 h-10 rounded-full bg-blue-500/30 flex items-center justify-center text-sm font-bold text-blue-400">1</div>
        <div className="w-12 h-12 rounded-full bg-[var(--color-accent-primary)]/30 flex items-center justify-center text-base font-bold text-[var(--color-accent-primary)]">2</div>
        <div className="w-10 h-10 rounded-full bg-green-500/30 flex items-center justify-center text-sm font-bold text-green-400">3</div>
      </div>
    ),
  },
]

// ============================================
// 主组件
// ============================================

interface OnboardingProps {
  onComplete?: () => void
  storageKey?: string
}

export function Onboarding({ 
  onComplete,
  storageKey = 'ranking-arena-onboarding-v2'
}: OnboardingProps) {
  const [isActive, setIsActive] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [mounted, setMounted] = useState(false)

  // 检查是否需要显示引导
  useEffect(() => {
    setMounted(true)
    const hasCompleted = localStorage.getItem(storageKey)
    if (!hasCompleted) {
      const timer = setTimeout(() => setIsActive(true), 800)
      return () => clearTimeout(timer)
    }
  }, [storageKey])

  const handleNext = useCallback(() => {
    if (currentStep < ONBOARDING_STEPS.length - 1) {
      setCurrentStep(prev => prev + 1)
    } else {
      handleComplete()
    }
  }, [currentStep])

  const handleComplete = useCallback(() => {
    localStorage.setItem(storageKey, 'true')
    setIsActive(false)
    onComplete?.()
  }, [storageKey, onComplete])

  const handleSkip = useCallback(() => {
    localStorage.setItem(storageKey, 'true')
    setIsActive(false)
  }, [storageKey])

  // 键盘导航
  useEffect(() => {
    if (!isActive) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'ArrowRight') handleNext()
      if (e.key === 'Escape') handleSkip()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, handleNext, handleSkip])

  if (!mounted || !isActive) return null

  const step = ONBOARDING_STEPS[currentStep]
  const isLastStep = currentStep === ONBOARDING_STEPS.length - 1

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* 背景 */}
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={handleSkip}
      />

      {/* 卡片 */}
      <div className="relative w-full max-w-sm bg-[var(--color-bg-secondary)] rounded-2xl overflow-hidden shadow-2xl animate-[scaleIn_0.3s_ease-out]">
        {/* 进度条 */}
        <div className="h-1 bg-[var(--color-bg-tertiary)]">
          <div 
            className="h-full bg-[var(--color-accent-primary)] transition-all duration-300"
            style={{ width: `${((currentStep + 1) / ONBOARDING_STEPS.length) * 100}%` }}
          />
        </div>

        {/* 跳过按钮 */}
        <button
          onClick={handleSkip}
          className="absolute top-4 right-4 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors z-10"
        >
          跳过
        </button>

        {/* 内容 */}
        <div className="p-6 pt-8">
          {/* 插图 */}
          {step.illustration}

          {/* 步骤指示 */}
          <div className="flex items-center justify-center gap-1.5 mb-4">
            {ONBOARDING_STEPS.map((_, idx) => (
              <div
                key={idx}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  idx === currentStep
                    ? 'w-6 bg-[var(--color-accent-primary)]'
                    : idx < currentStep
                      ? 'w-1.5 bg-[var(--color-accent-primary)]/50'
                      : 'w-1.5 bg-[var(--color-bg-tertiary)]'
                }`}
              />
            ))}
          </div>

          {/* 标题 */}
          <h2 className="text-xl font-bold text-center text-[var(--color-text-primary)] mb-2">
            {step.title}
          </h2>

          {/* 描述 */}
          <p className="text-sm text-[var(--color-text-secondary)] text-center leading-relaxed mb-6">
            {step.description}
          </p>

          {/* 按钮 */}
          <button
            onClick={handleNext}
            className="w-full py-3 bg-[var(--color-accent-primary)] text-white rounded-xl font-semibold hover:bg-[var(--color-accent-primary)]/90 transition-all duration-200 active:scale-[0.98]"
          >
            {isLastStep ? '开始探索' : '下一步'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ============================================
// 重新触发引导 Hook
// ============================================

export function useOnboarding(storageKey = 'ranking-arena-onboarding-v2') {
  const resetOnboarding = useCallback(() => {
    localStorage.removeItem(storageKey)
    window.location.reload()
  }, [storageKey])

  return { resetOnboarding }
}

export default Onboarding
