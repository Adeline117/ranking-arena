'use client'

/**
 * 可访问性 React Hooks
 * 提供 ARIA 属性、焦点管理和辅助功能
 */

import { useRef, useEffect, useCallback, useState, RefObject } from 'react'

// ============================================
// 类型定义
// ============================================

export interface UseAccessibleDescriptionOptions {
  /** 描述文本 */
  description: string
  /** 描述 ID（自动生成） */
  id?: string
}

export interface UseFocusTrapOptions {
  /** 是否启用焦点陷阱 */
  enabled?: boolean
  /** 初始焦点元素选择器 */
  initialFocus?: string
  /** 返回焦点的元素 */
  returnFocus?: boolean
  /** 自动聚焦到第一个可聚焦元素 */
  autoFocus?: boolean
}

export interface UseAriaLiveOptions {
  /** 实时区域类型 */
  ariaLive?: 'polite' | 'assertive' | 'off'
  /** 是否原子更新 */
  atomic?: boolean
  /** 相关区域 */
  relevant?: 'additions' | 'removals' | 'text' | 'all'
}

// ============================================
// 可聚焦元素选择器
// ============================================

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ')

// ============================================
// Hooks
// ============================================

/**
 * 获取可访问的描述属性
 */
export function useAccessibleDescription(options: UseAccessibleDescriptionOptions) {
  const id = options.id || `desc-${Math.random().toString(36).slice(2, 9)}`

  return {
    /** 绑定到被描述元素的属性 */
    describedBy: {
      'aria-describedby': id,
    },
    /** 绑定到描述元素的属性 */
    descriptionProps: {
      id,
      style: { display: 'none' } as const,
      children: options.description,
    },
  }
}

/**
 * 焦点陷阱 Hook
 * 用于模态框、下拉菜单等需要限制焦点范围的场景
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  options: UseFocusTrapOptions = {}
): RefObject<T | null> {
  const {
    enabled = true,
    initialFocus,
    returnFocus = true,
    autoFocus = true,
  } = options

  const containerRef = useRef<T>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!enabled || !containerRef.current) return

    // 保存当前焦点
    previousFocusRef.current = document.activeElement as HTMLElement

    const container = containerRef.current
    const focusableElements = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    const firstFocusable = focusableElements[0]
    const lastFocusable = focusableElements[focusableElements.length - 1]

    // 自动聚焦
    if (autoFocus) {
      if (initialFocus) {
        const initial = container.querySelector<HTMLElement>(initialFocus)
        initial?.focus()
      } else {
        firstFocusable?.focus()
      }
    }

    // 处理 Tab 键导航
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      if (focusableElements.length === 0) {
        e.preventDefault()
        return
      }

      if (e.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstFocusable) {
          e.preventDefault()
          lastFocusable?.focus()
        }
      } else {
        // Tab
        if (document.activeElement === lastFocusable) {
          e.preventDefault()
          firstFocusable?.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      
      // 恢复焦点
      if (returnFocus && previousFocusRef.current) {
        previousFocusRef.current.focus()
      }
    }
  }, [enabled, initialFocus, returnFocus, autoFocus])

  return containerRef
}

/**
 * ARIA 实时区域 Hook
 * 用于屏幕阅读器的动态内容通知
 */
export function useAriaLive(options: UseAriaLiveOptions = {}) {
  const {
    ariaLive = 'polite',
    atomic = true,
    relevant = 'additions text',
  } = options

  const [message, setMessage] = useState('')
  const announcerRef = useRef<HTMLDivElement>(null)

  const announce = useCallback((text: string, priority: 'polite' | 'assertive' = ariaLive === 'off' ? 'polite' : ariaLive) => {
    // 先清空，确保重复消息也能被读取
    setMessage('')
    
    // 使用 setTimeout 确保 DOM 更新
    setTimeout(() => {
      setMessage(text)
      
      // 如果需要更高优先级，临时修改 aria-live
      if (announcerRef.current && priority === 'assertive') {
        announcerRef.current.setAttribute('aria-live', 'assertive')
        setTimeout(() => {
          announcerRef.current?.setAttribute('aria-live', ariaLive)
        }, 100)
      }
    }, 50)
  }, [ariaLive])

  const announcerProps = {
    ref: announcerRef,
    role: 'status' as const,
    'aria-live': ariaLive,
    'aria-atomic': atomic,
    'aria-relevant': relevant,
    style: {
      position: 'absolute' as const,
      width: 1,
      height: 1,
      padding: 0,
      margin: -1,
      overflow: 'hidden' as const,
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap' as const,
      border: 0,
    },
    children: message,
  }

  return {
    announce,
    announcerProps,
    message,
  }
}

