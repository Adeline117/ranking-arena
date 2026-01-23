'use client'

import { useRef, useState, useEffect, useCallback } from 'react'

interface UseInfiniteScrollOptions {
  threshold?: number
  rootMargin?: string
}

interface UseInfiniteScrollReturn {
  sentinelRef: React.RefObject<HTMLDivElement | null>
  hasMore: boolean
  isLoadingMore: boolean
  setHasMore: (value: boolean) => void
  setIsLoadingMore: (value: boolean) => void
  reset: () => void
}

export function useInfiniteScroll(
  onLoadMore: () => Promise<void>,
  options: UseInfiniteScrollOptions = {}
): UseInfiniteScrollReturn {
  const { threshold = 0.1, rootMargin = '200px' } = options
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadingRef = useRef(false)

  const reset = useCallback(() => {
    setHasMore(true)
    setIsLoadingMore(false)
    loadingRef.current = false
  }, [])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && hasMore && !loadingRef.current) {
          loadingRef.current = true
          setIsLoadingMore(true)
          onLoadMore()
            .finally(() => {
              loadingRef.current = false
              setIsLoadingMore(false)
            })
        }
      },
      { threshold, rootMargin }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, threshold, rootMargin])

  return { sentinelRef, hasMore, isLoadingMore, setHasMore, setIsLoadingMore, reset }
}
