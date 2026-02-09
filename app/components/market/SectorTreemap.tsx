'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

interface SectorData {
  name: string
  category: string
  marketCap: number
  changePct: number
  children?: SectorData[]
}

type TimeFrame = '1h' | '24h' | '7d'

// Mock data per timeframe - will be replaced with real API
const MOCK_SECTORS: Record<TimeFrame, SectorData[]> = {
  '1h': [
    { name: 'BTC', category: 'L1', marketCap: 1900000, changePct: 0.3 },
    { name: 'ETH', category: 'L1', marketCap: 420000, changePct: -0.5 },
    { name: 'SOL', category: 'L1', marketCap: 85000, changePct: 1.2 },
    { name: 'BNB', category: 'L1', marketCap: 95000, changePct: 0.1 },
    { name: 'ADA', category: 'L1', marketCap: 25000, changePct: -0.8 },
    { name: 'AVAX', category: 'L1', marketCap: 15000, changePct: 0.6 },
    { name: 'LINK', category: 'DeFi', marketCap: 12000, changePct: 0.9 },
    { name: 'UNI', category: 'DeFi', marketCap: 8000, changePct: -0.2 },
    { name: 'AAVE', category: 'DeFi', marketCap: 6000, changePct: 0.4 },
    { name: 'MKR', category: 'DeFi', marketCap: 3500, changePct: -0.3 },
    { name: 'ARB', category: 'L2', marketCap: 4500, changePct: -0.6 },
    { name: 'OP', category: 'L2', marketCap: 3800, changePct: 0.2 },
    { name: 'MATIC', category: 'L2', marketCap: 7500, changePct: -0.1 },
    { name: 'DOGE', category: 'Meme', marketCap: 25000, changePct: 2.1 },
    { name: 'SHIB', category: 'Meme', marketCap: 9000, changePct: -1.3 },
    { name: 'PEPE', category: 'Meme', marketCap: 5000, changePct: 3.5 },
    { name: 'WIF', category: 'Meme', marketCap: 3000, changePct: -1.8 },
    { name: 'RNDR', category: 'AI', marketCap: 5500, changePct: 1.5 },
    { name: 'FET', category: 'AI', marketCap: 3200, changePct: 0.8 },
    { name: 'TAO', category: 'AI', marketCap: 4800, changePct: -0.4 },
    { name: 'AXS', category: 'GameFi', marketCap: 1800, changePct: -0.3 },
    { name: 'GALA', category: 'GameFi', marketCap: 900, changePct: 0.7 },
    { name: 'IMX', category: 'GameFi', marketCap: 2200, changePct: 0.2 },
    { name: 'BLUR', category: 'NFT', marketCap: 800, changePct: -1.1 },
    { name: 'APE', category: 'NFT', marketCap: 1200, changePct: -0.5 },
  ],
  '24h': [
    { name: 'BTC', category: 'L1', marketCap: 1900000, changePct: 2.3 },
    { name: 'ETH', category: 'L1', marketCap: 420000, changePct: -1.2 },
    { name: 'SOL', category: 'L1', marketCap: 85000, changePct: 5.8 },
    { name: 'BNB', category: 'L1', marketCap: 95000, changePct: 0.7 },
    { name: 'ADA', category: 'L1', marketCap: 25000, changePct: -3.1 },
    { name: 'AVAX', category: 'L1', marketCap: 15000, changePct: 4.2 },
    { name: 'LINK', category: 'DeFi', marketCap: 12000, changePct: 3.5 },
    { name: 'UNI', category: 'DeFi', marketCap: 8000, changePct: -0.8 },
    { name: 'AAVE', category: 'DeFi', marketCap: 6000, changePct: 2.1 },
    { name: 'MKR', category: 'DeFi', marketCap: 3500, changePct: -1.5 },
    { name: 'ARB', category: 'L2', marketCap: 4500, changePct: -2.8 },
    { name: 'OP', category: 'L2', marketCap: 3800, changePct: 1.9 },
    { name: 'MATIC', category: 'L2', marketCap: 7500, changePct: -0.5 },
    { name: 'DOGE', category: 'Meme', marketCap: 25000, changePct: 8.2 },
    { name: 'SHIB', category: 'Meme', marketCap: 9000, changePct: -4.5 },
    { name: 'PEPE', category: 'Meme', marketCap: 5000, changePct: 12.3 },
    { name: 'WIF', category: 'Meme', marketCap: 3000, changePct: -6.7 },
    { name: 'RNDR', category: 'AI', marketCap: 5500, changePct: 7.1 },
    { name: 'FET', category: 'AI', marketCap: 3200, changePct: 4.5 },
    { name: 'TAO', category: 'AI', marketCap: 4800, changePct: -2.3 },
    { name: 'AXS', category: 'GameFi', marketCap: 1800, changePct: -1.2 },
    { name: 'GALA', category: 'GameFi', marketCap: 900, changePct: 3.8 },
    { name: 'IMX', category: 'GameFi', marketCap: 2200, changePct: 0.9 },
    { name: 'BLUR', category: 'NFT', marketCap: 800, changePct: -5.2 },
    { name: 'APE', category: 'NFT', marketCap: 1200, changePct: -2.1 },
  ],
  '7d': [
    { name: 'BTC', category: 'L1', marketCap: 1900000, changePct: 5.1 },
    { name: 'ETH', category: 'L1', marketCap: 420000, changePct: -3.8 },
    { name: 'SOL', category: 'L1', marketCap: 85000, changePct: 12.4 },
    { name: 'BNB', category: 'L1', marketCap: 95000, changePct: 1.9 },
    { name: 'ADA', category: 'L1', marketCap: 25000, changePct: -7.2 },
    { name: 'AVAX', category: 'L1', marketCap: 15000, changePct: 9.5 },
    { name: 'LINK', category: 'DeFi', marketCap: 12000, changePct: 8.3 },
    { name: 'UNI', category: 'DeFi', marketCap: 8000, changePct: -2.1 },
    { name: 'AAVE', category: 'DeFi', marketCap: 6000, changePct: 5.6 },
    { name: 'MKR', category: 'DeFi', marketCap: 3500, changePct: -4.2 },
    { name: 'ARB', category: 'L2', marketCap: 4500, changePct: -6.5 },
    { name: 'OP', category: 'L2', marketCap: 3800, changePct: 4.7 },
    { name: 'MATIC', category: 'L2', marketCap: 7500, changePct: -1.8 },
    { name: 'DOGE', category: 'Meme', marketCap: 25000, changePct: 18.5 },
    { name: 'SHIB', category: 'Meme', marketCap: 9000, changePct: -9.3 },
    { name: 'PEPE', category: 'Meme', marketCap: 5000, changePct: 25.8 },
    { name: 'WIF', category: 'Meme', marketCap: 3000, changePct: -14.2 },
    { name: 'RNDR', category: 'AI', marketCap: 5500, changePct: 15.3 },
    { name: 'FET', category: 'AI', marketCap: 3200, changePct: 11.2 },
    { name: 'TAO', category: 'AI', marketCap: 4800, changePct: -5.8 },
    { name: 'AXS', category: 'GameFi', marketCap: 1800, changePct: -3.5 },
    { name: 'GALA', category: 'GameFi', marketCap: 900, changePct: 8.9 },
    { name: 'IMX', category: 'GameFi', marketCap: 2200, changePct: 2.4 },
    { name: 'BLUR', category: 'NFT', marketCap: 800, changePct: -11.5 },
    { name: 'APE', category: 'NFT', marketCap: 1200, changePct: -5.8 },
  ],
}

