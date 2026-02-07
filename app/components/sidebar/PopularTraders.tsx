'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
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

const RANK_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32'] // gold, silver, bronze

function AvatarFallback({ name, size = 40 }: { name: string; size?: number }) {
  const initial = (name || '?').charAt(0).toUpperCase()
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

export default function PopularTraders() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [traders, setTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const { data } = await supabase
          .from('trader_sources')
          .select(`
            source, source_trader_id, handle, followers, roi,
            trader_snapshots!trader_snapshots_source_source_trader_id_fkey(avatar_url)
          `)
          .order('followers', { ascending: false })
          .limit(10)
        const mapped = (data || []).map((d: any) => ({
          source: d.source,
          source_trader_id: d.source_trader_id,
          handle: d.handle,
          followers: d.followers,
          roi: d.roi,
          avatar_url: d.trader_snapshots?.[0]?.avatar_url ?? d.trader_snapshots?.avatar_url ?? null,
        }))
        setTraders(mapped)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const platformLabel = (source: string) => {
    const labels: Record<string, string> = {
      binance: 'Binance',
      okx: 'OKX',
      bitget: 'Bitget',
      bybit: 'Bybit',
    }
    return labels[source.toLowerCase()] || source
  }

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
            const displayName = t.handle || t.source_trader_id.slice(0, 8)
            return (
              <Link
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
                {t.avatar_url ? (
                  <Image
                    src={t.avatar_url}
                    alt={displayName}
                    width={40}
                    height={40}
                    style={{
                      borderRadius: tokens.radius.full,
                      objectFit: 'cover',
                      minWidth: 40,
                    }}
                  />
                ) : (
                  <AvatarFallback name={displayName} size={40} />
                )}

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
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                      marginTop: 1,
                    }}
                  >
                    {platformLabel(t.source)}
                    {t.followers != null && (
                      <span style={{ marginLeft: 6 }}>
                        {t.followers.toLocaleString()} {isZh ? '关注' : 'followers'}
                      </span>
                    )}
                  </div>
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
