'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatROI } from '@/app/components/ranking/utils'
import { Sparkline } from '@/app/components/ui/Sparkline'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

interface TraderData {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  platform: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  followers: number | null
}

type ViewMode = 'table' | 'card'

function getDisplayName(t: TraderData): string {
  if (t.display_name && !(t.display_name.length > 10 && /^\d+$/.test(t.display_name))) {
    return t.display_name
  }
  const shortKey = t.trader_key.length > 10
    ? `${t.trader_key.slice(0, 4)}...${t.trader_key.slice(-4)}`
    : t.trader_key
  return shortKey
}

function TraderAvatarImg({ avatarUrl, traderKey: _traderKey, name, size = 32 }: { avatarUrl: string | null; traderKey: string; name: string; size?: number }) {
  const [error, setError] = useState(false)
  if (!avatarUrl || error) {
    return <span style={{ color: tokens.colors.white, fontSize: size * 0.375, fontWeight: 700 }}>{getAvatarInitial(name)}</span>
  }
  return (
    <Image
      src={avatarUrl}
      alt=""
      width={size}
      height={size}
      sizes={`${size}px`}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      onError={() => setError(true)}
    />
  )
}

function RankBadge({ rank }: { rank: number }) {
  if (rank > 3) {
    return (
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: tokens.colors.text.secondary,
          minWidth: 28,
          textAlign: 'center',
          display: 'inline-block',
        }}
      >
        {rank}
      </span>
    )
  }
  const bg =
    rank === 1
      ? 'linear-gradient(135deg, #FFD700, #FFA500)'
      : rank === 2
      ? 'linear-gradient(135deg, #C0C0C0, #A0A0A0)'
      : 'linear-gradient(135deg, #CD7F32, #A0522D)'
  return (
    <span
      style={{
        width: 28,
        height: 28,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 700,
        background: bg,
        color: rank === 1 ? 'var(--color-bg-primary)' : 'var(--color-on-accent)',
      }}
    >
      {rank}
    </span>
  )
}

