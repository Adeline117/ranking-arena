/**
 * LiveTradesFeed - 实时交易流组件
 *
 * 展示来自多交易所的实时交易数据:
 * - 买卖方向颜色区分 (绿/红)
 * - 成交量加权大小指示
 * - 悬停暂停自动滚动
 * - 交易所来源标识
 */

'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { useMarketFeed } from '@/lib/hooks/useMarketFeed'
import type { NormalizedTrade, ExchangeId } from '@/lib/ws/exchange-feeds'

// ============================================
// 常量与工具
// ============================================

const EXCHANGE_COLORS: Record<ExchangeId, string> = {
  binance: '#F0B90B',
  bybit: '#F7A600',
  okx: '#FFFFFF',
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

/** 根据名义价值计算视觉权重 (0-1) */
function getVolumeWeight(notional: number): number {
  // $100 以下 = 0, $1M 以上 = 1, 对数缩放
  if (notional <= 100) return 0
  const log = Math.log10(notional / 100) / Math.log10(10000) // log scale 100 -> 1M
  return Math.min(Math.max(log, 0), 1)
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 1000) return '<1s'
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`
  return `${Math.floor(diff / 60000)}m`
}

// ============================================
// TradeRow 子组件
// ============================================

function TradeRow({ trade }: { trade: NormalizedTrade }) {
  const weight = getVolumeWeight(trade.notional)
  const isBuy = trade.side === 'buy'
  const bgOpacity = 0.02 + weight * 0.08
  const bgColor = isBuy ? `rgba(22, 199, 132, ${bgOpacity})` : `rgba(234, 57, 67, ${bgOpacity})`
  const textColor = isBuy ? '#16C784' : '#EA3943'
  const fontSize = 12 + weight * 4

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 12px',
        background: bgColor,
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        fontSize,
        fontFamily: 'monospace',
        transition: 'background 0.15s',
      }}
    >
      {/* 交易所标识 */}
      <span
        style={{
          width: 56,
          fontSize: 10,
          color: EXCHANGE_COLORS[trade.exchange],
          opacity: 0.8,
          flexShrink: 0,
        }}
      >
        {EXCHANGE_LABELS[trade.exchange]}
      </span>

      {/* 交易对 */}
      <span style={{ width: 80, color: '#ccc', flexShrink: 0, fontSize: 11 }}>
        {trade.pair}
      </span>

      {/* 方向 */}
      <span style={{ width: 32, color: textColor, fontWeight: 600, flexShrink: 0 }}>
        {isBuy ? 'BUY' : 'SELL'}
      </span>

      {/* 价格 */}
      <span style={{ width: 100, color: textColor, textAlign: 'right', flexShrink: 0 }}>
        ${formatPrice(trade.price)}
      </span>

      {/* 数量 */}
      <span style={{ width: 80, color: '#999', textAlign: 'right', flexShrink: 0 }}>
        {formatAmount(trade.amount)}
      </span>

      {/* 名义价值 */}
      <span
        style={{
          flex: 1,
          color: '#666',
          textAlign: 'right',
          fontSize: 10,
        }}
      >
        ${trade.notional >= 1000 ? `${(trade.notional / 1000).toFixed(1)}K` : trade.notional.toFixed(0)}
      </span>

      {/* 时间 */}
      <span style={{ width: 32, color: '#555', textAlign: 'right', fontSize: 10 }}>
        {timeAgo(trade.exchangeTimestamp)}
      </span>

      {/* 成交量条 */}
      <div
        style={{
          width: 40,
          height: 4,
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 2,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: `${weight * 100}%`,
            height: '100%',
            background: textColor,
            opacity: 0.6,
            borderRadius: 2,
          }}
        />
      </div>
    </div>
  )
}

// ============================================
// 连接状态指示器
// ============================================

function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: connected ? '#16C784' : '#EA3943',
        marginRight: 4,
      }}
    />
  )
}

// ============================================
// LiveTradesFeed 主组件
// ============================================

export default function LiveTradesFeed() {
  const { trades, connectionStatus, connected } = useMarketFeed({
    maxTrades: 150,
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)

  // 自动滚动到顶部 (新交易在顶部)
  useEffect(() => {
    if (!paused && containerRef.current) {
      containerRef.current.scrollTop = 0
    }
  }, [trades.length, paused])

  const handleMouseEnter = useCallback(() => setPaused(true), [])
  const handleMouseLeave = useCallback(() => setPaused(false), [])

  return (
    <div
      style={{
        background: '#0D1117',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#E6E6E6', fontSize: 13, fontWeight: 600 }}>
            实时交易流
          </span>
          <span style={{ color: '#666', fontSize: 11 }}>
            {trades.length} 笔
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(Object.entries(connectionStatus) as [ExchangeId, boolean][]).map(
            ([exchange, status]) => (
              <span
                key={exchange}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 10,
                  color: '#999',
                }}
              >
                <ConnectionDot connected={status} />
                {EXCHANGE_LABELS[exchange]}
              </span>
            )
          )}

          {paused && (
            <span style={{ fontSize: 10, color: '#F0B90B' }}>
              已暂停
            </span>
          )}

          {!connected && (
            <span style={{ fontSize: 10, color: '#EA3943' }}>
              正在连接...
            </span>
          )}
        </div>
      </div>

      {/* 表头 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          fontSize: 10,
          color: '#555',
          fontFamily: 'monospace',
        }}
      >
        <span style={{ width: 56 }}>交易所</span>
        <span style={{ width: 80 }}>交易对</span>
        <span style={{ width: 32 }}>方向</span>
        <span style={{ width: 100, textAlign: 'right' }}>价格</span>
        <span style={{ width: 80, textAlign: 'right' }}>数量</span>
        <span style={{ flex: 1, textAlign: 'right' }}>价值</span>
        <span style={{ width: 32, textAlign: 'right' }}>时间</span>
        <span style={{ width: 40 }}>量</span>
      </div>

      {/* 交易列表 */}
      <div
        ref={containerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          maxHeight: 400,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {trades.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: 'center',
              color: '#555',
              fontSize: 13,
            }}
          >
            等待交易数据...
          </div>
        ) : (
          trades.map((trade) => <TradeRow key={trade.id} trade={trade} />)
        )}
      </div>
    </div>
  )
}
