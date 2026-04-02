'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { formatPnL, NULL_DISPLAY } from '@/lib/utils/format'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getScoreColor } from '@/lib/utils/score-colors'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import EmptyState from '@/app/components/ui/EmptyState'

type Period = '7D' | '30D' | '90D'

interface TokenTrader {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  total_pnl: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
}

function getDisplayName(trader: TokenTrader): string {
  if (trader.handle) return trader.handle
  const id = trader.source_trader_id
  return id.length > 10 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id
}

function TraderAvatar({
  avatarUrl,
  traderKey,
  name,
  size = 32,
}: {
  avatarUrl: string | null
  traderKey: string
  name: string
  size?: number
}) {
  const [error, setError] = useState(false)
  if (!avatarUrl || error) {
    if (isWalletAddress(traderKey)) {
      return (
        <img
          src={generateBlockieSvg(traderKey, size)}
          alt={name || 'Wallet avatar'}
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
        />
      )
    }
    return (
      <span style={{ color: tokens.colors.white, fontSize: size * 0.375, fontWeight: 700 }}>
        {getAvatarInitial(name)}
      </span>
    )
  }
  return (
    <img
      src={avatarSrc(avatarUrl)}
      alt={name || 'Trader avatar'}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      onError={() => setError(true)}
    />
  )
}

const TOKEN_COLORS: Record<string, string> = {
  BTC: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  BNB: '#F3BA2F',
  XRP: '#23292F',
  DOGE: '#C2A633',
  ADA: '#0033AD',
  AVAX: '#E84142',
  DOT: '#E6007A',
  MATIC: '#8247E5',
  LINK: '#2A5ADA',
  UNI: '#FF007A',
  ARB: '#12AAFF',
  OP: '#FF0420',
}

function PeriodSelector({
  period,
  onChange,
  loading,
}: {
  period: Period
  onChange: (p: Period) => void
  loading: boolean
}) {
  const { t } = useLanguage()
  const periods: Period[] = ['7D', '30D', '90D']
  const labels: Record<Period, string> = {
    '7D': t('days7'),
    '30D': t('days30'),
    '90D': t('days90'),
  }
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 0,
        padding: 2,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: '1px solid var(--glass-border-light)',
      }}
    >
      {periods.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          disabled={loading}
          style={{
            padding: '6px 14px',
            minHeight: 36,
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: period === p ? 700 : 500,
            background: period === p ? tokens.colors.accent.brand + '20' : 'transparent',
            color: period === p ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1,
            transition: 'all 0.15s',
          }}
        >
          {labels[p]}
        </button>
      ))}
    </div>
  )
}