function getChangeColor(changePct: number): string {
  const maxPct = 10
  const clamped = Math.max(-maxPct, Math.min(maxPct, changePct))
  const intensity = Math.abs(clamped) / maxPct

  if (clamped >= 0) {
    // Green: light (#4ade80) → deep (#15803d)
    const r = Math.round(74 - intensity * 53)
    const g = Math.round(222 - intensity * 94)
    const b = Math.round(128 - intensity * 67)
    return `rgb(${r}, ${g}, ${b})`
  } else {
    // Red: light (#f87171) → deep (#b91c1c)
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

// Simple treemap layout algorithm (squarified)
function layoutTreemap(
  data: SectorData[],
  containerWidth: number,
  containerHeight: number,
): TreemapNode[] {
  const total = data.reduce((sum, d) => sum + d.marketCap, 0)
  if (total === 0 || containerWidth <= 0 || containerHeight <= 0) return []

  const sorted = [...data].sort((a, b) => b.marketCap - a.marketCap)
  const nodes: TreemapNode[] = []

  let x = 0, y = 0, w = containerWidth, h = containerHeight
  let remaining = total

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]
    const ratio = item.marketCap / remaining

    if (w > h) {
      const itemW = w * ratio
      nodes.push({ ...item, x, y, width: itemW, height: h })
      x += itemW
      w -= itemW
    } else {
      const itemH = h * ratio
      nodes.push({ ...item, x, y, width: w, height: itemH })
      y += itemH
      h -= itemH
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

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) {
        setSize({ width: entry.contentRect.width, height: Math.max(200, Math.min(280, entry.contentRect.width * 0.25)) })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const nodes = layoutTreemap(MOCK_SECTORS[timeframe], size.width, size.height)

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
        <span style={{ fontSize: 16, fontWeight: 600, color: tokens.colors.text.primary }}>
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
        {nodes.map(node => {
          const isHovered = hoveredNode === node.name
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
                border: '1px solid var(--color-overlay-light)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                transition: 'filter 0.15s ease, transform 0.15s ease',
                filter: isHovered ? 'brightness(1.2)' : 'brightness(1)',
                zIndex: isHovered ? 10 : 1,
                boxShadow: isHovered ? '0 0 0 2px var(--glass-border-heavy)' : 'none',
                padding: 4,
              }}
            >
              {node.width > 40 && node.height > 30 && (
                <>
                  <span style={{
                    fontSize: Math.max(10, Math.min(16, node.width / 6)),
                    fontWeight: 700,
                    color: '#fff',
                    textShadow: '0 1px 2px var(--color-overlay-dark)',
                    lineHeight: 1.2,
                  }}>
                    {node.name}
                  </span>
                  <span style={{
                    fontSize: Math.max(9, Math.min(12, node.width / 8)),
                    fontWeight: 600,
                    color: 'var(--glass-bg-heavy)',
                    textShadow: '0 1px 2px var(--color-overlay-dark)',
                  }}>
                    {node.changePct >= 0 ? '+' : ''}{node.changePct.toFixed(1)}%
                  </span>
                </>
              )}
              {node.width > 60 && node.height > 50 && (
                <span style={{
                  fontSize: 9,
                  color: 'var(--glass-border-heavy)',
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
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 12,
            pointerEvents: 'none',
            zIndex: 1000,
            whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-sm-dark)',
          }}>
            <strong>{node.name}</strong> · {node.category}<br />
            市值: ${(node.marketCap / 1e3).toFixed(0)}B · {node.changePct >= 0 ? '+' : ''}{node.changePct.toFixed(1)}%
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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: 2, background: getChangeColor(-8) }} />
          大跌
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: 2, background: getChangeColor(-2) }} />
          小跌
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: 2, background: getChangeColor(2) }} />
          小涨
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, borderRadius: 2, background: getChangeColor(8) }} />
          大涨
        </span>
      </div>
    </div>
  )
}
