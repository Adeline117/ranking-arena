/**
 * LiveTradesFeed - 实时交易流组件
 * 表格格式: 交易所(彩色badge) | 交易对 | 方向 | 价格 | 数量 | 价值 | 时间
 */

'use client'

import { useRef, useState, useEffect, useCallback, memo } from 'react'
import { useMarketFeed } from '@/lib/hooks/useMarketFeed'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { NormalizedTrade, ExchangeId } from '@/lib/ws/exchange-feeds'

const EXCHANGE_COLORS: Record<ExchangeId, string> = {
  binance: 'var(--color-chart-amber)',
  bybit: 'var(--color-score-below)',
  okx: 'var(--color-score-profitability)',
}

const EXCHANGE_BG: Record<ExchangeId, string> = {
  binance: 'var(--color-orange-subtle)',
  bybit: 'var(--color-orange-subtle)',
  okx: 'var(--color-accent-primary-15)',
}

const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
}

const ALL_EXCHANGES: ExchangeId[] = ['binance', 'bybit', 'okx']

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

function formatAmount(amount: number): string {
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}K`
  if (amount >= 1) return amount.toFixed(4)
  return amount.toFixed(6)
}

function formatValue(notional: number): string {
  if (notional >= 1000000) return `$${(notional / 1000000).toFixed(1)}M`
  if (notional >= 1000) return `$${(notional / 1000).toFixed(1)}K`
  return `$${notional.toFixed(0)}`
}

function timeAgo(ts: number, tFn: (key: string) => string): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 1) return tFn('tradeJustNow')
  if (sec < 60) return `${sec}${tFn('tradeSecondsAgo')}`
  return `${Math.floor(sec / 60)}${tFn('tradeMinutesAgo')}`
}

const TradeRow = memo(function TradeRow({
  trade,
  index,
}: {
  trade: NormalizedTrade
  index: number
}) {
  const { t } = useLanguage()
  const isBuy = trade.side === 'buy'
  const sideColor = isBuy ? tokens.colors.accent.success : tokens.colors.accent.error
  const isEven = index % 2 === 0
  const sym = trade.pair
    .replace('/USDT', '')
    .replace('-USDT', '')
    .replace('/USDC', '')
    .replace('-USDC', '')
    .replace('USDT', '')
    .replace('USDC', '')
  const exchColor = EXCHANGE_COLORS[trade.exchange] || tokens.colors.text.tertiary
  const exchBg = EXCHANGE_BG[trade.exchange] || 'transparent'

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '58px 40px 38px 1fr 52px 52px 42px',
        alignItems: 'center',
        gap: 4,
        padding: `3px ${tokens.spacing[2]}`,
        background: isEven ? tokens.glass.bg.light : 'transparent',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table, fixed grid columns)
        fontSize: 10,
        fontFamily: 'var(--font-mono, monospace)',
        minHeight: 26,
      }}
    >
      {/* 交易所 badge */}
      <span
        style={{
          display: 'inline-block',
          padding: `1px ${tokens.spacing[1]}`,
          borderRadius: tokens.radius.sm,
          background: exchBg,
          color: exchColor,
          fontWeight: tokens.typography.fontWeight.bold,
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table)
          fontSize: 10,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {EXCHANGE_LABELS[trade.exchange] || trade.exchange}
      </span>

      {/* 交易对 */}
      <span
        style={{
          color: tokens.colors.text.primary,
          fontWeight: tokens.typography.fontWeight.semibold,
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table)
          fontSize: 10,
        }}
      >
        {sym}
      </span>

      {/* 方向 */}
      <span
        style={{
          color: sideColor,
          fontWeight: tokens.typography.fontWeight.bold,
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table)
          fontSize: 10,
        }}
      >
        {isBuy ? t('tradeBuy') : t('tradeSell')}
      </span>

      {/* 价格 */}
      <span
        style={
          {
            color: sideColor,
            textAlign: 'right',
            fontWeight: tokens.typography.fontWeight.semibold,
            fontVariantNumeric: 'tabular-nums',
          } as React.CSSProperties
        }
      >
        ${formatPrice(trade.price)}
      </span>

      {/* 数量 */}
      <span
        style={{
          color: tokens.colors.text.secondary,
          textAlign: 'right',
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table)
          fontSize: 9,
        }}
      >
        {formatAmount(trade.amount)}
      </span>

      {/* 价值 */}
      <span
        style={{
          color: tokens.colors.text.tertiary,
          textAlign: 'right',
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table)
          fontSize: 9,
        }}
      >
        {formatValue(trade.notional)}
      </span>

      {/* 时间 */}
      <span
        style={{
          color: tokens.colors.text.tertiary,
          textAlign: 'right',
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table)
          fontSize: 9,
        }}
      >
        {timeAgo(trade.timestamp, t as (key: string) => string)}
      </span>
    </div>
  )
})

function ConnectionDot({ connected, label }: { connected: boolean; label: string }) {
  // B3 colorblind redundancy (WCAG 1.4.1): the adjacent text is the feed TITLE,
  // not the connection state, so color must not be the only signal. Shape
  // redundancy: filled dot = connected, hollow ring = disconnected; plus an
  // accessible name for screen readers.
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: connected ? tokens.colors.accent.success : 'transparent',
        border: connected ? 'none' : `1.5px solid ${tokens.colors.accent.error}`,
        boxSizing: 'border-box',
        marginRight: 4,
      }}
    />
  )
}

export default function LiveTradesFeed() {
  const { t } = useLanguage()
  const feedCardRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  // A live stream keeps a Node function occupied for its full connection
  // lifetime. This card is below the primary market content, so only connect
  // while it is actually near the viewport; leaving the area releases the SSE
  // subscription via useMarketFeed cleanup.
  const { trades, connected, error, retry } = useMarketFeed({
    maxTrades: 150,
    enabled: nearViewport,
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [exchangeFilter, setExchangeFilter] = useState<Set<ExchangeId>>(new Set(ALL_EXCHANGES))

  useEffect(() => {
    const node = feedCardRef.current
    if (!node) return
    // Conservative compatibility fallback: preserving the former behaviour
    // is better than rendering a permanently idle card in an older browser.
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      // Begin connecting just before the card scrolls into view, without
      // holding a stream for visitors who never reach this below-fold widget.
      { rootMargin: '300px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!paused && containerRef.current) containerRef.current.scrollTop = 0
  }, [trades.length, paused])

  const handleMouseEnter = useCallback(() => setPaused(true), [])
  const handleMouseLeave = useCallback(() => setPaused(false), [])

  const toggleExchange = useCallback((ex: ExchangeId) => {
    setExchangeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(ex)) {
        if (next.size > 1) next.delete(ex)
      } else {
        next.add(ex)
      }
      return next
    })
  }, [])

  const filteredTrades = trades.filter((tr) => exchangeFilter.has(tr.exchange))

  return (
    <div
      ref={feedCardRef}
      style={{
        background: tokens.glass.bg.medium,
        border: tokens.glass.border.light,
        borderRadius: tokens.radius.xl,
        overflow: 'hidden',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: tokens.gradient.purple,
          opacity: 0.6,
        }}
      />

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ConnectionDot
            connected={connected}
            label={connected ? t('connected') : t('disconnected')}
          />
          <span
            style={{
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
            }}
          >
            {t('liveTradesFeed')}
          </span>
          {filteredTrades.length > 0 && (
            <span
              style={{
                // eslint-disable-next-line no-restricted-syntax -- off-scale by design (compact count badge)
                fontSize: 10,
                color: tokens.colors.text.tertiary,
                fontWeight: tokens.typography.fontWeight.medium,
                padding: `1px ${tokens.spacing[1]}`,
                borderRadius: tokens.radius.sm,
                background: tokens.colors.bg.tertiary,
              }}
            >
              {filteredTrades.length}
              {t('tradeCountSuffix')}
            </span>
          )}
        </div>

        {/* Exchange filters */}
        <div style={{ display: 'flex', gap: 3 }}>
          {ALL_EXCHANGES.map((ex) => {
            const active = exchangeFilter.has(ex)
            return (
              <button
                key={ex}
                type="button"
                onClick={() => toggleExchange(ex)}
                aria-pressed={active}
                style={{
                  padding: `1px ${tokens.spacing[1]}`,
                  // eslint-disable-next-line no-restricted-syntax -- off-scale by design (compact filter pill)
                  fontSize: 10,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  borderRadius: tokens.radius.sm,
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? EXCHANGE_BG[ex] : 'transparent',
                  color: active ? EXCHANGE_COLORS[ex] : tokens.colors.text.tertiary,
                  opacity: active ? 1 : 0.5,
                  transition: 'all 0.15s ease',
                }}
              >
                {EXCHANGE_LABELS[ex]}
              </button>
            )
          })}
        </div>
      </div>

      {/* Column headers */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '58px 40px 38px 1fr 52px 52px 42px',
          alignItems: 'center',
          gap: 4,
          padding: `3px ${tokens.spacing[2]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          // eslint-disable-next-line no-restricted-syntax -- off-scale by design (dense trade table, fixed grid columns)
          fontSize: 10,
          color: tokens.colors.text.tertiary,
          fontWeight: tokens.typography.fontWeight.semibold,
          letterSpacing: '0.3px',
        }}
      >
        <span>{t('tradeExchange')}</span>
        <span>{t('tradePair')}</span>
        <span>{t('tradeSide')}</span>
        <span style={{ textAlign: 'right' }}>{t('tradePrice')}</span>
        <span style={{ textAlign: 'right' }}>{t('tradeQty')}</span>
        <span style={{ textAlign: 'right' }}>{t('tradeValue')}</span>
        <span style={{ textAlign: 'right' }}>{t('tradeTime')}</span>
      </div>

      {/* Trade list */}
      <div
        ref={containerRef}
        tabIndex={0}
        aria-label={t('liveTradesFeed')}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          flex: 1,
          // 上限高度:父级 grid 行无高度约束时,flex:1 无法封顶,150 笔实时交易
          // 会把整行撑到 ~4000px(恐惧贪婪/套利卡随之悬空留白)。加 maxHeight 让
          // 列表自身滚动,恢复 MarketPageClient 的紧凑布局意图。
          maxHeight: 480,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {error && !connected && filteredTrades.length === 0 ? (
          <div
            role="alert"
            style={{
              padding: 40,
              textAlign: 'center',
              color: tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            <p style={{ marginBottom: 4 }}>{t('disconnected')}</p>
            <p style={{ fontSize: tokens.typography.fontSize.xs, opacity: 0.7 }}>
              {t('connectionLostMessage')}
            </p>
            <button
              type="button"
              onClick={retry}
              style={{
                minHeight: 36,
                marginTop: tokens.spacing[3],
                padding: `0 ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: tokens.glass.border.light,
                background: tokens.colors.bg.tertiary,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.semibold,
              }}
            >
              {t('retryConnection')}
            </button>
          </div>
        ) : !connected && trades.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: tokens.colors.text.tertiary,
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                margin: '0 auto 8px',
                border: `2px solid ${tokens.colors.border.primary}`,
                borderTopColor: tokens.colors.accent.primary,
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }}
            />
            <p style={{ fontSize: tokens.typography.fontSize.sm }}>{t('waitingForData')}</p>
          </div>
        ) : filteredTrades.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: tokens.colors.text.tertiary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          >
            {t('waitingForData')}
          </div>
        ) : (
          filteredTrades.map((trade, i) => <TradeRow key={trade.id} trade={trade} index={i} />)
        )}
      </div>

      {/* Pause indicator */}
      {paused && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            // eslint-disable-next-line no-restricted-syntax -- off-scale by design (compact pause indicator)
            fontSize: 10,
            color: tokens.colors.accent.warning,
            fontWeight: tokens.typography.fontWeight.semibold,
            padding: `2px ${tokens.spacing[1]}`,
            borderRadius: tokens.radius.sm,
            background: 'var(--color-orange-subtle)',
          }}
        >
          {t('tradePaused')}
        </div>
      )}
    </div>
  )
}
