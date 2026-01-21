'use client'

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  CSSProperties,
  ReactNode,
} from 'react'

interface VirtualListProps<T> {
  /** 数据列表 */
  items: T[]
  /** 每项的高度（固定高度）或动态计算函数 */
  itemHeight: number | ((item: T, index: number) => number)
  /** 渲染单个项的函数 */
  renderItem: (item: T, index: number) => ReactNode
  /** 容器高度 */
  height: number | string
  /** 容器宽度 */
  width?: number | string
  /** 缓冲区大小（额外渲染的项数） */
  overscan?: number
  /** 容器样式 */
  style?: CSSProperties
  /** 容器类名 */
  className?: string
  /** 是否显示滚动条 */
  showScrollbar?: boolean
  /** 滚动到指定位置的回调 */
  onScroll?: (scrollTop: number) => void
  /** 到达底部时的回调 */
  onReachEnd?: () => void
  /** 到达底部的阈值（像素） */
  endReachedThreshold?: number
  /** 空列表显示内容 */
  emptyContent?: ReactNode
  /** 头部内容 */
  header?: ReactNode
  /** 尾部内容 */
  footer?: ReactNode
  /** 唯一键提取函数 */
  keyExtractor?: (item: T, index: number) => string | number
}

/**
 * 虚拟滚动列表组件
 * 只渲染可视区域内的元素，大幅提升长列表性能
 */
export function VirtualList<T>({
  items,
  itemHeight,
  renderItem,
  height,
  width = '100%',
  overscan = 5,
  style,
  className,
  showScrollbar = true,
  onScroll,
  onReachEnd,
  endReachedThreshold = 200,
  emptyContent,
  header,
  footer,
  keyExtractor,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const hasReachedEnd = useRef(false)

  // 计算单项高度
  const getItemHeight = useCallback(
    (index: number): number => {
      if (typeof itemHeight === 'function') {
        return itemHeight(items[index], index)
      }
      return itemHeight
    },
    [itemHeight, items]
  )

  // 计算所有项的偏移量（用于可变高度）
  const itemOffsets = useMemo(() => {
    const offsets: number[] = [0]
    let totalHeight = 0
    for (let i = 0; i < items.length; i++) {
      totalHeight += getItemHeight(i)
      offsets.push(totalHeight)
    }
    return offsets
  }, [items.length, getItemHeight])

  // 总高度
  const totalHeight = itemOffsets[itemOffsets.length - 1] || 0

  // 容器高度（数字）
  const containerHeight = useMemo(() => {
    if (typeof height === 'number') return height
    return 600 // 默认高度
  }, [height])

  // 二分查找起始索引
  const findStartIndex = useCallback(
    (scrollTop: number): number => {
      let left = 0
      let right = items.length - 1

      while (left <= right) {
        const mid = Math.floor((left + right) / 2)
        if (itemOffsets[mid] <= scrollTop) {
          left = mid + 1
        } else {
          right = mid - 1
        }
      }

      return Math.max(0, right)
    },
    [items.length, itemOffsets]
  )

  // 计算可见范围
  const visibleRange = useMemo(() => {
    const startIndex = findStartIndex(scrollTop)
    const start = Math.max(0, startIndex - overscan)

    // 找到结束索引
    let endIndex = startIndex
    let accumulatedHeight = itemOffsets[startIndex] - scrollTop

    while (endIndex < items.length && accumulatedHeight < containerHeight) {
      accumulatedHeight += getItemHeight(endIndex)
      endIndex++
    }

    const end = Math.min(items.length, endIndex + overscan)

    return { start, end }
  }, [scrollTop, containerHeight, items.length, overscan, findStartIndex, itemOffsets, getItemHeight])

  // 处理滚动事件
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const target = e.currentTarget
      const newScrollTop = target.scrollTop
      setScrollTop(newScrollTop)
      onScroll?.(newScrollTop)

      // 检查是否到达底部
      const isNearEnd =
        target.scrollHeight - target.scrollTop - target.clientHeight < endReachedThreshold

      if (isNearEnd && !hasReachedEnd.current && onReachEnd) {
        hasReachedEnd.current = true
        onReachEnd()
      } else if (!isNearEnd) {
        hasReachedEnd.current = false
      }
    },
    [onScroll, onReachEnd, endReachedThreshold]
  )

  // 渲染可见项
  const visibleItems = useMemo(() => {
    const result: ReactNode[] = []

    for (let i = visibleRange.start; i < visibleRange.end; i++) {
      const item = items[i]
      const key = keyExtractor ? keyExtractor(item, i) : i
      const offsetTop = itemOffsets[i]
      const height = getItemHeight(i)

      result.push(
        <div
          key={key}
          style={{
            position: 'absolute',
            top: offsetTop,
            left: 0,
            right: 0,
            height,
          }}
        >
          {renderItem(item, i)}
        </div>
      )
    }

    return result
  }, [items, visibleRange, itemOffsets, getItemHeight, renderItem, keyExtractor])

  // 空状态
  if (items.length === 0 && emptyContent) {
    return (
      <div
        style={{
          height,
          width,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style,
        }}
        className={className}
      >
        {emptyContent}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        height,
        width,
        overflow: 'auto',
        position: 'relative',
        ...(showScrollbar
          ? {}
          : {
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }),
        ...style,
      }}
      className={className}
    >
      {header}

      {/* 内容容器 */}
      <div
        style={{
          height: totalHeight,
          position: 'relative',
        }}
      >
        {visibleItems}
      </div>

      {footer}
    </div>
  )
}

/**
 * 简化版虚拟列表 - 固定高度项
 */
export function SimpleVirtualList<T>({
  items,
  itemHeight,
  renderItem,
  height = 400,
  ...props
}: Omit<VirtualListProps<T>, 'itemHeight'> & { itemHeight: number }) {
  return (
    <VirtualList
      items={items}
      itemHeight={itemHeight}
      renderItem={renderItem}
      height={height}
      {...props}
    />
  )
}

/**
 * 无限滚动列表 Hook
 */
export function useInfiniteScroll(
  loadMore: () => Promise<void>,
  options: {
    hasMore: boolean
    threshold?: number
    loading?: boolean
  }
) {
  const { hasMore, threshold = 200, loading = false } = options
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loadingRef = useRef(loading)

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }

      if (!node || !hasMore) return

      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
            loadMore()
          }
        },
        { rootMargin: `${threshold}px` }
      )

      observerRef.current.observe(node)
    },
    [hasMore, loadMore, threshold]
  )

  return { sentinelRef }
}

export default VirtualList

