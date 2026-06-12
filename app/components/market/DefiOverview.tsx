'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { DefiOverview as DefiOverviewData } from '@/lib/utils/defillama'
import { apiFetch } from '@/lib/utils/api-fetch'

function formatTVL(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${value.toLocaleString('en-US')}`
}

const cardStyle = {
  padding: '10px 12px',
  background: tokens.glass.bg.secondary,
  backdropFilter: tokens.glass.blur.md,
  borderRadius: tokens.radius.md,
  border: tokens.glass.border.light,
}

export default function DefiOverview() {
  const { t } = useLanguage()
  const [data, setData] = useState<DefiOverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<DefiOverviewData & { error?: string }>('/api/market/defi')
      .then((json) => {
        if (!json.error) setData(json)
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div style={cardStyle}>
        <div
          className="skeleton"
          style={{ height: 12, width: '40%', marginBottom: 8, borderRadius: tokens.radius.sm }}
        />
        <div
          className="skeleton"
          style={{ height: 18, width: '55%', marginBottom: 6, borderRadius: tokens.radius.sm }}
        />
        <div
          className="skeleton"
          style={{ height: 12, width: '100%', marginBottom: 4, borderRadius: tokens.radius.sm }}
        />
        <div
          className="skeleton"
          style={{ height: 12, width: '90%', marginBottom: 4, borderRadius: tokens.radius.sm }}
        />
        <div
          className="skeleton"
          style={{ height: 12, width: '80%', borderRadius: tokens.radius.sm }}
        />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div style={cardStyle}>
        <div
          style={{
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
            fontSize: 10,
            color: tokens.colors.text.tertiary,
            fontWeight: tokens.typography.fontWeight.medium,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: 6,
          }}
        >
          {t('defiOverview')}
        </div>
        <div
          style={{
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
            fontSize: 11,
            color: tokens.colors.text.tertiary,
            textAlign: 'center',
            padding: '4px 0',
          }}
        >
          {error ? t('sidebarLoadFailed') : t('noDataGeneric')}
        </div>
      </div>
    )
  }

  return (
    <div style={cardStyle}>
      <div
        style={{
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
          fontSize: 10,
          color: tokens.colors.text.tertiary,
          fontWeight: tokens.typography.fontWeight.medium,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 6,
        }}
      >
        {t('defiOverview')}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            fontSize: tokens.typography.fontSize.md,
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
            fontWeight: 800,
            color: tokens.colors.text.primary,
            lineHeight: 1,
          }}
        >
          {formatTVL(data.totalTVL)}
        </span>
        <span
          style={{
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
            fontSize: 11,
            fontWeight: tokens.typography.fontWeight.semibold,
            color:
              data.tvlChange24h >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
          }}
        >
          {data.tvlChange24h >= 0 ? '+' : ''}
          {data.tvlChange24h.toFixed(2)}%
        </span>
      </div>
      {data.topProtocols.slice(0, 3).map((p) => (
        <div
          key={p.id}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '1px 0',
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label)
            fontSize: 11,
          }}
        >
          <span style={{ color: tokens.colors.text.primary }}>{p.name}</span>
          <span style={{ color: tokens.colors.text.secondary }}>{formatTVL(p.tvl)}</span>
        </div>
      ))}
    </div>
  )
}
