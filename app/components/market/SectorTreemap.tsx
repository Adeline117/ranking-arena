'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

interface CoinData {
  symbol: string
  name: string
  marketCap: number
  change24h: number | null
}

type TimeFrame = '1h' | '24h' | '7d'

// Category mapping for known coins
const CATEGORY_MAP: Record<string, string> = {
  BTC: 'L1', ETH: 'L1', SOL: 'L1', BNB: 'L1', ADA: 'L1', AVAX: 'L1', DOT: 'L1', NEAR: 'L1', ATOM: 'L1', SUI: 'L1', APT: 'L1', TRX: 'L1', TON: 'L1', XRP: 'L1',
  LINK: 'DeFi', UNI: 'DeFi', AAVE: 'DeFi', MKR: 'DeFi', CRV: 'DeFi', SNX: 'DeFi', COMP: 'DeFi', SUSHI: 'DeFi', DYDX: 'DeFi', LDO: 'DeFi',
  ARB: 'L2', OP: 'L2', MATIC: 'L2', STRK: 'L2', IMX: 'L2', MANTA: 'L2',
  DOGE: 'Meme', SHIB: 'Meme', PEPE: 'Meme', WIF: 'Meme', FLOKI: 'Meme', BONK: 'Meme',
  RNDR: 'AI', FET: 'AI', TAO: 'AI', AGIX: 'AI', WLD: 'AI',
  AXS: 'GameFi', GALA: 'GameFi', SAND: 'GameFi', MANA: 'GameFi',
  BLUR: 'NFT', APE: 'NFT',
  USDT: 'Stable', USDC: 'Stable', DAI: 'Stable',
  XLM: 'L1', ALGO: 'L1', ICP: 'L1', FIL: 'Infra', AR: 'Infra', THETA: 'Infra',
}

function getChangeColor(changePct: number): string {
  const maxPct = 10
  const clamped = Math.max(-maxPct, Math.min(maxPct, changePct))
  const intensity = Math.abs(clamped) / maxPct

  if (clamped >= 0) {
    const r = Math.round(74 - intensity * 53)
    const g = Math.round(222 - intensity * 94)
    const b = Math.round(128 - intensity * 67)
    return `rgb(${r}, ${g}, ${b})`
  } else {
    const r = Math.round(248 - intensity * 63)
    const g = Math.round(113 - intensity * 85)
    const b = Math.round(113 - intensity * 85)
    return `rgb(${r}, ${g}, ${b})`
  }
}

interface TreemapNode {
  name: string
  category: string
  marketCap: number
  changePct: number
  x: number
  y: number
  width: number
  height: number
}

// Squarified treemap layout
function squarify(
  data: { name: string; category: string; marketCap: number; changePct: number }[],
  x: number, y: number, w: number, h: number,
): TreemapNode[] {
  if (data.length === 0 || w <= 0 || h <= 0) return []

  const total = data.reduce((s, d) => s + d.marketCap, 0)
  if (total === 0) return []

  const sorted = [...data].sort((a, b) => b.marketCap - a.marketCap)
  const nodes: TreemapNode[] = []

  function layoutRow(items: typeof sorted, rowArea: number, isHorizontal: boolean, rx: number, ry: number, rw: number, rh: number) {
    const side = isHorizontal ? rh : rw
    const rowWidth = rowArea / side

    let offset = 0
    for (const item of items) {
      const itemArea = (item.marketCap / total) * w * h
      const itemLen = itemArea / rowWidth

      if (isHorizontal) {
        nodes.push({ ...item, x: rx, y: ry + offset, width: rowWidth, height: itemLen })
      } else {
        nodes.push({ ...item, x: rx + offset, y: ry, width: itemLen, height: rowWidth })
      }
      offset += itemLen
    }
    return rowWidth
  }

  // Simple slice-and-dice for better visual
  let cx = x, cy = y, cw = w, ch = h
  let remaining = total

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]
    const ratio = item.marketCap / remaining

    if (cw > ch) {
      const itemW = cw * ratio
      nodes.push({ ...item, x: cx, y: cy, width: itemW, height: ch })
      cx += itemW
      cw -= itemW
    } else {
      const itemH = ch * ratio
      nodes.push({ ...item, x: cx, y: cy, width: cw, height: itemH })
      cy += itemH
      ch -= itemH
    }
    remaining -= item.marketCap
  }

  return nodes
}

