'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { tokens } from '@/lib/design-tokens'

interface TokenInfo {
  id: string
  symbol: string
  name: string
  image: string
  price: number
  change24h: number
  marketCap: number
  volume24h: number
  high24h: number
  low24h: number
  rank: number
}

function formatNum(n: number | null): string {
  if (n == null) return '--'
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`
  return `$${n.toFixed(2)}`
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `$${n.toPrecision(4)}`
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: `1px solid ${tokens.colors.border.primary}`,
      fontSize: 13,
    }}>
      <span style={{ color: tokens.colors.text.tertiary }}>{label}</span>
      <span style={{ color: tokens.colors.text.primary, fontWeight: 500 }}>{value}</span>
    </div>
  )
}

export default function TokenSidePanel({ token, onClose }: {
  token: TokenInfo | null
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <AnimatePresence>
      {token && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.4)',
              zIndex: 200,
            }}
          />
          {/* Panel */}
          <motion.div
            ref={panelRef}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              width: '100%',
              maxWidth: 600,
              height: '100vh',
              background: tokens.colors.bg.primary,
              borderLeft: `1px solid ${tokens.colors.border.primary}`,
              zIndex: 201,
              overflowY: 'auto',
              padding: 24,
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img
                  src={token.image || `/crypto-icons/${token.symbol.toLowerCase()}.svg`}
                  alt=""
                  width={32}
                  height={32}
                  style={{ borderRadius: '50%' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.text.primary }}>
                    {token.symbol}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>{token.name}</div>
                </div>
              </div>
              <button
                onClick={onClose}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  color: tokens.colors.text.tertiary,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Price */}
            <div style={{ marginBottom: 24 }}>
              <div style={{
                fontSize: 28,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                fontFamily: 'var(--font-mono, monospace)',
              }}>
                {formatPrice(token.price)}
              </div>
              <span style={{
                fontSize: 14,
                fontWeight: 600,
                color: token.change24h >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}>
                {token.change24h >= 0 ? '+' : ''}{token.change24h.toFixed(2)}%
              </span>
            </div>

            {/* TradingView Chart Placeholder */}
            <div style={{
              width: '100%',
              height: 300,
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 24,
              color: tokens.colors.text.tertiary,
              fontSize: 13,
            }}>
              <div style={{ textAlign: 'center' }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 8, opacity: 0.5 }}>
                  <polyline points="22,6 13.5,14.5 8.5,9.5 2,16" />
                  <polyline points="16,6 22,6 22,12" />
                </svg>
                <div>TradingView K线图</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>即将接入</div>
              </div>
            </div>

            {/* Fundamentals */}
            <div style={{ marginBottom: 24 }}>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: tokens.colors.text.primary,
                marginBottom: 8,
              }}>
                基本面数据
              </div>
              <StatRow label="排名" value={`#${token.rank}`} />
              <StatRow label="市值" value={formatNum(token.marketCap)} />
              <StatRow label="24h 成交量" value={formatNum(token.volume24h)} />
              <StatRow label="24h 最高" value={formatPrice(token.high24h)} />
              <StatRow label="24h 最低" value={formatPrice(token.low24h)} />
            </div>

            {/* Related Traders */}
            <div>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: tokens.colors.text.primary,
                marginBottom: 8,
              }}>
                相关交易员
              </div>
              <div style={{
                padding: 16,
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.md,
                textAlign: 'center',
                color: tokens.colors.text.tertiary,
                fontSize: 13,
              }}>
                暂无数据 -- 即将推出
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
