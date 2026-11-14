'use client'

/**
 * RankingControls — Tiny client island for time range switching + pagination.
 * ~2KB JS. Uses router.push() to trigger server re-render with new params.
 * No useSearchParams() — avoids Suspense boundary requirement and hydration repaints.
 */

import { useRouter } from 'next/navigation'
import { useTransition, useState, useEffect, useRef, useCallback } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { describeDataTime, formatDataClock } from '@/lib/utils/data-time'

const RANGES = ['90D', '30D', '7D'] as const

interface Props {
  activeRange: string
  /** Zero-based SSR/data page index. URLs themselves are deliberately one-based. */
  page: number
  /** Null means this SSR response has no same-cohort total authority. */
  totalCount: number | null
  /** False makes any legacy numeric value non-authoritative for pagination/UI copy. */
  totalCountIsExact?: boolean
  /** Look-ahead result for the current server-side page when totals are unknown. */
  hasMore?: boolean
  perPage: number
  lastUpdated: string | null
}

function finiteNonNegative(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Format the source watermark for "Data as of". A watermark from an earlier
 * day keeps its date: a bare "HH:MM" reads as today even when the exchange
 * data is weeks old.
 */
function formatDataTimestamp(value: string | null, nowMs = Date.now()): string {
  const { timestampMs } = describeDataTime(value, nowMs)
  if (timestampMs === null) return ''
  // Pin locale: this component is SSR'd in the homepage shell AND hydrates on
  // the client. A runtime-default locale (undefined) formats differently on
  // server vs browser → React #418 text-content hydration mismatch.
  return formatDataClock(timestampMs, nowMs, 'en-US')
}

export default function RankingControls({
  activeRange,
  page,
  totalCount,
  totalCountIsExact,
  hasMore,
  perPage,
  lastUpdated,
}: Props) {
  const router = useRouter()
  const { t } = useLanguage()
  const [isPending, startTransition] = useTransition()
  const [isOffline, setIsOffline] = useState(false)
  const [navError, setNavError] = useState(false)
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [lastDataTime, setLastDataTime] = useState<string>('')
  const [lastDataIsStale, setLastDataIsStale] = useState(false)

  // A page-derived count is not a total. Only show total-based controls and
  // promotion copy when the caller explicitly has a finite, exact authority.
  // Otherwise pagination must be driven solely by the view's limit+1 look-ahead.
  const exactTotal = totalCountIsExact === true && finiteNonNegative(totalCount) ? totalCount : null
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? perPage : null
  const totalPages =
    exactTotal !== null && safePerPage !== null
      ? Math.max(1, Math.ceil(exactTotal / safePerPage))
      : null
  const currentPage = Number.isSafeInteger(page) && page >= 0 ? page : 0
  const hasExactTotal = totalPages !== null
  const canGoNext = hasExactTotal ? currentPage < totalPages - 1 : hasMore === true
  const shouldShowPagination = hasExactTotal ? totalPages > 1 : currentPage > 0 || hasMore === true

  // Format only after hydration because the browser timezone can differ from
  // the server timezone. The value is the oldest upstream source watermark
  // (never the score compute time or the page-load/navigation time).
  useEffect(() => {
    const nowMs = Date.now()
    setLastDataTime(formatDataTimestamp(lastUpdated, nowMs))
    setLastDataIsStale(describeDataTime(lastUpdated, nowMs).isStale)
  }, [lastUpdated])

  // Detect online/offline status.
  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => {
      setIsOffline(false)
      setNavError(false)
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
    }
  }, [isPending])

  // Track the navigation target so the user can retry the same action
  // after a transient error instead of having to re-click.
  const lastNavRef = useRef<{ range: string; pg: number } | null>(null)

  const navigate = useCallback(
    (range: string, pg: number) => {
      if (isOffline) {
        setNavError(true)
        return
      }
      setNavError(false)
      lastNavRef.current = { range, pg }

      // Preserve client-owned filter/search params while changing the two
      // dimensions that this SSR island owns. A public URL is human one-based:
      // `?page=2` means the second page, whereas the reader receives pg=1.
      const params = new URLSearchParams(window.location.search)
      params.delete('range')
      params.delete('page')
      if (range !== '90D') params.set('range', range)
      if (pg > 0) params.set('page', String(pg + 1))
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
    },
    [isOffline, router, startTransition]
  )

  const retryLastNav = useCallback(() => {
    const last = lastNavRef.current
    if (last) navigate(last.range, last.pg)
  }, [navigate])

  return (
    <div className="ssr-controls" data-pending={isPending ? 'true' : undefined}>
      {/* Data freshness timestamp — always visible so users know data age */}
      {lastDataTime && !isOffline && !navError && (
        <div
          style={{
            width: '100%',
            display: 'flex',
            justifyContent: 'flex-end',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
            fontSize: 11,
            color: 'var(--color-text-tertiary)',
            order: -1,
            padding: '2px 4px 0',
          }}
        >
          <time dateTime={lastUpdated ?? undefined}>
            {t('rankingControlsDataAsOf')} {lastDataTime}
          </time>
          {lastDataIsStale && (
            <span
              data-testid="ranking-data-stale"
              style={{ color: tokens.colors.accent.warning, marginLeft: 4 }}
            >
              · {t('dataStaleWarning')}
            </span>
          )}
        </div>
      )}

      {(isOffline || navError) && (
        <div
          style={{
            width: '100%',
            padding: '8px 12px',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
            borderRadius: 8,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.medium,
            color: 'var(--color-text-primary)',
            background: 'rgba(251, 146, 60, 0.15)',
            border: '1px solid rgba(251, 146, 60, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            order: -1,
          }}
        >
          <span style={{ fontSize: tokens.typography.fontSize.base }}>&#x26A0;</span>
          <span style={{ flex: 1 }}>
            {isOffline
              ? `${t('rankingControlsOffline')}${lastDataTime ? ` ${t('rankingControlsDataAsOf')} ${lastDataTime}.` : ''}`
              : t('rankingControlsTakingLong')}
          </span>
          {!isOffline && lastNavRef.current && (
            <button
              type="button"
              onClick={retryLastNav}
              disabled={isPending}
              style={{
                background: 'rgba(251, 146, 60, 0.3)',
                border: '1px solid rgba(251, 146, 60, 0.5)',
                color: 'var(--color-text-primary)',
                padding: '4px 10px',
                borderRadius: tokens.radius.sm,
                // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
                fontSize: 11,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor: isPending ? 'not-allowed' : 'pointer',
                opacity: isPending ? 0.6 : 1,
              }}
            >
              {t('rankingControlsRetry')}
            </button>
          )}
        </div>
      )}

      <div className="ssr-range-bar">
        {RANGES.map((r) => (
          <button
            key={r}
            className={`ssr-range-btn${r === activeRange ? ' ssr-range-active' : ''}`}
            onClick={() => navigate(r, 0)}
            disabled={isPending}
            aria-pressed={r === activeRange}
            aria-label={`Show ${r} rankings`}
          >
            {r}
          </button>
        ))}
      </div>

      {shouldShowPagination && (
        <div className="ssr-pagination">
          {hasExactTotal && (
            <button
              className="ssr-page-btn"
              onClick={() => navigate(activeRange, 0)}
              disabled={currentPage <= 0 || isPending}
              aria-label="First page"
            >
              «
            </button>
          )}
          <button
            className="ssr-page-btn"
            onClick={() => navigate(activeRange, currentPage - 1)}
            disabled={currentPage <= 0 || isPending}
            aria-label="Previous page"
          >
            ‹ {t('rankingControlsPrev')}
          </button>
          {hasExactTotal && (
            <span className="ssr-page-info" aria-live="polite" aria-atomic="true">
              {currentPage + 1} / {totalPages}
            </span>
          )}
          <button
            className="ssr-page-btn"
            onClick={() => navigate(activeRange, currentPage + 1)}
            disabled={!canGoNext || isPending}
            aria-label="Next page"
          >
            {t('rankingControlsNext')} ›
          </button>
          {hasExactTotal && (
            <button
              className="ssr-page-btn"
              onClick={() => navigate(activeRange, totalPages - 1)}
              disabled={!canGoNext || isPending}
              aria-label="Last page"
            >
              »
            </button>
          )}
        </div>
      )}

      {/* promo 期(#6):诚实信息条,不推付费——全站限免,"全部已解锁"而非"升级解锁" */}
      {exactTotal !== null && totalPages !== null && exactTotal > 0 && BETA_PRO_FEATURES_FREE && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '8px 14px',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
            borderRadius: 8,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.medium,
            color: 'var(--color-text-secondary)',
            opacity: 0.7,
          }}
        >
          {t('rankingControlsShowingTopPromo').replace(
            '{count}',
            exactTotal.toLocaleString('en-US')
          )}
        </div>
      )}

      {/* Free-tier limit banner — always visible so users know scope upfront */}
      {exactTotal !== null && totalPages !== null && exactTotal > 0 && !BETA_PRO_FEATURES_FREE && (
        <a
          href="/pricing"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '8px 14px',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
            borderRadius: 8,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.medium,
            color: 'var(--color-text-secondary)',
            background:
              currentPage >= totalPages - 1
                ? 'linear-gradient(135deg, var(--color-bg-secondary, #1a1a2e) 0%, rgba(167,139,250,0.12) 100%)'
                : 'transparent',
            border:
              currentPage >= totalPages - 1
                ? '1px solid rgba(167, 139, 250, 0.2)'
                : '1px solid transparent',
            textDecoration: 'none',
            transition: 'border-color 0.2s, background 0.2s',
            opacity: currentPage >= totalPages - 1 ? 1 : 0.7,
          }}
        >
          <span style={{ flex: 1 }}>
            {t('rankingControlsShowingTop').replace('{count}', exactTotal.toLocaleString('en-US'))}
          </span>
          <span
            style={{
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
              fontSize: 11,
              fontWeight: tokens.typography.fontWeight.bold,
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
              color: 'var(--color-brand, #a78bfa)',
              whiteSpace: 'nowrap',
            }}
          >
            {t('rankingControlsUpgrade')}
          </span>
        </a>
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
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
              fontSize: 11,
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
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
            <span>{t('rankingControlsLoading')}</span>
          </div>
          <style>{`@keyframes rc-spin { to { transform: rotate(360deg); } }`}</style>
        </>
      )}
    </div>
  )
}
