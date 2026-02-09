'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens, RANK_COLORS_ARRAY } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import SidebarCard from './SidebarCard'

type Trader = {
  source: string
  source_trader_id: string
  handle: string | null
  followers: number | null
  roi: number | null
  avatar_url: string | null
}

const RANK_COLORS = RANK_COLORS_ARRAY

function TraderAvatar({ name, avatarUrl, size = 40 }: { name: string; avatarUrl: string | null; size?: number }) {
  const [imgError, setImgError] = useState(false)
  const initial = (name || '?').charAt(0).toUpperCase()

  if (avatarUrl && !imgError) {
    return (
      <Image
        src={`/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
        alt={name}
        width={size}
        height={size}
        sizes={`${size}px`}
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

export default function PopularTraders({ limit = 10 }: { limit?: number } = {}) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [traders, setTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        // Use rankings API to stay in sync with the main leaderboard
        const res = await fetch(`/api/rankings?window=90D&sort_by=arena_score&sort_dir=desc&limit=${limit}`)
        if (!res.ok) throw new Error('Failed to fetch')
        const data = await res.json()
        const rows = data?.data || []

        const mapped: Trader[] = rows.map((r: { platform: string; trader_key: string; display_name: string | null; avatar_url: string | null; metrics: { followers?: number | null; roi?: number | null } }) => ({
          source: r.platform,
          source_trader_id: r.trader_key,
          handle: r.display_name,
          followers: r.metrics?.followers ?? null,
          roi: r.metrics?.roi ?? null,
          avatar_url: r.avatar_url,
        }))
        setTraders(mapped)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
    // Auto-refresh every 60s to stay in sync with rankings
    const interval = setInterval(load, 60000)
    return () => clearInterval(interval)
  }, [limit])

  return (
    <SidebarCard title={isZh ? '热门交易员' : 'Popular Traders'}>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2, 3].map(i => (
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {traders.map((t, idx) => {
            // Show handle if available and not an address; otherwise format address nicely
            const isAddress = (s: string) => /^0x[0-9a-fA-F]{10,}$/.test(s)
            const formatAddr = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`
            const displayName = t.handle && !isAddress(t.handle)
              ? t.handle
              : t.handle
                ? formatAddr(t.handle)
                : formatAddr(t.source_trader_id)
            return (
              <Link prefetch={false}
                key={`${t.source}-${t.source_trader_id}`}
                href={`/trader/${t.source}/${t.source_trader_id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 6px',
                  textDecoration: 'none',
                  borderRadius: tokens.radius.md,
                  transition: `background ${tokens.transition.fast}`,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.tertiary)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Rank */}
                <span
                  style={{
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: tokens.typography.fontWeight.bold,
                    minWidth: 18,
                    textAlign: 'right',
                    color: idx < 3 ? RANK_COLORS[idx] : tokens.colors.text.tertiary,
                  }}
                >
                  {idx + 1}
                </span>

                {/* Avatar */}
                <TraderAvatar name={displayName} avatarUrl={t.avatar_url} size={40} />

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.medium,
                      color: tokens.colors.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {displayName}
                  </div>
                  {t.followers != null && (
                    <div
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        color: tokens.colors.text.tertiary,
                        marginTop: 1,
                      }}
                    >
                      {t.followers.toLocaleString()} {isZh ? '关注' : 'followers'}
                    </div>
                  )}
                </div>

                {/* ROI */}
                {t.roi != null && (
                  <span
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      fontWeight: tokens.typography.fontWeight.semibold,
                      color: t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.roi >= 0 ? '+' : ''}{t.roi.toFixed(1)}%
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </SidebarCard>
  )
}
