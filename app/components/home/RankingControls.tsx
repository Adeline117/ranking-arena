'use client'

/**
 * RankingControls — Tiny client island for time range switching + pagination.
 * ~2KB JS. Uses router.push() to trigger server re-render with new params.
 * No useSearchParams() — avoids Suspense boundary requirement and hydration repaints.
 */

import { useRouter } from 'next/navigation'
import { useTransition, useState, useEffect, useRef, useCallback } from 'react'

const RANGES = ['90D', '30D', '7D'] as const

interface Props {
  activeRange: string
  page: number
  totalCount: number
  perPage: number
}

export default function RankingControls({ activeRange, page, totalCount, perPage }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isOffline, setIsOffline] = useState(false)
  const [navError, setNavError] = useState(false)
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  // Detect online/offline status
  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => { setIsOffline(false); setNavError(false) }
    // Check initial state
    if (typeof navigator !== 'undefined' && !navigator.onLine) setIsOffline(true)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  // Clear nav error when transition completes successfully
  useEffect(() => {
    if (!isPending && navTimerRef.current) {
      clearTimeout(navTimerRef.current)
      navTimerRef.current = null
    }
  }, [isPending])

  const navigate = useCallback((range: string, pg: number) => {
    if (isOffline) {
      setNavError(true)
      return
    }
    setNavError(false)

    const params = new URLSearchParams()
    if (range !== '90D') params.set('range', range)
    if (pg > 0) params.set('page', String(pg))
    const qs = params.toString()

    // Timeout: if transition takes >8s, show error (likely offline or network issue)
    navTimerRef.current = setTimeout(() => {
      setNavError(true)
    }, 8000)

    startTransition(() => {
      router.push(qs ? `/?${qs}` : '/', { scroll: false })
    })
  }, [isOffline, router, startTransition])

  return (
    <div className="ssr-controls">
      {(isOffline || navError) && (
        <div style={{
          width: '100%',
          padding: '8px 12px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--color-text-primary, #fff)',
          background: 'rgba(251, 146, 60, 0.15)',
          border: '1px solid rgba(251, 146, 60, 0.3)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          order: -1,
        }}>
          <span style={{ fontSize: 14 }}>⚠</span>
          {isOffline
            ? 'You are offline. Rankings data is still visible but cannot be updated.'
            : 'Network issue — please check your connection and try again.'}
        </div>
      )}

      <div className="ssr-range-bar">
        {RANGES.map(r => (
          <button
            key={r}
            className={`ssr-range-btn${r === activeRange ? ' ssr-range-active' : ''}`}
            onClick={() => navigate(r, 0)}
            disabled={isPending}
          >
            {r}
          </button>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="ssr-pagination">
          <button
            className="ssr-page-btn"
            onClick={() => navigate(activeRange, 0)}
            disabled={page <= 0 || isPending}
            title="First page"
          >
            «
          </button>
          <button
            className="ssr-page-btn"
            onClick={() => navigate(activeRange, page - 1)}
            disabled={page <= 0 || isPending}
          >
            ‹ Prev
          </button>
          <span className="ssr-page-info">
            {page + 1} / {totalPages}
          </span>
          <button
            className="ssr-page-btn"
            onClick={() => navigate(activeRange, page + 1)}
            disabled={page >= totalPages - 1 || isPending}
          >
            Next ›
          </button>
          <button
            className="ssr-page-btn"
            onClick={() => navigate(activeRange, totalPages - 1)}
            disabled={page >= totalPages - 1 || isPending}
            title="Last page"
          >
            »
          </button>
        </div>
      )}

      {isPending && <div className="ssr-loading-bar" />}
    </div>
  )
}
