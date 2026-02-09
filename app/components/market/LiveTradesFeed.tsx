/**
 * LiveTradesFeed - 实时交易流组件
 */

'use client'

import { useRef, useState, useEffect, useCallback, memo } from 'react'
import { useMarketFeed } from '@/lib/hooks/useMarketFeed'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { NormalizedTrade, ExchangeId } from '@/lib/ws/exchange-feeds'

const EXCHANGE_COLORS: Record<ExchangeId, string> = {
  binance: '#F0B90B',
  bybit: '#F7A600',
  okx: tokens.colors.text.primary,
}

const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

function formatAmount(amount: number): string {
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}K`
  if (amount >= 1) return amount.toFixed(4)
  return amount.toFixed(6)
}

function getVolumeWeight(notional: number): number {
  if (notional <= 100) return 0
  const log = Math.log10(notional / 100) / Math.log10(10000)
  return Math.min(Math.max(log, 0), 1)
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 1) return 'now'
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m`
}

const TradeRow = memo(function TradeRow({ trade, index }: { trade: NormalizedTrade; index: number }) {
  const isBuy = trade.side === 'buy'
  const sideColor = isBuy ? tokens.colors.accent.success : tokens.colors.accent.error
  const weight = getVolumeWeight(trade.notional)
  const isEven = index % 2 === 0

  // Subtle row bg with alternating + directional tint
  const rowBg = isBuy
    ? isEven ? 'rgba(47, 229, 125, 0.04)' : 'rgba(47, 229, 125, 0.02)'
    : isEven ? 'rgba(255, 124, 124, 0.04)' : 'rgba(255, 124, 124, 0.02)'

  const baseFontSize = 12
  const fontSize = baseFontSize + weight * 2

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `4px ${tokens.spacing[4]}`,
        background: rowBg,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize,
        fontFamily: 'monospace',
        transition: `background ${tokens.transition.fast}`,
        minHeight: 32,
      }}
    >
      <span style={{ width: 52, fontSize: 10, color: EXCHANGE_COLORS[trade.exchange], fontWeight: 600, flexShrink: 0 }}>
        {EXCHANGE_LABELS[trade.exchange]}
      </span>
      <span style={{ width: 76, color: tokens.colors.text.secondary, flexShrink: 0, fontSize: 11 }}>
        {trade.pair}
      </span>
      <span style={{
        width: 36,
        color: sideColor,
        fontWeight: 800,
        flexShrink: 0,
        fontSize: 11,
        padding: '1px 4px',
        borderRadius: tokens.radius.sm,
        background: isBuy ? 'rgba(47, 229, 125, 0.12)' : 'rgba(255, 124, 124, 0.12)',
        textAlign: 'center',
      }}>
        {isBuy ? t('tradeBuy') : t('tradeSell')}
      </span>
      <span style={{ width: 96, color: sideColor, textAlign: 'right', flexShrink: 0, fontWeight: 600 }}>
        ${formatPrice(trade.price)}
      </span>
      <span style={{ width: 76, color: tokens.colors.text.tertiary, textAlign: 'right', flexShrink: 0 }}>
        {formatAmount(trade.amount)}
      </span>
      <span style={{ flex: 1, color: tokens.colors.text.tertiary, textAlign: 'right', fontSize: 10 }}>
        ${trade.notional >= 1000 ? `${(trade.notional / 1000).toFixed(1)}K` : trade.notional.toFixed(0)}
      </span>
      <span style={{ width: 28, color: tokens.colors.text.tertiary, textAlign: 'right', fontSize: 10 }}>
        {timeAgo(trade.exchangeTimestamp)}
      </span>
      <div style={{
        width: 36,
        height: 4,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.full,
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        <div style={{
          width: `${weight * 100}%`,
          height: '100%',
          background: sideColor,
          opacity: 0.7,
          borderRadius: tokens.radius.full,
          transition: `width ${tokens.transition.fast}`,
        }} />
      </div>
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
      boxShadow: connected ? '0 0 6px var(--color-accent-success-20)' : '0 0 6px var(--color-accent-error-20)',
    }} />
  )
}

export default function LiveTradesFeed() {
  const { trades, connectionStatus, connected } = useMarketFeed({ maxTrades: 150 })
  const containerRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (!paused && containerRef.current) containerRef.current.scrollTop = 0
  }, [trades.length, paused])

  const handleMouseEnter = useCallback(() => setPaused(true), [])
  const handleMouseLeave = useCallback(() => setPaused(false), [])

  return (
    <div style={{
      background: tokens.glass.bg.medium,
      border: tokens.glass.border.light,
      borderRadius: tokens.radius.xl,
      overflow: 'hidden',
      width: '100%',
      height: '100%',
      minHeight: 220,
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
        padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.base,
            fontWeight: 700,
            letterSpacing: '0.3px',
          }}>
            {t('liveTradesFeed') || '实时交易流'}
          </span>
          <span style={{
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            padding: `2px ${tokens.spacing[2]}`,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.sm,
          }}>
            {trades.length} {t('trades') || '笔'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {(Object.entries(connectionStatus) as [ExchangeId, boolean][]).map(([exchange, status]) => (
            <span key={exchange} style={{ display: 'flex', alignItems: 'center', fontSize: 10, color: tokens.colors.text.tertiary }}>
              <ConnectionDot connected={status} />
              {EXCHANGE_LABELS[exchange]}
            </span>
          ))}
          {paused && (
            <span style={{
              fontSize: 10,
              color: tokens.colors.accent.warning,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: tokens.radius.sm,
              background: 'rgba(255, 184, 0, 0.1)',
            }}>
              {t('paused') || '已暂停'}
            </span>
          )}
          {!connected && (
            <span style={{ fontSize: 10, color: tokens.colors.accent.error }}>
              {t('connecting') || '正在连接...'}
            </span>
          )}
        </div>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `6px ${tokens.spacing[4]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 10,
        color: tokens.colors.text.tertiary,
        fontFamily: 'monospace',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        <span style={{ width: 52 }}>交易所</span>
        <span style={{ width: 76 }}>交易对</span>
        <span style={{ width: 36, textAlign: 'center' }}>方向</span>
        <span style={{ width: 96, textAlign: 'right' }}>价格</span>
        <span style={{ width: 76, textAlign: 'right' }}>数量</span>
        <span style={{ flex: 1, textAlign: 'right' }}>价值</span>
        <span style={{ width: 28, textAlign: 'right' }}>时间</span>
        <span style={{ width: 36 }}>量</span>
      </div>

      {/* Trade list */}
      <div
        ref={containerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          flex: 1,
          maxHeight: 400,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {trades.length === 0 ? (
          <div style={{
            padding: 40,
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}>
            {t('waitingForData') || '等待交易数据...'}
          </div>
        ) : (
          trades.map((trade, i) => <TradeRow key={trade.id} trade={trade} index={i} />)
        )}
      </div>
    </div>
  )
}