// Mobile card component
function TraderCardItem({ trader, rank }: { trader: TraderData; rank: number }) {
  const name = getDisplayName(trader)
  const roiColor = trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <Link
      href={`/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`}
      style={{ textDecoration: 'none', display: 'block' }}
    >
      <div
        style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          background: 'var(--overlay-hover)',
          border: '1px solid var(--glass-border-light)',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[3],
          transition: `transform ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
          boxShadow: tokens.shadow.sm,
        }}
      >
        {/* Top: rank + avatar + name + ROI */}
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <RankBadge rank={rank} />
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              background: getAvatarGradient(trader.trader_key),
            }}
          >
            <TraderAvatarImg avatarUrl={trader.avatar_url} traderKey={trader.trader_key} name={name} size={40} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </div>
            <div style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
              {EXCHANGE_NAMES[trader.platform] || trader.platform}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: roiColor }}>
              {formatROI(trader.roi)}
            </div>
            <Sparkline roi={trader.roi} width={60} height={16} />
          </div>
        </div>

        {/* Bottom stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[2] }}>
          <StatBlock label="胜率" value={trader.win_rate != null ? `${trader.win_rate.toFixed(0)}%` : 'N/A'} color={trader.win_rate && trader.win_rate > 50 ? tokens.colors.accent.success : undefined} />
          <StatBlock label="MDD" value={trader.max_drawdown != null ? `-${Math.abs(trader.max_drawdown).toFixed(0)}%` : 'N/A'} color={trader.max_drawdown ? tokens.colors.accent.error + 'cc' : undefined} />
          <StatBlock label="Arena Score" value={trader.arena_score != null ? trader.arena_score.toFixed(0) : '--'} color={trader.arena_score ? tokens.colors.accent.brand : undefined} />
        </div>
      </div>
    </Link>
  )
}

function StatBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '6px 0', borderRadius: tokens.radius.md, background: 'var(--overlay-hover)' }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: color || tokens.colors.text.primary }}>{value}</div>
    </div>
  )
}

export default function ExchangeRankingClient({
  traders,
}: {
  traders: TraderData[]
  exchange?: string
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('table')

  // Auto-detect mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setViewMode(mq.matches ? 'card' : 'table')
    const handler = (e: MediaQueryListEvent) => setViewMode(e.matches ? 'card' : 'table')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  if (traders.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: tokens.spacing[8], color: tokens.colors.text.tertiary }}>
        <div style={{ fontSize: 40, marginBottom: tokens.spacing[3] }}>📊</div>
        <div style={{ fontSize: tokens.typography.fontSize.base, fontWeight: 600, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2] }}>
          暂无排行数据
        </div>
        <div style={{ fontSize: tokens.typography.fontSize.sm }}>
          该平台的排行数据正在收集中，请稍后再来查看
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* View toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: tokens.spacing[4] }}>
        <button
          onClick={() => setViewMode('table')}
          style={{
            padding: '6px 16px',
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: viewMode === 'table' ? 700 : 500,
            background: viewMode === 'table' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)',
            color: viewMode === 'table' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          表格
        </button>
        <button
          onClick={() => setViewMode('card')}
          style={{
            padding: '6px 16px',
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: viewMode === 'card' ? 700 : 500,
            background: viewMode === 'card' ? tokens.colors.accent.brand + '30' : 'var(--glass-border-light)',
            color: viewMode === 'card' ? tokens.colors.accent.brand : tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          卡片
        </button>
      </div>

      {viewMode === 'card' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: tokens.spacing[3] }}>
          {traders.map((t, i) => (
            <TraderCardItem key={`${t.platform}:${t.trader_key}`} trader={t} rank={i + 1} />
          ))}
        </div>
      ) : (
        <div
          style={{
            borderRadius: tokens.radius.lg,
            overflow: 'hidden',
            background: 'var(--overlay-hover)',
            border: '1px solid var(--glass-border-light)',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr 80px 80px 70px 70px 70px',
              gap: 8,
              padding: '12px 16px',
              fontSize: 12,
              fontWeight: 600,
              color: tokens.colors.text.secondary,
              borderBottom: '1px solid var(--glass-border-light)',
            }}
          >
            <div>#</div>
            <div>交易员</div>
            <div style={{ textAlign: 'right' }}>ROI</div>
            <div style={{ textAlign: 'center' }}>趋势</div>
            <div style={{ textAlign: 'right' }}>胜率</div>
            <div style={{ textAlign: 'right' }}>MDD</div>
            <div style={{ textAlign: 'right' }}>Score</div>
          </div>
          {/* Rows */}
          {traders.map((t, i) => {
            const name = getDisplayName(t)
            const roiColor = t.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
            return (
              <Link
                key={`${t.platform}:${t.trader_key}`}
                href={`/trader/${encodeURIComponent(t.trader_key)}?platform=${t.platform}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '40px 1fr 80px 80px 70px 70px 70px',
                  gap: 8,
                  padding: '10px 16px',
                  alignItems: 'center',
                  textDecoration: 'none',
                  borderBottom: '1px solid var(--overlay-hover)',
                  transition: 'background 0.15s',
                }}
              >
                <div><RankBadge rank={i + 1} /></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      background: getAvatarGradient(t.trader_key),
                    }}
                  >
                    <TraderAvatarImg avatarUrl={t.avatar_url} traderKey={t.trader_key} name={name} size={32} />
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.text.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                  </span>
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: roiColor }}>
                  {formatROI(t.roi)}
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Sparkline roi={t.roi} width={72} height={20} />
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, color: tokens.colors.text.secondary }}>
                  {t.win_rate != null ? `${t.win_rate.toFixed(0)}%` : 'N/A'}
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, color: t.max_drawdown ? tokens.colors.accent.error + 'cc' : tokens.colors.text.tertiary }}>
                  {t.max_drawdown != null ? `-${Math.abs(t.max_drawdown).toFixed(0)}%` : 'N/A'}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {t.arena_score != null ? (
                    <span style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.accent.brand }}>
                      {t.arena_score.toFixed(0)}
                    </span>
                  ) : (
                    <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>--</span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
