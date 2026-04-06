'use client'

/**
 * RankingControls — Tiny client island for time range switching + pagination.
 * ~2KB JS. Uses router.push() to trigger server re-render with new params.
 * No useSearchParams() — avoids Suspense boundary requirement and hydration repaints.
 */

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

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

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  const navigate = (range: string, pg: number) => {
    const params = new URLSearchParams()
    if (range !== '90D') params.set('range', range)
    if (pg > 0) params.set('page', String(pg))
    const qs = params.toString()
    startTransition(() => {
      router.push(qs ? `/?${qs}` : '/', { scroll: false })
    })
  }

  return (
    <div className="ssr-controls">
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
        </div>
      )}

      {isPending && <div className="ssr-loading-bar" />}
    </div>
  )
}