export default function TokenRankingClient({ token }: { token: string }) {
  const { t } = useLanguage()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlPeriod = (searchParams.get('period')?.toUpperCase() || '90D') as Period
  const validPeriod = (['7D', '30D', '90D'] as const).includes(urlPeriod) ? urlPeriod : ('90D' as Period)

  const [period, setPeriod] = useState<Period>(validPeriod)
  const [traders, setTraders] = useState<TokenTrader[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50
  const abortRef = useRef<AbortController | null>(null)

  const tokenColor = TOKEN_COLORS[token] || tokens.colors.accent.primary

  const fetchData = useCallback(
    async (p: Period, offset: number) => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setLoading(true)
      try {
        const res = await fetch(
          `/api/rankings/by-token?token=${encodeURIComponent(token)}&period=${p}&limit=${PAGE_SIZE}&offset=${offset}`,
          { signal: controller.signal }
        )
        if (!res.ok) throw new Error('Failed')
        const data = await res.json()
        setTraders(data.traders || [])
        setTotal(data.total || 0)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
      } finally {
        setLoading(false)
      }
    },
    [token]
  )

  useEffect(() => {
    fetchData(period, page * PAGE_SIZE)
  }, [period, page, fetchData])

  const handlePeriodChange = useCallback(
    (newPeriod: Period) => {
      setPeriod(newPeriod)
      setPage(0)
      const params = new URLSearchParams(searchParams.toString())
      if (newPeriod === '90D') params.delete('period')
      else params.set('period', newPeriod)
      const qs = params.toString()
      router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <Box>
      {/* Header */}
      <Box style={{ marginBottom: 24 }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <Link
            href="/rankings/tokens"
            style={{ color: tokens.colors.text.tertiary, textDecoration: 'none', fontSize: 14 }}
          >
            {t('tokenRankingsTitle')}
          </Link>
          <span style={{ color: tokens.colors.text.tertiary }}>/</span>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Box
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: `${tokenColor}20`,
              border: `2px solid ${tokenColor}40`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              fontWeight: 800,
              color: tokenColor,
            }}
          >
            {token.charAt(0)}
          </Box>
          <Box>
            <Text size="2xl" weight="bold" style={{ color: tokens.colors.text.primary }}>
              {t('tokenRankingHeader').replace('{token}', token)}
            </Text>
            <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
              {total > 0
                ? t('tokenRankingCount')
                    .replace('{count}', total.toLocaleString())
                    .replace('{token}', token)
                : t('tokenRankingNoData').replace('{token}', token)}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Period Selector */}
      <Box style={{ marginBottom: 16 }}>
        <PeriodSelector period={period} onChange={handlePeriodChange} loading={loading} />
      </Box>

      {/* Loading */}
      {loading && (
        <Box style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <div
            style={{
              width: 24,
              height: 24,
              border: `2px solid ${tokens.colors.accent.brand}30`,
              borderTopColor: tokens.colors.accent.brand,
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <style>{'@keyframes spin { to { transform: rotate(360deg) } }'}</style>
        </Box>
      )}

      {/* Results Table */}
      {!loading && traders.length > 0 && (
        <>
          <style>{`.token-row:hover { background: var(--overlay-hover) !important; }`}</style>
          <Box
            style={{
              borderRadius: tokens.radius.lg,
              overflow: 'hidden',
              background: 'var(--overlay-hover)',
              border: '1px solid var(--glass-border-light)',
            }}
          >
            {/* Header Row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '40px minmax(140px, 1fr) 100px 100px 80px 80px 80px 80px',
                gap: 8,
                padding: '12px 16px',
                fontSize: 12,
                fontWeight: 600,
                color: tokens.colors.text.secondary,
                borderBottom: '1px solid var(--glass-border-light)',
                background: 'var(--color-bg-primary)',
              }}
            >
              <div>#</div>
              <div>{t('rankingTrader')}</div>
              <div style={{ textAlign: 'right' }}>{token} PnL</div>
              <div style={{ textAlign: 'right' }}>{t('tokenRankingTotalPnl')}</div>
              <div style={{ textAlign: 'right' }}>{t('tokenRankingTrades')}</div>
              <div style={{ textAlign: 'right' }}>{t('rankingWinRate')}</div>
              <div style={{ textAlign: 'right' }}>ROI</div>
              <div style={{ textAlign: 'right' }}>{t('rankingScore')}</div>
            </div>

            {/* Data Rows */}
            {traders.map((trader, i) => {
              const rank = page * PAGE_SIZE + i + 1
              const name = getDisplayName(trader)
              const platformName = EXCHANGE_NAMES[trader.source] || trader.source

              return (
                <Link
                  key={`${trader.source}:${trader.source_trader_id}`}
                  href={`/trader/${encodeURIComponent(trader.handle || trader.source_trader_id)}?platform=${trader.source}`}
                  className="token-row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '40px minmax(140px, 1fr) 100px 100px 80px 80px 80px 80px',
                    gap: 8,
                    padding: '10px 16px',
                    alignItems: 'center',
                    textDecoration: 'none',
                    borderBottom: '1px solid var(--overlay-hover)',
                    transition: 'background 0.15s',
                    ...(rank <= 3
                      ? {
                          background:
                            rank === 1
                              ? 'linear-gradient(135deg, rgba(255,215,0,0.10), transparent 80%)'
                              : rank === 2
                                ? 'linear-gradient(135deg, rgba(192,192,192,0.08), transparent 80%)'
                                : 'linear-gradient(135deg, rgba(205,127,50,0.08), transparent 80%)',
                          boxShadow: `inset 3px 0 0 ${rank === 1 ? '#FFD700' : rank === 2 ? '#C0C0C0' : '#CD7F32'}`,
                        }
                      : {}),
                  }}
                >
                  {/* Rank */}
                  <div>
                    {rank <= 3 ? (
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
                          background:
                            rank === 1
                              ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                              : rank === 2
                                ? 'linear-gradient(135deg, #C0C0C0, #A0A0A0)'
                                : 'linear-gradient(135deg, #CD7F32, #A0522D)',
                          color: rank === 1 ? 'var(--color-bg-primary)' : 'var(--color-on-accent)',
                        }}
                      >
                        {rank}
                      </span>
                    ) : (
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
                    )}
                  </div>

                  {/* Trader */}
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
                        background: getAvatarGradient(trader.source_trader_id),
                      }}
                    >
                      <TraderAvatar
                        avatarUrl={trader.avatar_url}
                        traderKey={trader.source_trader_id}
                        name={name}
                        size={32}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: tokens.colors.text.primary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <ExchangeLogo exchange={trader.source} size={12} />
                        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                          {platformName}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Token PnL */}
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: 13,
                      fontWeight: 700,
                      color:
                        trader.token_pnl >= 0
                          ? tokens.colors.accent.success
                          : tokens.colors.accent.error,
                    }}
                  >
                    {formatPnL(trader.token_pnl)}
                  </div>

                  {/* Total PnL */}
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: 13,
                      fontWeight: 600,
                      color:
                        trader.total_pnl >= 0
                          ? tokens.colors.accent.success
                          : tokens.colors.accent.error,
                    }}
                  >
                    {formatPnL(trader.total_pnl)}
                  </div>

                  {/* Trade Count */}
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: 13,
                      fontWeight: 600,
                      color: tokens.colors.text.secondary,
                    }}
                  >
                    {trader.token_trade_count}
                  </div>

                  {/* Win Rate */}
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: 13,
                      fontWeight: 600,
                      color:
                        trader.token_win_rate != null
                          ? trader.token_win_rate >= 50
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error
                          : tokens.colors.text.tertiary,
                    }}
                  >
                    {trader.token_win_rate != null
                      ? `${trader.token_win_rate.toFixed(1)}%`
                      : NULL_DISPLAY}
                  </div>

                  {/* ROI */}
                  <div
                    style={{
                      textAlign: 'right',
                      fontSize: 13,
                      fontWeight: 600,
                      color:
                        trader.roi != null
                          ? trader.roi >= 0
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error
                          : tokens.colors.text.tertiary,
                    }}
                  >
                    {trader.roi != null
                      ? `${trader.roi >= 0 ? '+' : ''}${trader.roi.toFixed(1)}%`
                      : NULL_DISPLAY}
                  </div>

                  {/* Arena Score */}
                  <div style={{ textAlign: 'right', display: 'flex', justifyContent: 'flex-end' }}>
                    {trader.arena_score != null ? (
                      <span
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          border: `2px solid ${getScoreColor(trader.arena_score)}`,
                          background: `color-mix(in srgb, ${getScoreColor(trader.arena_score)} 10%, transparent)`,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                          fontWeight: 800,
                          color: getScoreColor(trader.arena_score),
                        }}
                      >
                        {trader.arena_score.toFixed(0)}
                      </span>
                    ) : (
                      <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
                        {NULL_DISPLAY}
                      </span>
                    )}
                  </div>
                </Link>
              )
            })}
          </Box>

          {/* Pagination */}
          {totalPages > 1 && (
            <Box style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '20px 0' }}>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  padding: '8px 16px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: page === 0 ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  cursor: page === 0 ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                }}
              >
                {t('tokenRankingPrev')}
              </button>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 13,
                  color: tokens.colors.text.secondary,
                }}
              >
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                style={{
                  padding: '8px 16px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color:
                    page >= totalPages - 1
                      ? tokens.colors.text.tertiary
                      : tokens.colors.text.primary,
                  cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                }}
              >
                {t('tokenRankingNext')}
              </button>
            </Box>
          )}
        </>
      )}

      {/* Empty State */}
      {!loading && traders.length === 0 && (
        <EmptyState
          icon={
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
          }
          title={t('tokenRankingNoData').replace('{token}', token)}
          description={t('tokenRankingNoDataDesc')}
          action={
            <Link
              href="/rankings/tokens"
              style={{
                display: 'inline-block',
                padding: '8px 20px',
                borderRadius: tokens.radius.md,
                background: 'var(--color-accent-primary)',
                color: 'var(--color-bg-primary)',
                textDecoration: 'none',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {t('tokenRankingBrowseAll')}
            </Link>
          }
        />
      )}
    </Box>
  )
}
