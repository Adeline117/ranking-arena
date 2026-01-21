'use client'

import { useState, useEffect, useCallback, useRef, createContext, useContext, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronRight, ChevronLeft, Check } from 'lucide-react'
import { tokens } from '@/lib/design-tokens'

// ============================================
// 类型定义
// ============================================

interface TourStep {
  /** 目标元素的选择器 */
  target: string
  /** 标题 */
  title: string
  /** 内容描述 */
  content: string
  /** 提示位置 */
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** 高亮区域的内边距 */
  padding?: number
  /** 是否显示跳过按钮 */
  showSkip?: boolean
  /** 自定义操作按钮 */
  action?: {
    label: string
    onClick: () => void
  }
}

interface TourContextValue {
  /** 开始引导 */
  startTour: (steps: TourStep[]) => void
  /** 结束引导 */
  endTour: () => void
  /** 当前是否在引导中 */
  isActive: boolean
  /** 当前步骤 */
  currentStep: number
}

// ============================================
// Context
// ============================================

const TourContext = createContext<TourContextValue | null>(null)

export function useTour() {
  const context = useContext(TourContext)
  if (!context) {
    throw new Error('useTour must be used within TourProvider')
  }
  return context
}

// ============================================
// 工具函数
// ============================================

function getElementPosition(selector: string) {
  const element = document.querySelector(selector)
  if (!element) return null

  const rect = element.getBoundingClientRect()
  return {
    top: rect.top + window.scrollY,
    left: rect.left + window.scrollX,
    width: rect.width,
    height: rect.height,
    element,
  }
}

function calculateTooltipPosition(
  targetRect: { top: number; left: number; width: number; height: number },
  placement: 'top' | 'bottom' | 'left' | 'right',
  tooltipSize: { width: number; height: number }
) {
  const padding = 12
  const arrowSize = 8

  switch (placement) {
    case 'top':
      return {
        top: targetRect.top - tooltipSize.height - arrowSize - padding,
        left: targetRect.left + targetRect.width / 2 - tooltipSize.width / 2,
      }
    case 'bottom':
      return {
        top: targetRect.top + targetRect.height + arrowSize + padding,
        left: targetRect.left + targetRect.width / 2 - tooltipSize.width / 2,
      }
    case 'left':
      return {
        top: targetRect.top + targetRect.height / 2 - tooltipSize.height / 2,
        left: targetRect.left - tooltipSize.width - arrowSize - padding,
      }
    case 'right':
      return {
        top: targetRect.top + targetRect.height / 2 - tooltipSize.height / 2,
        left: targetRect.left + targetRect.width + arrowSize + padding,
      }
  }
}

// ============================================
// 高亮遮罩组件
// ============================================

function Spotlight({
  targetRect,
  padding = 8,
}: {
  targetRect: { top: number; left: number; width: number; height: number }
  padding?: number
}) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 9998,
      }}
    >
      {/* 四个遮罩区域 */}
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        <defs>
          <mask id="spotlight-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={targetRect.left - padding}
              y={targetRect.top - padding - window.scrollY}
              width={targetRect.width + padding * 2}
              height={targetRect.height + padding * 2}
              rx="8"
              fill="black"
            />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.7)"
          mask="url(#spotlight-mask)"
        />
      </svg>

      {/* 高亮边框 */}
      <div
        style={{
          position: 'absolute',
          top: targetRect.top - padding - window.scrollY,
          left: targetRect.left - padding,
          width: targetRect.width + padding * 2,
          height: targetRect.height + padding * 2,
          borderRadius: 8,
          border: '2px solid var(--color-brand)',
          boxShadow: '0 0 0 4px rgba(139, 111, 168, 0.3)',
          transition: 'all 0.3s ease',
        }}
      />
    </div>
  )
}

// ============================================
// 提示卡片组件
// ============================================