export default function SectorTreemap({ onSectorClick }: { onSectorClick?: (category: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [timeframe, setTimeframe] = useState<TimeFrame>('24h')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [coins, setCoins] = useState<{ name: string; category: string; marketCap: number; changePct: number }[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch real data from /api/market/spot
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/market/spot')
      const data: CoinData[] = await res.json()
      if (!Array.isArray(data)) return

      const mapped = data
        .filter((c) => c.marketCap > 0 && c.change24h !== null && !['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD'].includes(c.symbol))
        .slice(0, 30)
        .map((c) => ({
          name: c.symbol,
          category: CATEGORY_MAP[c.symbol] || 'Other',
          marketCap: c.marketCap,
          changePct: c.change24h ?? 0,
        }))

      setCoins(mapped)
    } catch {
      // fallback silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60000)
    return () => clearInterval(interval)
  }, [fetchData])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        setSize({ width: entry.contentRect.width, height: Math.max(240, Math.min(360, entry.contentRect.width * 0.3)) })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const nodes = squarify(coins, 0, 0, size.width, size.height)

  const timeframes: { key: TimeFrame; label: string }[] = [
    { key: '1h', label: '1小时' },
    { key: '24h', label: '24小时' },
    { key: '7d', label: '7天' },
  ]

  return (
    <div>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
      }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.text.primary }}>
          板块热力图
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {timeframes.map(tf => (
            <button
              key={tf.key}
              onClick={() => setTimeframe(tf.key)}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 500,
                borderRadius: tokens.radius.sm,
                border: 'none',
                cursor: 'pointer',
                background: timeframe === tf.key ? tokens.colors.accent.primary : tokens.colors.bg.tertiary,
                color: timeframe === tf.key ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                transition: 'all 0.15s ease',
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {/* Treemap */}
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: '100%',
          height: size.height || 300,
          borderRadius: tokens.radius.lg,
          overflow: 'hidden',
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        {loading ? (
          <div style={{
            width: '100%', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: tokens.colors.text.tertiary, fontSize: 14,
          }}>
            加载中...
          </div>
        ) : nodes.map(node => {
          const isHovered = hoveredNode === node.name
          const showName = node.width > 36 && node.height > 28
          const showPct = node.width > 44 && node.height > 40
          const showCat = node.width > 60 && node.height > 55
          const fontSize = Math.max(10, Math.min(18, Math.min(node.width / 5, node.height / 3)))

          return (
            <div
              key={node.name}
              onClick={() => onSectorClick?.(node.category)}
              onMouseEnter={() => setHoveredNode(node.name)}
              onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHoveredNode(null)}
              style={{
                position: 'absolute',
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                background: getChangeColor(node.changePct),
                border: '1px solid rgba(0,0,0,0.15)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                transition: 'filter 0.15s ease',
                filter: isHovered ? 'brightness(1.25)' : 'brightness(1)',
                zIndex: isHovered ? 10 : 1,
                boxShadow: isHovered ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
                padding: 2,
              }}
            >
              {showName && (
                <span style={{
                  fontSize,
                  fontWeight: 800,
                  color: '#fff',
                  textShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  lineHeight: 1.2,
                }}>
                  {node.name}
                </span>
              )}
              {showPct && (
                <span style={{
                  fontSize: Math.max(9, fontSize * 0.7),
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.85)',
                  textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                }}>
                  {node.changePct >= 0 ? '+' : ''}{node.changePct.toFixed(1)}%
                </span>
              )}
              {showCat && (
                <span style={{
                  fontSize: 9,
                  color: 'rgba(255,255,255,0.55)',
                  marginTop: 2,
                }}>
                  {node.category}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Tooltip */}
      {hoveredNode && (() => {
        const node = nodes.find(n => n.name === hoveredNode)
        if (!node) return null
        return (
          <div style={{
            position: 'fixed',
            left: tooltipPos.x + 12,
            top: tooltipPos.y - 40,
            background: 'rgba(0,0,0,0.88)',
            color: '#fff',
            padding: '6px 10px',
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            pointerEvents: 'none',
            zIndex: 1000,
            whiteSpace: 'nowrap',
          }}>
            <strong>{node.name}</strong> / {node.category}<br />
            市值: ${(node.marketCap / 1e9).toFixed(1)}B &middot; {node.changePct >= 0 ? '+' : ''}{node.changePct.toFixed(2)}%
          </div>
        )
      })()}

      {/* Legend */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 16,
        marginTop: 8,
        fontSize: 11,
        color: tokens.colors.text.tertiary,
      }}>
        {[
          { label: '大跌', val: -8 },
          { label: '小跌', val: -2 },
          { label: '小涨', val: 2 },
          { label: '大涨', val: 8 },
        ].map(item => (
          <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: getChangeColor(item.val) }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}
