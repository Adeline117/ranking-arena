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

/** Format a Date to "HH:MM" in the user's locale */
function formatTime(date: Date): string {
  try {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
}

export default function RankingControls({ activeRange, page, totalCount, perPage }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isOffline, setIsOffline] = useState(false)
  const [navError, setNavError] = useState(false)
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the last time data was successfully loaded (page render = fresh data)
  const lastDataTimeRef = useRef<Date>(new Date())
  const [lastDataTime, setLastDataTime] = useState<string>('')

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  // Detect online/offline status
  useEffect(() => {
    // Capture initial render time as the data timestamp
    lastDataTimeRef.current = new Date()
    setLastDataTime(formatTime(lastDataTimeRef.current))

    const goOffline = () => setIsOffline(true)
    const goOnline = () => {
      setIsOffline(false)
      setNavError(false)
      // Update data timestamp on reconnect (page will refresh)
      lastDataTimeRef.current = new Date()
      setLastDataTime(formatTime(lastDataTimeRef.current))
    }
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
      // Update data timestamp — successful navigation means fresh data
      lastDataTimeRef.current = new Date()
      setLastDataTime(formatTime(lastDataTimeRef.current))
    }
  }, [isPending])

  // Track the navigation target so the user can retry the same action
  // after a transient error instead of having to re-click.
  const lastNavRef = useRef<{ range: string; pg: number } | null>(null)

  const navigate = useCallback((range: string, pg: number) => {
    if (isOffline) {
      setNavError(true)
      return
    }
    setNavError(false)
    lastNavRef.current = { range, pg }

    const params = new URLSearchParams()
    if (range !== '90D') params.set('range', range)
    if (pg > 0) params.set('page', String(pg))
    const qs = params.toString()

    // PROD-2 (audit): reduced from 8s → 3s. Users started repeat-clicking
    // around the 3-4s mark on slow connections because the loading bar
    // alone wasn't enough feedback. Earlier error visibility lets them
    // retry instead of building a queue of router.push() calls.
    navTimerRef.current = setTimeout(() => {
      setNavError(true)
    }, 3000)

    startTransition(() => {
      router.push(qs ? `/?${qs}` : '/', { scroll: false })
    })
  }, [isOffline, router, startTransition])

  const retryLastNav = useCallback(() => {
    const last = lastNavRef.current
    if (last) navigate(last.range, last.pg)
  }, [navigate])

  return (
    <div className="ssr-controls" data-pending={isPending ? 'true' : undefined}>
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
          gap: 8,
          order: -1,
        }}>
          <span style={{ fontSize: 14 }}>⚠</span>
          <span style={{ flex: 1 }}>
            {isOffline
              ? `You are offline. Rankings data is still visible but cannot be updated.${lastDataTime ? ` Data as of ${lastDataTime}.` : ''}`
              : 'This is taking longer than expected.'}
          </span>
          {!isOffline && lastNavRef.current && (
            <button
              type="button"
              onClick={retryLastNav}
              disabled={isPending}
              style={{
                background: 'rgba(251, 146, 60, 0.3)',
                border: '1px solid rgba(251, 146, 60, 0.5)',
                color: 'var(--color-text-primary, #fff)',
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                cursor: isPending ? 'not-allowed' : 'pointer',
                opacity: isPending ? 0.6 : 1,
              }}
            >
              Retry
            </button>
          )}
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

      {isPending && (
        <>
          <div className="ssr-loading-bar" />
          <div
            role="status"
            aria-live="polite"
            style={{
              position: 'absolute',
              right: 12,
              top: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--color-text-secondary, #888)',
              pointerEvents: 'none',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                border: '1.5px solid currentColor',
                borderTopColor: 'transparent',
                animation: 'rc-spin 0.8s linear infinite',
              }}
            />
            <span>Loading…</span>
          </div>
          <style>{`@keyframes rc-spin { to { transform: rotate(360deg); } }`}</style>
        </>
      )}
    </div>
  )
}
