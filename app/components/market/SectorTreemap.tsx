'use client'

import { useEffect, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { SpotCoin } from '@/lib/hooks/useMarketSpot'

type TimeFrame = '1h' | '24h' | '7d'

const CATEGORY_MAP: Record<string, string> = {
  BTC: 'L1',
  ETH: 'L1',
  SOL: 'L1',
  BNB: 'L1',
  ADA: 'L1',
  AVAX: 'L1',
  DOT: 'L1',
  NEAR: 'L1',
  ATOM: 'L1',
  SUI: 'L1',
  APT: 'L1',
  TRX: 'L1',
  TON: 'L1',
  XRP: 'L1',
  LINK: 'DeFi',
  UNI: 'DeFi',
  AAVE: 'DeFi',
  MKR: 'DeFi',
  CRV: 'DeFi',
  SNX: 'DeFi',
  COMP: 'DeFi',
  SUSHI: 'DeFi',
  DYDX: 'DeFi',
  LDO: 'DeFi',
  ARB: 'L2',
  OP: 'L2',
  MATIC: 'L2',
  STRK: 'L2',
  IMX: 'L2',
  MANTA: 'L2',
  DOGE: 'Meme',
  SHIB: 'Meme',
  PEPE: 'Meme',
  WIF: 'Meme',
  FLOKI: 'Meme',
  BONK: 'Meme',
  RNDR: 'AI',
  FET: 'AI',
  TAO: 'AI',
  AGIX: 'AI',
  WLD: 'AI',
  AXS: 'GameFi',
  GALA: 'GameFi',
  SAND: 'GameFi',
  MANA: 'GameFi',
  BLUR: 'NFT',
  APE: 'NFT',
  USDT: 'Stable',
  USDC: 'Stable',
  DAI: 'Stable',
  USDS: 'Stable',
  USDE: 'Stable',
  USD1: 'Stable',
  USYC: 'Stable',
  USDG: 'Stable',
  FDUSD: 'Stable',
  TUSD: 'Stable',
  BUSD: 'Stable',
  PYUSD: 'Stable',
  XLM: 'L1',
  ALGO: 'L1',
  ICP: 'L1',
  FIL: 'Infra',
  AR: 'Infra',
  THETA: 'Infra',
}

// Diverging gain/loss ramp anchored at 0% (intensity 0 = neutral midpoint).
// Keeps the red(loss)/green(gain) SEMANTIC, but encodes direction with
// LUMINANCE too — gains trend toward a *bright* green (high luminance) and
// losses toward a *dark* red (low luminance). Protan/deutan viewers who can't
// separate the two hues can still read direction by lightness. A continuous
// per-tile ramp can't be a design token, so rgb() interpolation is intentional.
function getChangeColor(changePct: number, isLight = false): string {
  const maxPct = 10
  const clamped = Math.max(-maxPct, Math.min(maxPct, changePct))
  const intensity = Math.abs(clamped) / maxPct // 0 at 0%, 1 at ±maxPct
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
  const mix = (mid: [number, number, number], end: [number, number, number]) =>
    `rgb(${lerp(mid[0], end[0], intensity)}, ${lerp(mid[1], end[1], intensity)}, ${lerp(mid[2], end[2], intensity)})`

  if (isLight) {
    // Light theme: neutral light-slate midpoint
    const mid: [number, number, number] = [210, 216, 224]
    // gain → vivid green (higher luminance) | loss → deep dark red (low luminance)
    return clamped >= 0 ? mix(mid, [21, 150, 70]) : mix(mid, [140, 22, 30])
  }
  // Dark theme: muted slate midpoint
  const mid: [number, number, number] = [51, 65, 85]
  // gain → bright green (high luminance) | loss → dark crimson (low luminance)
  return clamped >= 0 ? mix(mid, [34, 197, 94]) : mix(mid, [120, 22, 35])
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

// True squarified treemap (Bruls, Huizing & van Wijk 2000): pack items into
// rows along the shorter side of the remaining rectangle, accepting a new item
// into the current row only while it does not worsen the row's worst aspect
// ratio. Keeps tiles near-square so long-tail coins stay clickable targets —
// the previous naive strip-slice produced 6px-wide slivers under BTC dominance
// (WCAG 2.5.8 target-size failure). Area remains exactly ∝ market cap.
function squarify(
  data: { name: string; category: string; marketCap: number; changePct: number }[],
  x: number,
  y: number,
  w: number,
  h: number
): TreemapNode[] {
  if (data.length === 0 || w <= 0 || h <= 0) return []
  const total = data.reduce((s, d) => s + d.marketCap, 0)
  if (total === 0) return []
  const scale = (w * h) / total
  const items = [...data]
    .sort((a, b) => b.marketCap - a.marketCap)
    .map((d) => ({ item: d, area: d.marketCap * scale }))
  const nodes: TreemapNode[] = []
  let cx = x,
    cy = y,
    cw = w,
    ch = h

  // Worst (largest) aspect ratio in a row of the given areas laid along a side
  // of length `side`. Row thickness = sum/side; each cell length = area/thickness.
  const worst = (areas: number[], sum: number, side: number): number => {
    if (areas.length === 0 || sum <= 0 || side <= 0) return Infinity
    const thickness = sum / side
    let max = 0
    for (const a of areas) {
      const len = a / thickness
      const ratio = Math.max(thickness / len, len / thickness)
      if (ratio > max) max = ratio
    }
    return max
  }

  const layoutRow = (row: { item: (typeof data)[number]; area: number }[], sum: number) => {
    if (row.length === 0 || sum <= 0) return
    if (cw >= ch) {
      // Vertical row against the left edge
      const rowW = sum / ch
      let ry = cy
      for (const { item, area } of row) {
        const cellH = area / rowW
        nodes.push({ ...item, x: cx, y: ry, width: rowW, height: cellH })
        ry += cellH
      }
      cx += rowW
      cw -= rowW
    } else {
      // Horizontal row against the top edge
      const rowH = sum / cw
      let rx = cx
      for (const { item, area } of row) {
        const cellW = area / rowH
        nodes.push({ ...item, x: rx, y: cy, width: cellW, height: rowH })
        rx += cellW
      }
      cy += rowH
      ch -= rowH
    }
  }

  let row: { item: (typeof data)[number]; area: number }[] = []
  let rowSum = 0
  for (const entry of items) {
    const side = Math.min(cw, ch)
    const currentAreas = row.map((r) => r.area)
    const withEntry = [...currentAreas, entry.area]
    if (
      row.length === 0 ||
      worst(withEntry, rowSum + entry.area, side) <= worst(currentAreas, rowSum, side)
    ) {
      row.push(entry)
      rowSum += entry.area
    } else {
      layoutRow(row, rowSum)
      row = [entry]
      rowSum = entry.area
    }
  }
  layoutRow(row, rowSum)
  return nodes
}

export default function SectorTreemap({
  spotData,
  onSectorClick,
}: {
  spotData?: SpotCoin[]
  onSectorClick?: (category: string) => void
}) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const [timeframe, setTimeframe] = useState<TimeFrame>('24h')
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [coins, setCoins] = useState<
    {
      name: string
      category: string
      marketCap: number
      change1h: number
      change24h: number
      change7d: number
    }[]
  >([])
  const [loading, setLoading] = useState(true)
  const [isLight, setIsLight] = useState(false)

  useEffect(() => {
    const getLight = () => document.documentElement.getAttribute('data-theme') === 'light'
    setIsLight(getLight())
    const observer = new MutationObserver(() => setIsLight(getLight()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  // Use shared spot data from parent instead of fetching independently
  useEffect(() => {
    if (!spotData || !Array.isArray(spotData) || spotData.length === 0) return
    const mapped = spotData
      .filter(
        (c) =>
          c.marketCap > 0 &&
          c.change24h !== null &&
          // Stablecoins are excluded by category rule (not a hardcoded symbol
          // list) — a % change heatmap has no signal for pegged assets, and
          // their ~+0.0% tiles would crowd out real movers in the top-30 cut.
          CATEGORY_MAP[c.symbol] !== 'Stable'
      )
      .slice(0, 30)
      .map((c) => ({
        name: c.symbol,
        category: CATEGORY_MAP[c.symbol] || 'Other',
        marketCap: c.marketCap,
        change1h: (c as unknown as { change1h?: number }).change1h ?? 0,
        change24h: c.change24h ?? 0,
        change7d: (c as unknown as { change7d?: number }).change7d ?? 0,
      }))
    setCoins(mapped)
    setLoading(false)
  }, [spotData])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry)
        setSize({
          width: entry.contentRect.width,
          height: Math.max(240, Math.min(360, entry.contentRect.width * 0.3)),
        })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const coinsWithPct = coins.map((c) => ({
    ...c,
    changePct: timeframe === '1h' ? c.change1h : timeframe === '7d' ? c.change7d : c.change24h,
  }))
  const nodes = squarify(coinsWithPct, 0, 0, size.width, size.height)
  const timeframes: { key: TimeFrame; label: string }[] = [
    { key: '1h', label: t('sectorTreemap1h') },
    { key: '24h', label: t('sectorTreemap24h') },
    { key: '7d', label: t('sectorTreemap7d') },
  ]

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 700, color: tokens.colors.text.primary }}>
          {t('sectorTreemapTitle')}
        </span>
        <div
          style={{
            display: 'flex',
            gap: 2,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.md,
            padding: 2,
          }}
        >
          {timeframes.map((tf) => (
            <button
              key={tf.key}
              onClick={() => setTimeframe(tf.key)}
              style={{
                padding: '5px 14px',
                fontSize: 12,
                fontWeight: timeframe === tf.key ? 700 : 500,
                borderRadius: tokens.radius.sm,
                border: 'none',
                cursor: 'pointer',
                background: timeframe === tf.key ? tokens.colors.accent.primary : 'transparent',
                color: timeframe === tf.key ? tokens.colors.white : tokens.colors.text.tertiary,
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
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
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tokens.colors.text.tertiary,
              fontSize: 14,
            }}
          >
            {t('sectorTreemapLoading')}
          </div>
        ) : nodes.length === 0 ? (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tokens.colors.text.tertiary,
              fontSize: 14,
            }}
          >
            {t('noDataGeneric')}
          </div>
        ) : (
          nodes.map((node) => {
            const isHovered = hoveredNode === node.name
            const showName = node.width > 36 && node.height > 28
            const showPct = node.width > 44 && node.height > 44
            const showCat = node.width > 70 && node.height > 60
            const fontSize = Math.max(9, Math.min(14, Math.min(node.width / 6, node.height / 4)))
            return (
              <div
                key={node.name}
                role="button"
                tabIndex={0}
                // Stable locator anchor: aria-label embeds live spot numbers that
                // tick every 30s (useMarketSpot REFETCH_REALTIME), so label-based
                // selectors go stale mid-session. Tests/scanners must target this.
                data-testid={`treemap-tile-${node.name}`}
                aria-label={`${node.name} (${node.category}): ${node.changePct >= 0 ? '+' : ''}${node.changePct.toFixed(1)}%, ${t('sectorTreemapMCap')} $${(node.marketCap / 1e9).toFixed(1)}B`}
                onClick={() => onSectorClick?.(node.category)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSectorClick?.(node.category)
                  }
                }}
                onMouseEnter={() => setHoveredNode(node.name)}
                onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHoveredNode(null)}
                onFocus={(e) => {
                  // Keyboard focus has no pointer coords — anchor the tooltip to
                  // the focused tile's rect so it renders in place (not at 0,0).
                  const rect = e.currentTarget.getBoundingClientRect()
                  setTooltipPos({ x: rect.left, y: rect.top + 40 })
                  setHoveredNode(node.name)
                }}
                onBlur={() => setHoveredNode(null)}
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  background: getChangeColor(node.changePct, isLight),
                  border: '1px solid var(--color-overlay-light)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  transition: 'filter 0.15s ease',
                  filter: isHovered ? 'brightness(1.25)' : 'brightness(1)',
                  zIndex: isHovered ? 10 : 1,
                  boxShadow: isHovered ? '0 0 0 2px var(--glass-border-heavy)' : 'none',
                  padding: 2,
                }}
              >
                {showName && (
                  <span
                    style={{
                      fontSize,
                      fontWeight: 800,
                      color: 'var(--color-on-accent)',
                      textShadow: isLight
                        ? '0 1px 2px rgba(255,255,255,0.6)'
                        : '0 1px 4px rgba(0,0,0,0.7), 0 0px 1px rgba(0,0,0,0.5)',
                      lineHeight: 1.1,
                      maxWidth: '90%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {node.name}
                  </span>
                )}
                {showPct && (
                  <span
                    style={
                      {
                        fontSize: Math.max(9, fontSize * 0.7),
                        fontWeight: 700,
                        color: isLight ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.9)',
                        textShadow: isLight
                          ? '0 1px 3px rgba(0,0,0,0.4)'
                          : '0 1px 3px rgba(0,0,0,0.6)',
                        lineHeight: 1.1,
                        fontFamily: 'var(--font-mono, monospace)',
                        fontVariantNumeric: 'tabular-nums',
                      } as React.CSSProperties
                    }
                  >
                    {node.changePct >= 0 ? '+' : ''}
                    {node.changePct.toFixed(1)}%
                  </span>
                )}
                {showCat && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.65)',
                      textShadow: isLight ? 'none' : '0 1px 2px rgba(0,0,0,0.5)',
                      marginTop: 2,
                      maxWidth: '90%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {node.category}
                  </span>
                )}
              </div>
            )
          })
        )}
      </div>
      {hoveredNode &&
        (() => {
          const node = nodes.find((n) => n.name === hoveredNode)
          if (!node) return null
          return (
            <div
              style={{
                position: 'fixed',
                left: tooltipPos.x + 12,
                top: tooltipPos.y - 40,
                background: 'var(--color-backdrop-heavy)',
                color: 'var(--foreground)',
                padding: '6px 10px',
                borderRadius: tokens.radius.sm,
                fontSize: 12,
                pointerEvents: 'none',
                zIndex: tokens.zIndex.tooltip,
                whiteSpace: 'nowrap',
              }}
            >
              <strong>{node.name}</strong> / {node.category}
              <br />
              {t('sectorTreemapMCap')}: ${(node.marketCap / 1e9).toFixed(1)}B &middot;{' '}
              {node.changePct >= 0 ? '+' : ''}
              {node.changePct.toFixed(2)}%
            </div>
          )
        })()}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 16,
          marginTop: 8,
          fontSize: 11,
          color: tokens.colors.text.tertiary,
        }}
      >
        {[
          { label: t('sectorTreemapBigDrop'), val: -8 },
          { label: t('sectorTreemapDip'), val: -2 },
          { label: t('sectorTreemapRise'), val: 2 },
          { label: t('sectorTreemapRally'), val: 8 },
        ].map((item) => (
          <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 2,
                background: getChangeColor(item.val, isLight),
              }}
            />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}
