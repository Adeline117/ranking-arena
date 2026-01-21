'use client'

import { useEffect, useRef, ReactNode } from 'react'

// ============================================
// Skip Link 组件
// ============================================

/**
 * Skip Link - 跳过导航直接进入主内容
 * 对屏幕阅读器用户和键盘导航非常有用
 */
export function SkipLink({
  targetId = 'main-content',
  children = '跳转到主要内容',
}: {
  targetId?: string
  children?: ReactNode
}) {
  return (
    <a
      href={`#${targetId}`}
      className="skip-link"
      style={{
        position: 'fixed',
        top: -100,
        left: 16,
        zIndex: 9999,
        padding: '12px 24px',
        background: 'var(--color-brand)',
        color: '#fff',
        borderRadius: 8,
        textDecoration: 'none',
        fontWeight: 600,
        fontSize: 14,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        transition: 'top 0.2s ease',
      }}
      onFocus={(e) => {
        e.currentTarget.style.top = '16px'
      }}
      onBlur={(e) => {
        e.currentTarget.style.top = '-100px'
      }}
    >
      {children}
    </a>
  )
}

// ============================================
// 焦点陷阱组件
// ============================================

/**
 * Focus Trap - 将焦点限制在容器内
 * 用于模态框、对话框等
 */
export function FocusTrap({
  children,
  active = true,
  returnFocusOnDeactivate = true,
}: {
  children: ReactNode
  active?: boolean
  returnFocusOnDeactivate?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const previousActiveElement = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return

    // 保存之前的焦点元素
    previousActiveElement.current = document.activeElement as HTMLElement

    const container = containerRef.current
    if (!container) return

    // 获取所有可聚焦元素
    const getFocusableElements = () => {
      return container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    }

    // 聚焦到第一个可聚焦元素
    const focusableElements = getFocusableElements()
    if (focusableElements.length > 0) {
      focusableElements[0].focus()
    }

    // 处理 Tab 键
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      const focusableElements = getFocusableElements()
      if (focusableElements.length === 0) return

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      // Shift + Tab 在第一个元素时跳到最后一个
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault()
        lastElement.focus()
      }
      // Tab 在最后一个元素时跳到第一个
      else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault()
        firstElement.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)

      // 恢复之前的焦点
      if (returnFocusOnDeactivate && previousActiveElement.current) {
        previousActiveElement.current.focus()
      }
    }
  }, [active, returnFocusOnDeactivate])

  return (
    <div ref={containerRef} data-focus-trap={active ? 'active' : 'inactive'}>
      {children}
    </div>
  )
}

// ============================================
// 屏幕阅读器专用文本
// ============================================

/**
 * VisuallyHidden - 仅对屏幕阅读器可见的文本
 */
export function VisuallyHidden({
  children,
  as: Component = 'span',
}: {
  children: ReactNode
  as?: 'span' | 'div' | 'p'
}) {
  return (
    <Component
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {children}
    </Component>
  )
}

// ============================================
// 实时区域公告
// ============================================

/**
 * LiveRegion - 向屏幕阅读器发送实时公告
 */
export function LiveRegion({
  message,
  politeness = 'polite',
}: {
  message: string
  politeness?: 'polite' | 'assertive' | 'off'
}) {
  return (
    <div
      role="status"
      aria-live={politeness}
      aria-atomic="true"
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {message}
    </div>
  )
}

// ============================================
// 可访问性 Hook
// ============================================

/**
 * useAnnounce - 用于向屏幕阅读器发送公告
 */
export function useAnnounce() {
  const announce = (message: string, politeness: 'polite' | 'assertive' = 'polite') => {
    // 创建临时元素发送公告
    const el = document.createElement('div')
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', politeness)
    el.setAttribute('aria-atomic', 'true')
    el.style.cssText = `
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    `

    document.body.appendChild(el)

    // 延迟设置内容以确保屏幕阅读器能捕获
    setTimeout(() => {
      el.textContent = message
    }, 100)

    // 清理
    setTimeout(() => {
      document.body.removeChild(el)
    }, 1000)
  }

  return { announce }
}

/**
 * useReducedMotion - 检测用户是否偏好减少动画
 */
export function useReducedMotion(): boolean {
  const mediaQuery =
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null

  return mediaQuery?.matches ?? false
}

/**
 * useKeyboardNavigation - 处理键盘导航
 */
export function useKeyboardNavigation(options: {
  onEnter?: () => void
  onEscape?: () => void
  onArrowUp?: () => void
  onArrowDown?: () => void
  onArrowLeft?: () => void
  onArrowRight?: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Enter':
          options.onEnter?.()
          break
        case 'Escape':
          options.onEscape?.()
          break
        case 'ArrowUp':
          options.onArrowUp?.()
          break
        case 'ArrowDown':
          options.onArrowDown?.()
          break
        case 'ArrowLeft':
          options.onArrowLeft?.()
          break
        case 'ArrowRight':
          options.onArrowRight?.()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [options])
}

// ============================================
// 可访问的按钮 props
// ============================================

/**
 * 为按钮生成可访问性 props
 */
export function getButtonA11yProps(options: {
  label: string
  description?: string
  pressed?: boolean
  expanded?: boolean
  controls?: string
  disabled?: boolean
}) {
  return {
    'aria-label': options.label,
    'aria-describedby': options.description,
    'aria-pressed': options.pressed,
    'aria-expanded': options.expanded,
    'aria-controls': options.controls,
    'aria-disabled': options.disabled,
    tabIndex: options.disabled ? -1 : 0,
  }
}

// ============================================
// 颜色对比度辅助
// ============================================

/**
 * 检查颜色对比度是否符合 WCAG 标准
 */
export function checkColorContrast(
  foreground: string,
  background: string
): { ratio: number; passesAA: boolean; passesAAA: boolean } {
  // 简化的对比度计算（实际应使用完整的 WCAG 算法）
  const getLuminance = (hex: string): number => {
    const rgb = parseInt(hex.slice(1), 16)
    const r = ((rgb >> 16) & 0xff) / 255
    const g = ((rgb >> 8) & 0xff) / 255
    const b = (rgb & 0xff) / 255

    const [rs, gs, bs] = [r, g, b].map((c) =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    )

    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
  }

  const l1 = getLuminance(foreground)
  const l2 = getLuminance(background)
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

  return {
    ratio: Math.round(ratio * 100) / 100,
    passesAA: ratio >= 4.5,
    passesAAA: ratio >= 7,
  }
}

export default {
  SkipLink,
  FocusTrap,
  VisuallyHidden,
  LiveRegion,
  useAnnounce,
  useReducedMotion,
  useKeyboardNavigation,
  getButtonA11yProps,
  checkColorContrast,
}
