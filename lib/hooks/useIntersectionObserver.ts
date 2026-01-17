/**
 * Intersection Observer Hook
 * 用于懒加载、无限滚动和元素可见性检测
 */

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ============================================
// 类型定义
// ============================================

interface UseIntersectionObserverOptions {
  /** 根元素 */
  root?: Element | null
  /** 根元素边距 */
  rootMargin?: string
  /** 触发阈值 */
  threshold?: number | number[]
  /** 是否只触发一次 */
  triggerOnce?: boolean
  /** 是否启用 */
  enabled?: boolean
}

interface UseIntersectionObserverReturn {
  /** 元素引用 */
  ref: (node: Element | null) => void
  /** 是否可见 */
  isIntersecting: boolean
  /** 完整的 IntersectionObserverEntry */
  entry: IntersectionObserverEntry | null
}

// ============================================
// 主 Hook
// ============================================

/**
 * 检测元素是否进入视口
 * 
 * @example
 * ```tsx
 * function LazyImage({ src }) {
 *   const { ref, isIntersecting } = useIntersectionObserver({ triggerOnce: true })
 *   
 *   return (
 *     <div ref={ref}>
 *       {isIntersecting && <img src={src} />}
 *     </div>
 *   )
 * }
 * ```
 */
export function useIntersectionObserver(
  options: UseIntersectionObserverOptions = {}
): UseIntersectionObserverReturn {
  const {
    root = null,
    rootMargin = '0px',
    threshold = 0,
    triggerOnce = false,
    enabled = true,
  } = options

  const [entry, setEntry] = useState<IntersectionObserverEntry | null>(null)
  const [node, setNode] = useState<Element | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const hasTriggeredRef = useRef(false)

  const ref = useCallback((node: Element | null) => {
    setNode(node)
  }, [])

  useEffect(() => {
    if (!enabled || !node) return
    if (triggerOnce && hasTriggeredRef.current) return

    // 检查浏览器支持
    if (!('IntersectionObserver' in window)) {
      // Fallback：假设元素可见
      setEntry({ isIntersecting: true } as IntersectionObserverEntry)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setEntry(entry)
        
        if (entry.isIntersecting && triggerOnce) {
          hasTriggeredRef.current = true
          observer.disconnect()
        }
      },
      { root, rootMargin, threshold }
    )

    observer.observe(node)
    observerRef.current = observer

    return () => {
      observer.disconnect()
    }
  }, [node, root, rootMargin, threshold, triggerOnce, enabled])

  return {
    ref,
    isIntersecting: entry?.isIntersecting ?? false,
    entry,
  }
}

// ============================================
// 便捷 Hooks
// ============================================

/**
 * 懒加载 Hook
 */
export function useLazyLoad(options?: Omit<UseIntersectionObserverOptions, 'triggerOnce'>) {
  return useIntersectionObserver({ ...options, triggerOnce: true })
}

/**
 * 无限滚动 Hook
 * 
 * @example
 * ```tsx
 * function InfiniteList() {
 *   const [items, setItems] = useState([])
 *   const [hasMore, setHasMore] = useState(true)
 *   
 *   const { ref, isIntersecting } = useInfiniteScroll({
 *     onLoadMore: async () => {
 *       const newItems = await fetchMoreItems()
 *       setItems(prev => [...prev, ...newItems])
 *       setHasMore(newItems.length > 0)
 *     },
 *     hasMore,
 *   })
 *   
 *   return (
 *     <>
 *       {items.map(item => <Item key={item.id} {...item} />)}
 *       <div ref={ref}>加载中...</div>
 *     </>
 *   )
 * }
 * ```
 */
export function useInfiniteScroll(options: {
  onLoadMore: () => Promise<void>
  hasMore: boolean
  threshold?: number
  rootMargin?: string
}) {
  const { onLoadMore, hasMore, threshold = 0, rootMargin = '100px' } = options
  const [isLoading, setIsLoading] = useState(false)
  const loadMoreRef = useRef(onLoadMore)
  
  // Update ref in useEffect to avoid updating during render
  useEffect(() => {
    loadMoreRef.current = onLoadMore
  }, [onLoadMore])

  const { ref, isIntersecting } = useIntersectionObserver({
    threshold,
    rootMargin,
    enabled: hasMore && !isLoading,
  })

  useEffect(() => {
    if (!isIntersecting || !hasMore || isLoading) return

    setIsLoading(true)
    loadMoreRef.current()
      .finally(() => setIsLoading(false))
  }, [isIntersecting, hasMore, isLoading])

  return { ref, isLoading }
}

/**
 * 元素可见性追踪 Hook
 */
export function useVisibilityTracking(
  elementId: string,
  onVisible?: (id: string, duration: number) => void
) {
  const startTimeRef = useRef<number | null>(null)
  const { ref, isIntersecting } = useIntersectionObserver({
    threshold: 0.5, // 50% 可见
  })

  useEffect(() => {
    if (isIntersecting) {
      startTimeRef.current = Date.now()
    } else if (startTimeRef.current && onVisible) {
      const duration = Date.now() - startTimeRef.current
      onVisible(elementId, duration)
      startTimeRef.current = null
    }
  }, [isIntersecting, elementId, onVisible])

  return ref
}
