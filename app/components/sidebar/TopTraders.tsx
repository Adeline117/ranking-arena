'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { getScoreColor } from '@/lib/utils/score-colors'
import { tokens, RANK_COLORS_ARRAY } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type Trader = {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  roi: number | null
  arena_score: number | null
}

const RANK_COLORS = RANK_COLORS_ARRAY

const _PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance',
  okx: 'OKX',
  bitget: 'Bitget',
  bybit: 'Bybit',
}

 
function TraderAvatar({ name, avatarUrl, size = 36 }: { name: string; avatarUrl: string | null; size?: number }) {
  const [imgError, setImgError] = useState(false)
  const initial = (name || '?').charAt(0).toUpperCase()

  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        style={{
          borderRadius: tokens.radius.full,
          objectFit: 'cover',
          minWidth: size,
          width: size,
          height: size,
        }}
        onError={() => setImgError(true)}
      />
    )
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: tokens.radius.full,
        background: 'linear-gradient(135deg, var(--color-accent-primary-30), var(--color-pro-gold-border))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: tokens.typography.fontWeight.semibold,
        color: tokens.colors.text.primary,
      }}
    >
      {initial}
    </div>
  )
}

const fetcher = async (url: string) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export default function TopTraders() {
  const { t } = useLanguage()

  const { data, error, isLoading, mutate } = useSWR<{ traders: Trader[] }>(
    '/api/sidebar/top-traders',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000, // 1 minute dedup
      refreshInterval: 60000, // Refresh every 1 minute
      errorRetryCount: 2,
    }
  )

  const traders = data?.traders || []
  const loading = isLoading

  return (
    <SidebarCard title={t('sidebarTopTraders')}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 48, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          <div>{t('sidebarLoadFailed')}</div>
          <button
            onClick={() => mutate()}
            style={{ marginTop: 6, padding: '4px 12px', borderRadius: 6, border: `1px solid ${tokens.colors.border.primary}`, background: 'transparent', color: tokens.colors.text.secondary, fontSize: 12, cursor: 'pointer' }}
          >
            {t('retry') || 'Retry'}
          </button>
        </div>
      ) : traders.length === 0 ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {t('noData')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {traders.map((trader, idx) => {
            const isAddress = (s: string) => /^0x[0-9a-fA-F]{10,}$/.test(s)
            const isLongNumeric = (s: string) => /^\d{7,}$/.test(s)
            const formatAddr = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`
            const formatId = (s: string) => isAddress(s) ? formatAddr(s) : isLongNumeric(s) ? `Trader ${s.slice(-6)}` : s
            const displayName = trader.handle && !isAddress(trader.handle) && !isLongNumeric(trader.handle)
              ? trader.handle
              : trader.handle
                ? formatId(trader.handle)
                : formatId(trader.source_trader_id)
            const roiStr = trader.roi != null
              ? `${trader.roi >= 0 ? '+' : ''}${trader.roi >= 1000 ? `${(trader.roi / 1000).toFixed(1)}K` : trader.roi.toFixed(1)}%`
              : null
            return (
              <Link prefetch={false}
                key={`${trader.source}-${trader.source_trader_id}`}
                href={`/trader/${encodeURIComponent(trader.source_trader_id)}?platform=${trader.source}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 4px',
                  textDecoration: 'none',
                  borderRadius: tokens.radius.sm,
                  transition: `background ${tokens.transition.fast}`,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Rank */}
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    minWidth: 16,
                    textAlign: 'right',
                    color: idx < 3 ? RANK_COLORS[idx] : tokens.colors.text.tertiary,
                    flexShrink: 0,
                  }}
                >
                  {idx + 1}
                </span>

                {/* Avatar */}
                <TraderAvatar name={displayName} avatarUrl={trader.avatar_url} size={32} />

                {/* Name only (no platform) */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: tokens.colors.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      lineHeight: 1.3,
                    }}
                  >
                    {displayName}
                  </div>
                </div>

                {/* Arena Score + ROI */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {trader.arena_score != null && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
                      <span style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: 'var(--color-text-tertiary)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        lineHeight: 1.3,
                      }}>
                        Score
                      </span>
                      <span style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: getScoreColor(trader.arena_score!),
                        lineHeight: 1.3,
                        ...(trader.arena_score >= 90 ? { textShadow: '0 0 8px var(--color-accent-primary-60)' } : {}),
                      }}>
                        {trader.arena_score.toFixed(0)}
                      </span>
                    </div>
                  )}
                  {roiStr && (
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: trader.roi! >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        lineHeight: 1.3,
                      }}
                    >
                      {roiStr}
                    </div>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </SidebarCard>
  )
}