function TooltipCard({
  step,
  stepIndex,
  totalSteps,
  onPrev,
  onNext,
  onSkip,
  onClose,
  position,
  placement,
}: {
  step: TourStep
  stepIndex: number
  totalSteps: number
  onPrev: () => void
  onNext: () => void
  onSkip: () => void
  onClose: () => void
  position: { top: number; left: number }
  placement: 'top' | 'bottom' | 'left' | 'right'
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const isLastStep = stepIndex === totalSteps - 1
  const isFirstStep = stepIndex === 0

  // 箭头方向
  const arrowStyles: Record<string, React.CSSProperties> = {
    top: {
      bottom: -8,
      left: '50%',
      transform: 'translateX(-50%) rotate(45deg)',
    },
    bottom: {
      top: -8,
      left: '50%',
      transform: 'translateX(-50%) rotate(45deg)',
    },
    left: {
      right: -8,
      top: '50%',
      transform: 'translateY(-50%) rotate(45deg)',
    },
    right: {
      left: -8,
      top: '50%',
      transform: 'translateY(-50%) rotate(45deg)',
    },
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-labelledby="tour-title"
      aria-describedby="tour-content"
      style={{
        position: 'absolute',
        top: position.top,
        left: position.left,
        width: 320,
        background: 'var(--color-bg-secondary)',
        borderRadius: 12,
        border: '1px solid var(--color-border-primary)',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
        zIndex: tokens.zIndex.tooltip, // 使用 design tokens (600)
        animation: 'fadeIn 0.2s ease',
      }}
    >
      {/* 箭头 */}
      <div
        style={{
          position: 'absolute',
          width: 16,
          height: 16,
          background: 'var(--color-bg-secondary)',
          borderTop: placement === 'bottom' || placement === 'right' ? '1px solid var(--color-border-primary)' : 'none',
          borderLeft: placement === 'bottom' || placement === 'right' ? '1px solid var(--color-border-primary)' : 'none',
          borderBottom: placement === 'top' || placement === 'left' ? '1px solid var(--color-border-primary)' : 'none',
          borderRight: placement === 'top' || placement === 'left' ? '1px solid var(--color-border-primary)' : 'none',
          ...arrowStyles[placement],
        }}
      />

      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        aria-label="关闭引导"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
        }}
      >
        <X size={16} />
      </button>

      {/* 内容区域 */}
      <div style={{ padding: 20 }}>
        {/* 步骤指示器 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginBottom: 12,
        }}>
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              style={{
                width: i === stepIndex ? 16 : 6,
                height: 6,
                borderRadius: 3,
                background: i === stepIndex
                  ? 'var(--color-brand)'
                  : i < stepIndex
                    ? 'var(--color-brand)'
                    : 'var(--color-border-secondary)',
                opacity: i < stepIndex ? 0.5 : 1,
                transition: 'all 0.2s ease',
              }}
            />
          ))}
          <span style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--color-text-tertiary)',
          }}>
            {stepIndex + 1} / {totalSteps}
          </span>
        </div>

        {/* 标题 */}
        <h3
          id="tour-title"
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            marginBottom: 8,
          }}
        >
          {step.title}
        </h3>

        {/* 内容 */}
        <p
          id="tour-content"
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            color: 'var(--color-text-secondary)',
            marginBottom: 20,
          }}
        >
          {step.content}
        </p>

        {/* 操作按钮 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          {step.showSkip !== false && (
            <button
              onClick={onSkip}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-tertiary)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              跳过
            </button>
          )}

          <div style={{ flex: 1 }} />

          {!isFirstStep && (
            <button
              onClick={onPrev}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--color-border-primary)',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <ChevronLeft size={16} />
              上一步
            </button>
          )}

          <button
            onClick={step.action ? step.action.onClick : onNext}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--color-brand)',
              color: 'white',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {step.action?.label || (isLastStep ? (
              <>
                完成
                <Check size={16} />
              </>
            ) : (
              <>
                下一步
                <ChevronRight size={16} />
              </>
            ))}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Provider 组件
// ============================================

export function TourProvider({ children }: { children: ReactNode }) {
  const [steps, setSteps] = useState<TourStep[]>([])
  const [currentStep, setCurrentStep] = useState(0)
  const [isActive, setIsActive] = useState(false)
  const [targetRect, setTargetRect] = useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 })
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // 更新目标位置
  useEffect(() => {
    if (!isActive || !steps[currentStep]) return

    const updatePosition = () => {
      const pos = getElementPosition(steps[currentStep].target)
      if (pos) {
        setTargetRect({
          top: pos.top,
          left: pos.left,
          width: pos.width,
          height: pos.height,
        })

        // 计算 tooltip 位置
        const placement = steps[currentStep].placement || 'bottom'
        const tooltipPos = calculateTooltipPosition(
          { top: pos.top, left: pos.left, width: pos.width, height: pos.height },
          placement,
          { width: 320, height: 200 }
        )
        setTooltipPosition(tooltipPos)

        // 滚动到目标元素
        pos.element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }

    updatePosition()

    // 监听窗口变化
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition)
    }
  }, [isActive, currentStep, steps])

  const startTour = useCallback((newSteps: TourStep[]) => {
    setSteps(newSteps)
    setCurrentStep(0)
    setIsActive(true)
  }, [])

  const endTour = useCallback(() => {
    setIsActive(false)
    setSteps([])
    setCurrentStep(0)
    setTargetRect(null)

    // 标记已完成引导
    localStorage.setItem('tour_completed', 'true')
  }, [])

  const nextStep = useCallback(() => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(prev => prev + 1)
    } else {
      endTour()
    }
  }, [currentStep, steps.length, endTour])

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1)
    }
  }, [currentStep])

  const step = steps[currentStep]
  const placement = step?.placement || 'bottom'

  return (
    <TourContext.Provider value={{ startTour, endTour, isActive, currentStep }}>
      {children}

      {mounted && isActive && targetRect && step && createPortal(
        <>
          {/* 点击遮罩关闭 */}
          <div
            onClick={endTour}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9997,
            }}
          />

          {/* 高亮遮罩 */}
          <Spotlight targetRect={targetRect} padding={step.padding} />

          {/* 提示卡片 */}
          <TooltipCard
            step={step}
            stepIndex={currentStep}
            totalSteps={steps.length}
            onPrev={prevStep}
            onNext={nextStep}
            onSkip={endTour}
            onClose={endTour}
            position={tooltipPosition}
            placement={placement}
          />
        </>,
        document.body
      )}
    </TourContext.Provider>
  )
}

