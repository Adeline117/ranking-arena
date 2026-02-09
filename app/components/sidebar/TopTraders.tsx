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

const PLATFORM_LABELS: Record<string, string> = {
  binance: 'Binance',
  okx: 'OKX',
  bitget: 'Bitget',
  bybit: 'Bybit',
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
        background: 'linear-gradient(135deg, rgba(139,111,168,0.3), rgba(212,168,67,0.3))',
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

const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function TopTraders() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const { data, error, isLoading } = useSWR<{ traders: Trader[] }>(
    '/api/sidebar/top-traders',
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000, // 1 minute dedup
      refreshInterval: 60000, // Refresh every 5 minutes
    }
  )

  const traders = data?.traders || []
  const loading = isLoading

  return (
    <SidebarCard title={`Top 10 ${isZh ? '交易员' : 'Traders'}`}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton" style={{ height: 48, borderRadius: tokens.radius.md }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '加载失败，请刷新重试' : 'Failed to load. Refresh to retry.'}
        </div>
      ) : traders.length === 0 ? (
        <div style={{ padding: '12px 0', textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {isZh ? '暂无数据' : 'No data available'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {traders.map((t, idx) => {
            const isAddress = (s: string) => /^0x[0-9a-fA-F]{10,}$/.test(s)
            const isLongNumeric = (s: string) => /^\d{10,}$/.test(s)
            const formatAddr = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`
            const formatId = (s: string) => isAddress(s) ? formatAddr(s) : isLongNumeric(s) ? `ID ${s.slice(-6)}` : s
            const displayName = t.handle && !isAddress(t.handle) && !isLongNumeric(t.handle)
              ? t.handle
              : t.handle
                ? formatId(t.handle)
                : formatId(t.source_trader_id)
            const roiStr = t.roi != null
              ? `${t.roi >= 0 ? '+' : ''}${t.roi >= 1000 ? `${(t.roi / 1000).toFixed(1)}K` : t.roi.toFixed(1)}%`
              : null
            return (
              <Link prefetch={false}
                key={`${t.source}-${t.source_trader_id}`}
                href={`/trader/${t.source}/${t.source_trader_id}`}
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
                <TraderAvatar name={displayName} avatarUrl={t.avatar_url} size={32} />

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

                {/* Score on top, ROI below */}
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {t.arena_score != null && (
                    <div style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: getScoreColor(t.arena_score!),
                      lineHeight: 1.3,
                    }}>
                      {t.arena_score.toFixed(0)}
                    </div>
                  )}
                  {roiStr && (
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: t.roi! >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
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
