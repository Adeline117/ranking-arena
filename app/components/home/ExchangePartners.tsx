'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { fetcher } from '@/lib/hooks/fetchers'
import { REFETCH_RELAXED, STALE_RELAXED } from '@/lib/hooks/cache-presets'
import type { ApiSuccessResponse } from '@/lib/types/index'
import type {
  LeaderboardTimeRange,
  VisibleLeaderboardSource,
} from '@/lib/data/visible-leaderboard-sources'
import { trackEvent } from '@/lib/analytics/track'
import { useLanguage } from '../Providers/LanguageProvider'
import ExchangeLogo from '../ui/ExchangeLogo'
import { orderedVisiblePartners, sourceProductVariant } from './exchange-partners'

const TIME_RANGES: readonly LeaderboardTimeRange[] = ['7D', '30D', '90D']

interface VisibleSourcesPayload {
  timeRange: LeaderboardTimeRange
  sources: VisibleLeaderboardSource[]
}

export default function ExchangePartners() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useLanguage()
  const rawTimeRange = searchParams.get('range')?.toUpperCase()
  const timeRange = TIME_RANGES.includes(rawTimeRange as LeaderboardTimeRange)
    ? (rawTimeRange as LeaderboardTimeRange)
    : '90D'

  const { data, isLoading, error, refetch } = useQuery<VisibleLeaderboardSource[]>({
    queryKey: ['visible-leaderboard-sources', timeRange],
    queryFn: async () => {
      const response = await fetcher<ApiSuccessResponse<VisibleSourcesPayload>>(
        `/api/sources/visible?timeRange=${timeRange}`
      )
      if (response.data.timeRange !== timeRange) {
        throw new Error('visible leaderboard source timeRange mismatch')
      }
      return response.data.sources
    },
    staleTime: STALE_RELAXED,
    refetchInterval: REFETCH_RELAXED,
    refetchOnWindowFocus: true,
  })

  const exchanges = orderedVisiblePartners(data ?? [])
  const doubledExchanges = [...exchanges, ...exchanges]
  const animationSeconds = Math.max(35, exchanges.length * 3)

  const productLabel = (source: VisibleLeaderboardSource): string => {
    switch (sourceProductVariant(source)) {
      case 'bots-futures':
        return `${t('botsBot')} · ${t('categoryFutures')}`
      case 'bots-spot':
        return `${t('botsBot')} · ${t('categorySpot')}`
      case 'mt5':
        return 'MT5'
      case 'cfd':
        return 'CFD'
      case 'futures':
        return t('categoryFutures')
      case 'spot':
        return t('categorySpot')
      case 'onchain':
        return t('categoryWeb3')
      default:
        return source.productType
    }
  }

  return (
    <div
      style={{
        overflow: 'hidden',
        padding: '10px 0',
        borderBottom: `1px solid var(--color-border-primary)`,
        position: 'relative',
        contain: 'layout style paint', // Prevent internal animation from causing external CLS
        height: 47, // Fixed height prevents CLS when component lazy-loads
      }}
    >
      {/* Fade edges */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 40,
          background: `linear-gradient(to right, var(--color-bg-primary), transparent)`,
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 40,
          background: `linear-gradient(to left, var(--color-bg-primary), transparent)`,
          zIndex: 1,
          pointerEvents: 'none',
        }}
      />

      <div
        className="exchange-scroll-track"
        aria-busy={isLoading}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          animation:
            exchanges.length > 0 ? `exchange-scroll ${animationSeconds}s linear infinite` : 'none',
          width: 'max-content',
          willChange: 'transform', // Promote to compositor layer — prevents layout recalc during animation
        }}
      >
        {error ? (
          <button
            type="button"
            className="exchange-item"
            onClick={() => void refetch()}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              padding: '4px 10px',
            }}
          >
            {t('loadFailed')}
          </button>
        ) : !isLoading && exchanges.length === 0 ? (
          <span className="exchange-item" role="status">
            {t('noData')}
          </span>
        ) : isLoading ? (
          Array.from({ length: 8 }, (_, index) => (
            <span
              key={index}
              className="skeleton"
              aria-hidden="true"
              style={{ width: 96, height: 26, borderRadius: tokens.radius.md }}
            />
          ))
        ) : (
          doubledExchanges.map((ex, i) => {
            const duplicate = i >= exchanges.length
            const label = `${ex.exchangeName} · ${productLabel(ex)}`
            const content = (
              <>
                <ExchangeLogo exchange={ex.exchangeSlug} size={18} />
                {label}
              </>
            )
            const sharedStyle: React.CSSProperties = {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: 'var(--color-text-secondary)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              textDecoration: 'none',
              padding: '4px 10px',
              borderRadius: tokens.radius.md,
              // Only transition compositable properties — avoid 'all' which triggers uncomposited animations
              transition: `background-color ${tokens.transition.base}, color ${tokens.transition.base}`,
            }
            return (
              <a
                key={`${ex.registrySlug}-${i}`}
                href={`/?range=${timeRange}&exchange=${encodeURIComponent(ex.filterSource)}`}
                aria-label={`${label} · ${ex.traderCount.toLocaleString()} ${t('traders')}`}
                aria-hidden={duplicate || undefined}
                tabIndex={duplicate ? -1 : undefined}
                title={`${label} · ${ex.traderCount.toLocaleString()} ${t('traders')}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                  e.preventDefault()
                  const params = new URLSearchParams(searchParams.toString())
                  params.set('range', timeRange)
                  params.set('exchange', ex.filterSource)
                  params.delete('ex')
                  params.delete('page')
                  router.replace(`?${params.toString()}`, { scroll: false })
                  trackEvent('ranking_filter', {
                    kind: 'source_marquee',
                    value: ex.filterSource,
                    registry_slug: ex.registrySlug,
                    time_range: timeRange,
                  })
                  // Scroll to ranking table and trigger exchange filter
                  const event = new CustomEvent('arena:filter-exchange', {
                    detail: { exchange: ex.filterSource },
                  })
                  window.dispatchEvent(event)
                  document
                    .querySelector('.home-ranking-section')
                    ?.scrollIntoView({ behavior: 'smooth' })
                }}
                className="exchange-item"
                style={{ ...sharedStyle, cursor: 'pointer' }}
              >
                {content}
              </a>
            )
          })
        )}
      </div>

      <style>{`
        @keyframes exchange-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .exchange-scroll-track { animation: none !important; transform: none !important; }
        }
        .exchange-scroll-track:hover,
        .exchange-scroll-track:focus-within {
          animation-play-state: paused !important;
        }
        .exchange-item:hover {
          background: var(--color-bg-hover) !important;
          color: var(--color-text-primary) !important;
        }
        .exchange-item:focus-visible {
          outline: 2px solid var(--color-accent-primary);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  )
}
