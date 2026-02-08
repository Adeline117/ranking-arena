'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
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

const RANK_COLORS = ['#FFD700', '#C0C0C0', '#CD7F32']

const PLATFORM_LABELS: Record<string, string> = {
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

export default function TopTraders() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [traders, setTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        // Step 1: Get top traders from snapshots (by arena_score, with ROI threshold)
        const { data: snapData, error: snapErr } = await supabase
          .from('trader_snapshots')
          .select('source, source_trader_id, roi, arena_score')
          .eq('season_id', '90D')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .lt('roi', 10000)  // Filter out anomalous ROI (>10000%)
          .order('arena_score', { ascending: false })
          .limit(10)

        if (snapErr || !snapData || snapData.length === 0) {
          setTraders([])
          setLoading(false)
          return
        }

        // Step 2: Batch fetch handles/avatars from trader_sources
        const { data: sourceData } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, avatar_url')
          .eq('is_active', true)
          .in('source', snapData.map(d => d.source))
          .in('source_trader_id', snapData.map(d => d.source_trader_id))

        const sourceMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
        if (sourceData) {
          sourceData.forEach(s => sourceMap.set(`${s.source}:${s.source_trader_id}`, { handle: s.handle, avatar_url: s.avatar_url }))
        }

        const mapped: Trader[] = snapData.map(d => {
          const src = sourceMap.get(`${d.source}:${d.source_trader_id}`)
          return {
            source: d.source,
            source_trader_id: d.source_trader_id,
            handle: src?.handle || null,
            avatar_url: src?.avatar_url || null,
            roi: d.roi,
            arena_score: d.arena_score,
          }
        })
        setTraders(mapped)
      } catch {
        setError(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {traders.map((t, idx) => {
            // Show handle if available and not an address; otherwise format address nicely
            const isAddress = (s: string) => /^0x[0-9a-fA-F]{10,}$/.test(s)
            const isLongNumeric = (s: string) => /^\d{10,}$/.test(s)
            const formatAddr = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`
            const formatId = (s: string) => isAddress(s) ? formatAddr(s) : isLongNumeric(s) ? `ID ${s.slice(-6)}` : s
            const displayName = t.handle && !isAddress(t.handle) && !isLongNumeric(t.handle)
              ? t.handle
              : t.handle
                ? formatId(t.handle)
                : formatId(t.source_trader_id)
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
                    fontSize: tokens.typography.fontSize.base,
                    fontWeight: tokens.typography.fontWeight.extrabold,
                    minWidth: 20,
                    textAlign: 'right',
                    color: idx < 3 ? RANK_COLORS[idx] : tokens.colors.text.tertiary,
                  }}
                >
                  {idx + 1}
                </span>

                {/* Avatar */}
                <TraderAvatar name={displayName} avatarUrl={t.avatar_url} size={36} />

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.semibold,
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
                      display: 'flex',
                      gap: 8,
                      fontSize: tokens.typography.fontSize.xs,
                      color: tokens.colors.text.tertiary,
                      marginTop: 1,
                    }}
                  >
                    <span>{PLATFORM_LABELS[t.source.toLowerCase()] || t.source}</span>
                    {t.arena_score != null && (
                      <span style={{ color: tokens.colors.text.secondary }}>
                        {isZh ? '积分' : 'Score'} {t.arena_score.toFixed(0)}
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
