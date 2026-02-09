/**
 * LiveTradesFeed - 实时交易流组件
 */

'use client'

import { useRef, useState, useEffect, useCallback, memo } from 'react'
import { useMarketFeed } from '@/lib/hooks/useMarketFeed'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { NormalizedTrade, ExchangeId } from '@/lib/ws/exchange-feeds'

const _EXCHANGE_COLORS: Record<ExchangeId, string> = {
  binance: '#F0B90B',
  bybit: '#F7A600',
  okx: tokens.colors.text.primary,
}

const _EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (price >= 1) return price.toFixed(4)
  return price.toFixed(6)
}

function _formatAmount(amount: number): string {
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}K`
  if (amount >= 1) return amount.toFixed(4)
  return amount.toFixed(6)
}

function getVolumeWeight(notional: number): number {
  if (notional <= 100) return 0
  const log = Math.log10(notional / 100) / Math.log10(10000)
  return Math.min(Math.max(log, 0), 1)
}

function _timeAgo(ts: number): string {
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

  const rowBg = isBuy
    ? isEven ? 'rgba(47, 229, 125, 0.04)' : 'rgba(47, 229, 125, 0.02)'
    : isEven ? 'rgba(255, 124, 124, 0.04)' : 'rgba(255, 124, 124, 0.02)'

  const sym = trade.pair.replace('/USDT', '').replace('USDT', '')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `3px ${tokens.spacing[3]}`,
        background: rowBg,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 11,
        fontFamily: 'monospace',
        transition: `background ${tokens.transition.fast}`,
        minHeight: 28,
      }}
    >
      <span style={{
        width: 16,
        color: sideColor,
        fontWeight: 800,
        flexShrink: 0,
        fontSize: 10,
        textAlign: 'center',
      }}>
        {isBuy ? 'B' : 'S'}
      </span>
      <span style={{ width: 36, color: tokens.colors.text.secondary, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
        {sym}
      </span>
      <span style={{ flex: 1, color: sideColor, textAlign: 'right', flexShrink: 0, fontWeight: 600 }}>
        ${formatPrice(trade.price)}
      </span>
      <span style={{ width: 48, color: tokens.colors.text.tertiary, textAlign: 'right', flexShrink: 0, fontSize: 10 }}>
        ${trade.notional >= 1000 ? `${(trade.notional / 1000).toFixed(1)}K` : trade.notional.toFixed(0)}
      </span>
      <span style={{ width: 8, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <div style={{
          width: 4,
          height: Math.max(4, weight * 16),
          background: sideColor,
          opacity: 0.6,
          borderRadius: 2,
        }} />
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
      boxShadow: connected ? '0 0 6px var(--color-accent-success-20)' : '0 0 6px var(--color-accent-error-20)',
    }} />
  )
}

export default function LiveTradesFeed() {
  const { trades, connectionStatus: _connectionStatus, connected } = useMarketFeed({ maxTrades: 150 })
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
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <span style={{
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 700,
          letterSpacing: '0.3px',
        }}>
          {t('liveTradesFeed') || '实时交易流'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ConnectionDot connected={connected} />
          {paused && (
            <span style={{
              fontSize: 10,
              color: tokens.colors.accent.warning,
              fontWeight: 600,
            }}>
              {t('paused') || '暂停'}
            </span>
          )}
          {!connected && (
            <span style={{ fontSize: 10, color: tokens.colors.accent.error }}>
              {t('connecting') || '连接中...'}
            </span>
          )}
        </div>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `4px ${tokens.spacing[3]}`,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 10,
        color: tokens.colors.text.tertiary,
        fontFamily: 'monospace',
        fontWeight: 600,
        letterSpacing: '0.3px',
      }}>
        <span style={{ width: 16 }}></span>
        <span style={{ width: 36 }}>币种</span>
        <span style={{ flex: 1, textAlign: 'right' }}>价格</span>
        <span style={{ width: 48, textAlign: 'right' }}>价值</span>
        <span style={{ width: 8 }}></span>
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