/**
 * 跳过导航链接 Hook
 */
export function useSkipLink(targetId: string = 'main-content') {
  const handleClick = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    const target = document.getElementById(targetId)
    if (target) {
      target.tabIndex = -1
      target.focus()
      target.scrollIntoView({ behavior: 'smooth' })
    }
  }, [targetId])

  return {
    onClick: handleClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        handleClick(e)
      }
    },
    href: `#${targetId}`,
  }
}

/**
 * 管理焦点指示器可见性
 * 仅在键盘导航时显示焦点指示器
 */
export function useFocusVisible() {
  const [focusVisible, setFocusVisible] = useState(false)
  const [hadKeyboardEvent, setHadKeyboardEvent] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.key === 'Escape') {
        setHadKeyboardEvent(true)
      }
    }

    const onPointerDown = () => {
      setHadKeyboardEvent(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  const focusProps = {
    onFocus: () => {
      if (hadKeyboardEvent) {
        setFocusVisible(true)
      }
    },
    onBlur: () => {
      setFocusVisible(false)
    },
  }

  return {
    focusVisible,
    focusProps,
    hadKeyboardEvent,
  }
}

/**
 * 可展开区域 Hook
 */
export function useExpandable(defaultExpanded = false) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const contentId = useRef(`expandable-${Math.random().toString(36).slice(2, 9)}`)

  const toggle = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  const triggerProps = {
    'aria-expanded': expanded,
    'aria-controls': contentId.current,
    onClick: toggle,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    },
  }

  const contentProps = {
    id: contentId.current,
    role: 'region' as const,
    hidden: !expanded,
    'aria-hidden': !expanded,
  }

  return {
    expanded,
    setExpanded,
    toggle,
    triggerProps,
    contentProps,
  }
}

/**
 * 选项卡导航 Hook
 */
export function useTabs<T extends string>(
  tabs: T[],
  defaultTab?: T
) {
  const [activeTab, setActiveTab] = useState<T>(defaultTab || tabs[0])
  const tabListRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const currentIndex = tabs.indexOf(activeTab)
    let newIndex = currentIndex

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1
        break
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0
        break
      case 'Home':
        e.preventDefault()
        newIndex = 0
        break
      case 'End':
        e.preventDefault()
        newIndex = tabs.length - 1
        break
      default:
        return
    }

    setActiveTab(tabs[newIndex])
    
    // 聚焦新选项卡
    const tabButtons = tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabButtons?.[newIndex]?.focus()
  }, [activeTab, tabs])

  const getTabListProps = () => ({
    ref: tabListRef,
    role: 'tablist' as const,
    'aria-orientation': 'horizontal' as const,
  })

  const getTabProps = (tab: T) => ({
    role: 'tab' as const,
    id: `tab-${tab}`,
    'aria-selected': activeTab === tab,
    'aria-controls': `tabpanel-${tab}`,
    tabIndex: activeTab === tab ? 0 : -1,
    onClick: () => setActiveTab(tab),
    onKeyDown: handleKeyDown,
  })

  const getTabPanelProps = (tab: T) => ({
    role: 'tabpanel' as const,
    id: `tabpanel-${tab}`,
    'aria-labelledby': `tab-${tab}`,
    hidden: activeTab !== tab,
    tabIndex: 0,
  })

  return {
    activeTab,
    setActiveTab,
    getTabListProps,
    getTabProps,
    getTabPanelProps,
  }
}

/**
 * 可访问的加载状态 Hook
 */
export function useLoadingState(loading: boolean) {
  const { announce, announcerProps } = useAriaLive({ ariaLive: 'polite' })

  useEffect(() => {
    if (loading) {
      announce('加载中，请稍候...')
    } else {
      announce('加载完成')
    }
  }, [loading, announce])

  const loadingProps = {
    'aria-busy': loading,
    'aria-live': 'polite' as const,
  }

  return {
    loadingProps,
    announcerProps,
  }
}

// ============================================
// 工具函数
// ============================================

/**
 * 获取元素内所有可聚焦元素
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

/**
 * 检查元素是否可聚焦
 */
export function isFocusable(element: HTMLElement): boolean {
  return element.matches(FOCUSABLE_SELECTOR)
}

/**
 * 生成唯一的 ARIA ID
 */
export function generateAriaId(prefix: string = 'aria'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}
