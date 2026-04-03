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
  bybit: 'var(--color-chart-orange)',
  okx: 'var(--color-chart-blue)',
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

const TradeRow = memo(function TradeRow({ trade, index }: { trade: NormalizedTrade; index: number }) {
  const { t } = useLanguage()
  const isBuy = trade.side === 'buy'
  const sideColor = isBuy ? tokens.colors.accent.success : tokens.colors.accent.error
  const isEven = index % 2 === 0
  const sym = trade.pair.replace('/USDT', '').replace('-USDT', '').replace('/USDC', '').replace('-USDC', '').replace('USDT', '').replace('USDC', '')
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
        fontSize: 10,
        fontFamily: 'var(--font-mono, monospace)',
        minHeight: 26,
      }}
    >
      {/* 交易所 badge */}
      <span style={{
        display: 'inline-block',
        padding: '1px 5px',
        borderRadius: tokens.radius.sm,
        background: exchBg,
        color: exchColor,
        fontWeight: 700,
        fontSize: 10,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {EXCHANGE_LABELS[trade.exchange] || trade.exchange}
      </span>

      {/* 交易对 */}
      <span style={{ color: tokens.colors.text.primary, fontWeight: 600, fontSize: 10 }}>
        {sym}
      </span>

      {/* 方向 */}
      <span style={{
        color: sideColor,
        fontWeight: 700,
        fontSize: 10,
      }}>
        {isBuy ? 'BUY' : 'SELL'}
      </span>

      {/* 价格 */}
      <span style={{ color: sideColor, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } as React.CSSProperties}>
        ${formatPrice(trade.price)}
      </span>

      {/* 数量 */}
      <span style={{ color: tokens.colors.text.secondary, textAlign: 'right', fontSize: 9 }}>
        {formatAmount(trade.amount)}
      </span>

      {/* 价值 */}
      <span style={{ color: tokens.colors.text.tertiary, textAlign: 'right', fontSize: 9 }}>
        {formatValue(trade.notional)}
      </span>

      {/* 时间 */}
      <span style={{ color: tokens.colors.text.tertiary, textAlign: 'right', fontSize: 9 }}>
        {timeAgo(trade.timestamp, t as (key: string) => string)}
      </span>
    </div>
  )
})

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: connected ? tokens.colors.accent.success : tokens.colors.accent.error,
      marginRight: 4,
    }} />
  )
}

export default function LiveTradesFeed() {
  const { t } = useLanguage()
  const { trades, connected, error } = useMarketFeed({ maxTrades: 150 })
  const containerRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [exchangeFilter, setExchangeFilter] = useState<Set<ExchangeId>>(new Set(ALL_EXCHANGES))

  useEffect(() => {
    if (!paused && containerRef.current) containerRef.current.scrollTop = 0
  }, [trades.length, paused])

  const handleMouseEnter = useCallback(() => setPaused(true), [])
  const handleMouseLeave = useCallback(() => setPaused(false), [])

  const toggleExchange = useCallback((ex: ExchangeId) => {
    setExchangeFilter(prev => {
      const next = new Set(prev)
      if (next.has(ex)) {
        if (next.size > 1) next.delete(ex)
      } else {
        next.add(ex)
      }
      return next
    })
  }, [])

  const filteredTrades = trades.filter(tr => exchangeFilter.has(tr.exchange))

  return (
    <div style={{
      background: tokens.glass.bg.medium,
      border: tokens.glass.border.light,
      borderRadius: tokens.radius.xl,
      overflow: 'hidden',
      width: '100%',
      maxHeight: 480,
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
    }}>
      {/* Top accent line */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: tokens.gradient.purple,
        opacity: 0.6,
      }} />

      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ConnectionDot connected={connected} />
          <span style={{
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: 700,
          }}>
            {t('liveTradesFeed') || '实时交易流'}
          </span>
          {filteredTrades.length > 0 && (
            <span style={{
              fontSize: 10,
              color: tokens.colors.text.tertiary,
              fontWeight: 500,
              padding: '1px 6px',
              borderRadius: tokens.radius.sm,
              background: tokens.colors.bg.tertiary,
            }}>
              {filteredTrades.length}{t('tradeCountSuffix')}
            </span>
          )}
        </div>

        {/* Exchange filters */}
        <div style={{ display: 'flex', gap: 3 }}>
          {ALL_EXCHANGES.map(ex => {
            const active = exchangeFilter.has(ex)
            return (
              <button
                key={ex}
                onClick={() => toggleExchange(ex)}
                style={{
                  padding: '1px 6px',
                  fontSize: 10,
                  fontWeight: 600,
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
      <div style={{
        display: 'grid',
        gridTemplateColumns: '58px 40px 38px 1fr 52px 52px 42px',
        alignItems: 'center',
        gap: 4,
        padding: `3px ${tokens.spacing[2]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 10,
        color: tokens.colors.text.tertiary,
        fontWeight: 600,
        letterSpacing: '0.3px',
      }}>
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
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {error && !connected && filteredTrades.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}>
            <p style={{ marginBottom: 4 }}>{t('disconnected')}</p>
            <p style={{ fontSize: tokens.typography.fontSize.xs, opacity: 0.7 }}>{t('connectionLostMessage')}</p>
          </div>
        ) : !connected && trades.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
          }}>
            <div style={{
              width: 20, height: 20, margin: '0 auto 8px',
              border: `2px solid ${tokens.colors.border.primary}`,
              borderTopColor: tokens.colors.accent.primary,
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }} />
            <p style={{ fontSize: tokens.typography.fontSize.sm }}>
              {t('waitingForData') || '等待交易数据...'}
            </p>
          </div>
        ) : filteredTrades.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}>
            {t('waitingForData') || '等待交易数据...'}
          </div>
        ) : (
          filteredTrades.map((trade, i) => <TradeRow key={trade.id} trade={trade} index={i} />)
        )}
      </div>

      {/* Pause indicator */}
      {paused && (
        <div style={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          fontSize: 10,
          color: tokens.colors.accent.warning,
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: tokens.radius.sm,
          background: 'var(--color-orange-subtle)',
        }}>
          {t('tradePaused')}
        </div>
      )}
    </div>
  )
}
