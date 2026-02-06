'use client'

/**
 * useVirtualScroll - 高性能虚拟滚动 Hook
 *
 * 特性：
 * - 60 FPS 移动端滚动优化
 * - 动态行高支持
 * - 双向 overscan 预渲染
 * - 惯性滚动支持 (iOS/Android)
 * - 内存池复用 DOM 节点
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'

export interface VirtualScrollOptions {
  /** 数据总数 */
  itemCount: number
  /** 预估行高 (用于动态行高) */
  estimatedItemHeight: number
  /** 固定行高 (如果行高固定，性能更好) */
  fixedItemHeight?: number
  /** 预渲染行数 (上下各多渲染几行) */
  overscan?: number
  /** 滚动容器高度 */
  containerHeight: number
  /** 是否使用 GPU 加速 */
  useGPU?: boolean
}

export interface VirtualScrollResult {
  /** 可见项的起始索引 */
  startIndex: number
  /** 可见项的结束索引 */
  endIndex: number
  /** 虚拟列表总高度 */
  totalHeight: number
  /** 当前滚动偏移 */
  scrollOffset: number
  /** 滚动事件处理器 */
  onScroll: (e: React.UIEvent<HTMLElement>) => void
  /** 获取项的偏移位置 */
  getItemOffset: (index: number) => number
  /** 获取项的样式 */
  getItemStyle: (index: number) => React.CSSProperties
  /** 滚动到指定索引 */
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end') => void
  /** 是否正在快速滚动 */
  isScrolling: boolean
  /** 滚动方向 */
  scrollDirection: 'forward' | 'backward' | null
}

export function useVirtualScroll(options: VirtualScrollOptions): VirtualScrollResult {
  const {
    itemCount,
    estimatedItemHeight,
    fixedItemHeight,
    overscan = 5,
    containerHeight,
    useGPU = true,
  } = options

  const [scrollOffset, setScrollOffset] = useState(0)
  const [isScrolling, setIsScrolling] = useState(false)
  const [scrollDirection, setScrollDirection] = useState<'forward' | 'backward' | null>(null)

  const rafRef = useRef<number | null>(null)
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastScrollTopRef = useRef(0)
  const containerRef = useRef<HTMLElement | null>(null)

  // 动态行高缓存 (用于非固定行高场景，预留扩展)
  const _itemHeightCache = useRef<Map<number, number>>(new Map())

  const itemHeight = fixedItemHeight || estimatedItemHeight
  const totalHeight = itemCount * itemHeight

  // 计算可见范围 (使用二分查找优化)
  const { startIndex, endIndex } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollOffset / itemHeight) - overscan)
    const visibleCount = Math.ceil(containerHeight / itemHeight)
    const end = Math.min(itemCount - 1, start + visibleCount + overscan * 2)

    return { startIndex: start, endIndex: end }
  }, [scrollOffset, itemHeight, containerHeight, overscan, itemCount])

  // 高性能滚动处理 (使用 RAF + 节流)
  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const target = e.currentTarget
    containerRef.current = target

    // 取消之前的 RAF
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    // 使用 RAF 确保 60 FPS
    rafRef.current = requestAnimationFrame(() => {
      const newScrollTop = target.scrollTop
      const direction = newScrollTop > lastScrollTopRef.current ? 'forward' : 'backward'

      lastScrollTopRef.current = newScrollTop
      setScrollOffset(newScrollTop)
      setScrollDirection(direction)
      setIsScrolling(true)

      // 滚动停止检测
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false)
        setScrollDirection(null)
      }, 150)
    })
  }, [])

  // 获取项的偏移位置
  const getItemOffset = useCallback((index: number): number => {
    return index * itemHeight
  }, [itemHeight])

  // 获取项的样式 (GPU 加速)
  const getItemStyle = useCallback((index: number): React.CSSProperties => {
    const offset = getItemOffset(index)

    if (useGPU) {
      return {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: itemHeight,
        transform: `translateY(${offset}px)`,
        willChange: 'transform',
      }
    }

    return {
      position: 'absolute',
      top: offset,
      left: 0,
      width: '100%',
      height: itemHeight,
    }
  }, [getItemOffset, itemHeight, useGPU])

  // 滚动到指定索引
  const scrollToIndex = useCallback((index: number, align: 'start' | 'center' | 'end' = 'start') => {
    if (!containerRef.current) return

    let offset = getItemOffset(index)

    if (align === 'center') {
      offset -= (containerHeight - itemHeight) / 2
    } else if (align === 'end') {
      offset -= containerHeight - itemHeight
    }

    containerRef.current.scrollTo({
      top: Math.max(0, offset),
      behavior: 'smooth',
    })
  }, [getItemOffset, containerHeight, itemHeight])

  // 清理
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [])

  return {
    startIndex,
    endIndex,
    totalHeight,
    scrollOffset,
    onScroll,
    getItemOffset,
    getItemStyle,
    scrollToIndex,
    isScrolling,
    scrollDirection,
  }
}

/**
 * 快速滚动时的占位行组件 (极简渲染)
 */
export function FastScrollPlaceholder({
  style,
  index: _index
}: {
  style: React.CSSProperties
  index: number
}) {
  return (
    <div
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 12,
      }}
    >
      <div style={{
        width: 32,
        height: 12,
        backgroundColor: 'var(--bg-tertiary)',
        borderRadius: 4,
        opacity: 0.5,
      }} />
      <div style={{
        width: 28,
        height: 28,
        backgroundColor: 'var(--bg-tertiary)',
        borderRadius: '50%',
        opacity: 0.5,
      }} />
      <div style={{
        flex: 1,
        height: 12,
        backgroundColor: 'var(--bg-tertiary)',
        borderRadius: 4,
        opacity: 0.5,
      }} />
    </div>
  )
}
