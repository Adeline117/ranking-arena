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

const TradeRow = memo(function TradeRow({ trade }: { trade: NormalizedTrade }) {
  const isBuy = trade.side === 'buy'
  const textColor = isBuy ? tokens.colors.accent.success : tokens.colors.accent.error
  const weight = getVolumeWeight(trade.notional)
  const bgOpacity = Math.max(weight * 0.08, 0)
  const bgColor = isBuy
    ? `rgba(22, 199, 132, ${bgOpacity})`
    : `rgba(234, 57, 67, ${bgOpacity})`
  const baseFontSize = 12
  const fontSize = baseFontSize + weight * 2

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 12px',
        background: bgColor,
        borderBottom: `1px solid ${tokens.colors.border.primary}10`,
        fontSize,
        fontFamily: 'monospace',
        transition: 'background 0.15s',
      }}
    >
      <span style={{ width: 56, fontSize: 10, color: EXCHANGE_COLORS[trade.exchange], opacity: 0.8, flexShrink: 0 }}>
        {EXCHANGE_LABELS[trade.exchange]}
      </span>
      <span style={{ width: 80, color: tokens.colors.text.secondary, flexShrink: 0, fontSize: 11 }}>
        {trade.pair}
      </span>
      <span style={{ width: 32, color: textColor, fontWeight: 600, flexShrink: 0 }}>
        {isBuy ? t('tradeBuy') : t('tradeSell')}
      </span>
      <span style={{ width: 100, color: textColor, textAlign: 'right', flexShrink: 0 }}>
        ${formatPrice(trade.price)}
      </span>
      <span style={{ width: 80, color: tokens.colors.text.tertiary, textAlign: 'right', flexShrink: 0 }}>
        {formatAmount(trade.amount)}
      </span>
      <span style={{ flex: 1, color: tokens.colors.text.tertiary, textAlign: 'right', fontSize: 10 }}>
        ${trade.notional >= 1000 ? `${(trade.notional / 1000).toFixed(1)}K` : trade.notional.toFixed(0)}
      </span>
      <span style={{ width: 32, color: tokens.colors.text.tertiary, textAlign: 'right', fontSize: 10 }}>
        {timeAgo(trade.exchangeTimestamp)}
      </span>
      <div style={{ width: 40, height: 4, background: `${tokens.colors.border.primary}30`, borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${weight * 100}%`, height: '100%', background: textColor, opacity: 0.6, borderRadius: 2 }} />
      </div>
    </div>
  )
})

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
      background: connected ? tokens.colors.accent.success : tokens.colors.accent.error,
      marginRight: 4,
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
      background: tokens.glass.bg.secondary,
      border: tokens.glass.border.light,
      borderRadius: tokens.radius.lg,
      overflow: 'hidden',
      width: '100%',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.glass.bg.light,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: tokens.colors.text.primary, fontSize: 13, fontWeight: 600 }}>
            {t('liveTradesFeed') || '实时交易流'}
          </span>
          <span style={{ color: tokens.colors.text.tertiary, fontSize: 11 }}>
            {trades.length} {t('trades') || '笔'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(Object.entries(connectionStatus) as [ExchangeId, boolean][]).map(([exchange, status]) => (
            <span key={exchange} style={{ display: 'flex', alignItems: 'center', fontSize: 10, color: tokens.colors.text.tertiary }}>
              <ConnectionDot connected={status} />
              {EXCHANGE_LABELS[exchange]}
            </span>
          ))}
          {paused && <span style={{ fontSize: 10, color: tokens.colors.accent.warning }}>{t('paused') || '已暂停'}</span>}
          {!connected && <span style={{ fontSize: 10, color: tokens.colors.accent.error }}>{t('connecting') || '正在连接...'}</span>}
        </div>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px',
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        fontSize: 10, color: tokens.colors.text.tertiary, fontFamily: 'monospace',
      }}>
        <span style={{ width: 56 }}>交易所</span>
        <span style={{ width: 80 }}>交易对</span>
        <span style={{ width: 32 }}>方向</span>
        <span style={{ width: 100, textAlign: 'right' }}>价格</span>
        <span style={{ width: 80, textAlign: 'right' }}>数量</span>
        <span style={{ flex: 1, textAlign: 'right' }}>价值</span>
        <span style={{ width: 32, textAlign: 'right' }}>时间</span>
        <span style={{ width: 40 }}>量</span>
      </div>

      {/* Trade list */}
      <div
        ref={containerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{ maxHeight: 400, overflowY: 'auto', overflowX: 'hidden' }}
      >
        {trades.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
            {t('waitingForData') || '等待交易数据...'}
          </div>
        ) : (
          trades.map((trade) => <TradeRow key={trade.id} trade={trade} />)
        )}
      </div>
    </div>
  )
}
