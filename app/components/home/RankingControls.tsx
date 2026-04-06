'use client'

/**
 * RankingControls — Tiny client island for time range switching + pagination.
 * ~3KB JS. Uses router.push() to trigger server re-render with new params.
 * The table itself is always SSR — this component only handles controls.
 */

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useTransition } from 'react'

const RANGES = ['90D', '30D', '7D'] as const

interface Props {
  activeRange: string
  page: number
  totalCount: number
  perPage: number
}

export default function RankingControls({ activeRange, page, totalCount, perPage }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  const navigate = useCallback((params: Record<string, string>) => {
    const sp = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(params)) {
      if (v === '' || v === '0' || v === '90D') {
        sp.delete(k)
      } else {
        sp.set(k, v)
      }
    }
    const qs = sp.toString()
    startTransition(() => {
      router.push(qs ? `/?${qs}` : '/', { scroll: false })
    })
  }, [router, searchParams, startTransition])

  return (
    <div className="ssr-controls">
      {/* Time range selector */}
      <div className="ssr-range-bar">
        {RANGES.map(r => (
          <button
            key={r}
            className={`ssr-range-btn${r === activeRange ? ' ssr-range-active' : ''}`}
            onClick={() => navigate({ range: r, page: '' })}
            disabled={isPending}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="ssr-pagination">
          <button
            className="ssr-page-btn"
            onClick={() => navigate({ range: activeRange, page: String(page - 1) })}
            disabled={page <= 0 || isPending}
          >
            ‹ Prev
          </button>
          <span className="ssr-page-info">
            {page + 1} / {totalPages}
          </span>
          <button
            className="ssr-page-btn"
            onClick={() => navigate({ range: activeRange, page: String(page + 1) })}
            disabled={page >= totalPages - 1 || isPending}
          >
            Next ›
          </button>
        </div>
      )}

      {/* Loading overlay */}
      {isPending && <div className="ssr-loading-bar" />}
    </div>
  )
}