// ============================================
// 预定义的引导步骤
// ============================================

export const HOME_TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="ranking-table"]',
    title: '交易员排行榜',
    content: '这里展示了各交易所的顶级交易员。你可以查看他们的 ROI、胜率和风险指标。',
    placement: 'right',
  },
  {
    target: '[data-tour="time-filter"]',
    title: '时间范围筛选',
    content: '切换不同的时间范围（7天、30天、90天等）来查看交易员在不同周期的表现。',
    placement: 'bottom',
  },
  {
    target: '[data-tour="exchange-filter"]',
    title: '交易所筛选',
    content: '选择特定交易所来筛选交易员，支持 Binance、Bybit、Bitget 等。',
    placement: 'bottom',
  },
  {
    target: '[data-tour="search"]',
    title: '搜索功能',
    content: '输入交易员名称快速搜索，支持模糊匹配。',
    placement: 'bottom',
  },
  {
    target: '[data-tour="follow-button"]',
    title: '关注交易员',
    content: '点击关注按钮，你将在首页看到该交易员的最新动态和表现变化。',
    placement: 'left',
  },
]

export const TRADER_DETAIL_TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="trader-stats"]',
    title: '交易员统计',
    content: '查看交易员的核心指标：ROI、总盈亏、最大回撤和胜率。',
    placement: 'bottom',
  },
  {
    target: '[data-tour="equity-curve"]',
    title: '权益曲线',
    content: '权益曲线展示了交易员的资金变化趋势，帮助你了解其稳定性。',
    placement: 'top',
  },
  {
    target: '[data-tour="positions"]',
    title: '当前持仓',
    content: '实时查看交易员的当前持仓情况。',
    placement: 'top',
  },
]

export default TourProvider
