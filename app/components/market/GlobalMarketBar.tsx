'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ErrorState from '@/app/components/ui/ErrorState'
import Metric from '@/app/components/ui/Metric'
import { tokens } from '@/lib/design-tokens'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { apiFetch } from '@/lib/utils/api-fetch'

interface MarketOverview {
  btcPrice: number
  btcChange24h: number
  ethPrice: number
  ethChange24h: number
  totalMarketCap: number
  totalVolume24h: number
  btcDominance: number
  ethGasGwei: number | null
  updatedAt: string
}

/** USD compact including trillions (formatCompact tops out at B). */
function compactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return NULL_DISPLAY
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/**
 * Ticking "Xs / Xm / Xh" since an ISO timestamp; pauses when tab is hidden.
 * Returns the label plus raw age in seconds (-1 if timestamp unusable) so
 * callers can flag stale/delayed data.
 */
function useUpdatedAgo(iso?: string): { label: string; ageSec: number } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
    }, 10_000)
    return () => clearInterval(id)
  }, [])
  if (!iso) return { label: '', ageSec: -1 }
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return { label: '', ageSec: -1 }
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
  return { label, ageSec: s }
}

/**
 * Global market-state bar — surfaces the site-wide aggregates from
 * /api/market/overview (CoinGecko global + Etherscan gas). Only metrics that
 * actually have a data source are shown; when a fallback source (Coinbase /
 * Binance) can't provide market cap / dominance the endpoint returns 0 and we
 * hide those cells rather than render a fake zero.
 */
export default function GlobalMarketBar() {
  const { t } = useLanguage()
  const { data, isLoading, isError, refetch } = useQuery<MarketOverview>({
    queryKey: ['market-overview-bar'],
    queryFn: () => apiFetch<MarketOverview>('/api/market/overview'),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
    // The API already owns its upstream fallback chain. Automatic client retries
    // would hold the first-load skeleton through several 15s timeout windows.
    retry: false,
  })
  const { label: ago, ageSec } = useUpdatedAgo(data?.updatedAt)
  // Data older than 10min is no longer "live" — the upstream refresh window has
  // a gap. Drop the green pulse to a static gray dot + a "delayed" hint so the
  // "live" affordance isn't misleading.
  const isStale = ageSec > 600

  const stats: { label: string; value: number; display: string }[] = []
  if (data) {
    if (data.totalMarketCap > 0)
      stats.push({
        label: t('marketCap'),
        value: data.totalMarketCap,
        display: compactUsd(data.totalMarketCap),
      })
    if (data.totalVolume24h > 0)
      stats.push({
        label: t('volume24h'),
        value: data.totalVolume24h,
        display: compactUsd(data.totalVolume24h),
      })
    if (data.btcDominance > 0)
      stats.push({
        label: t('btcDominance'),
        value: data.btcDominance,
        display: `${data.btcDominance.toFixed(1)}%`,
      })
    if (data.ethGasGwei != null)
      stats.push({
        label: t('ethGas'),
        value: data.ethGasGwei,
        display: `${data.ethGasGwei} Gwei`,
      })
  }

  return (
    <div
      style={{
        maxWidth: 1400,
        margin: '0 auto',
        padding: `${tokens.spacing[2]} ${tokens.spacing[5]} 0`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.spacing[5],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          borderRadius: tokens.radius.lg,
        }}
      >
        {isLoading ? (
          <div
            data-testid="market-overview-loading"
            className="skeleton"
            style={{ height: 36, flex: 1, minWidth: 200, borderRadius: tokens.radius.md }}
          />
        ) : isError && !data ? (
          <div style={{ flex: 1 }}>
            <ErrorState
              title={t('marketDataError')}
              description={t('loadFailedRetryShort')}
              retry={() => void refetch()}
              variant="compact"
            />
          </div>
        ) : stats.length === 0 ? (
          <div
            role="status"
            style={{
              minHeight: 36,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              color: tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('noDataGeneric')}
          </div>
        ) : (
          stats.map((stat) => (
            <Metric
              key={stat.label}
              value={stat.value}
              display={stat.display}
              label={stat.label}
              size="md"
              colorBySign={false}
            />
          ))
        )}
        {stats.length > 0 && (
          <div
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              // eslint-disable-next-line no-restricted-syntax -- off-scale micro label by design
              fontSize: 11,
              color: tokens.colors.text.tertiary,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: isStale ? tokens.colors.text.tertiary : tokens.colors.accent.success,
                display: 'inline-block',
                animation: isStale ? undefined : 'pulse 2s infinite',
              }}
            />
            <span suppressHydrationWarning>
              {ago ? `${t('updatedAgo')}${ago}` : `${t('liveData')} · ${t('autoRefresh')}`}
              {isStale ? ` · ${t('u7mkt_delayed')}` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
