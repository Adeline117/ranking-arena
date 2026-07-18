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
// Returns the interpolated tile background as an [r,g,b] tuple so callers can
// both paint it AND measure its luminance to pick legible text (see
// getTileTextTheme). Keeping one source of truth avoids bg/text drift.
function getChangeRgb(changePct: number, isLight = false): [number, number, number] {
  const maxPct = 10
  const clamped = Math.max(-maxPct, Math.min(maxPct, changePct))
  const intensity = Math.abs(clamped) / maxPct // 0 at 0%, 1 at ±maxPct
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
  const mix = (
    mid: [number, number, number],
    end: [number, number, number]
  ): [number, number, number] => [
    lerp(mid[0], end[0], intensity),
    lerp(mid[1], end[1], intensity),
    lerp(mid[2], end[2], intensity),
  ]

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

function getChangeColor(changePct: number, isLight = false): string {
  const [r, g, b] = getChangeRgb(changePct, isLight)
  return `rgb(${r}, ${g}, ${b})`
}

// WCAG relative luminance of an sRGB tuple (0 = black, 1 = white).
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// Picks legible tile-label colors from the tile's own background luminance.
// Pick black or white at the WCAG crossover instead of guessing from theme.
// A tile luminance around 0.18 is the boundary where white stops meeting 4.5:1
// and black starts meeting it. The previous light-theme-only 0.4 threshold left
// medium green tiles with neither readable white nor sufficiently opaque dark
// labels.
function getTileTextTheme(
  changePct: number,
  isLight: boolean
): { name: string; pct: string; cat: string; nameShadow: string; softShadow: string } {
  const useDarkText = relativeLuminance(getChangeRgb(changePct, isLight)) > 0.18
  if (useDarkText) {
    return {
      name: tokens.colors.black,
      pct: tokens.colors.black,
      cat: tokens.colors.black,
      nameShadow: 'none',
      softShadow: 'none',
    }
  }
  return {
    name: tokens.colors.white,
    pct: tokens.colors.white,
    cat: tokens.colors.white,
    nameShadow: '0 1px 4px rgba(0,0,0,0.7), 0 0px 1px rgba(0,0,0,0.5)',
    softShadow: '0 1px 3px rgba(0,0,0,0.6)',
  }
}

interface TreemapDatum {
  name: string
  category: string
  marketCap: number
  changePct: number
  /** Aggregated long-tail tile — rendered with the i18n "Others" label. */
  isOthers?: boolean
  /** Symbols folded into the aggregate (shown in the tooltip). */
  members?: string[]
}

interface TreemapNode extends TreemapDatum {
  x: number
  y: number
  width: number
  height: number
}

// Internal sentinel name for the aggregated tile (never a real ticker symbol);
// the user-visible label goes through t('sectorTreemapOthers').
const OTHERS_NAME = '__others__'

// WCAG 2.5.8 minimum pointer target is 24×24 CSS px. Squarified tiles stay
// near-square (worst aspect ratio in practice ≲ 2.5), so a tile needs roughly
// 2.5× the minimum square's AREA to keep its short side above 24px. Coins
// whose area ∝ market cap would fall below this are folded into one "Others"
// aggregate tile instead of rendering as untappable slivers.
const MIN_TILE_SIDE = 24
const MIN_TILE_AREA = MIN_TILE_SIDE * MIN_TILE_SIDE * 2.5

// True squarified treemap (Bruls, Huizing & van Wijk 2000): pack items into
// rows along the shorter side of the remaining rectangle, accepting a new item
// into the current row only while it does not worsen the row's worst aspect
// ratio. Keeps tiles near-square so long-tail coins stay clickable targets —
// the previous naive strip-slice produced 6px-wide slivers under BTC dominance
// (WCAG 2.5.8 target-size failure). Area remains exactly ∝ market cap.
function squarify(data: TreemapDatum[], x: number, y: number, w: number, h: number): TreemapNode[] {
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
  const [loading, setLoading] = useState(spotData === undefined)
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
    if (spotData === undefined) return
    if (!Array.isArray(spotData) || spotData.length === 0) {
      setCoins([])
      setLoading(false)
      return
    }
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

  const coinsWithPct: TreemapDatum[] = coins.map((c) => ({
    name: c.name,
    category: c.category,
    marketCap: c.marketCap,
    changePct: timeframe === '1h' ? c.change1h : timeframe === '7d' ? c.change7d : c.change24h,
  }))
  // Long-tail aggregation (WCAG 2.5.8): coins whose area-∝-market-cap tile
  // would land under the 24px pointer target get merged into one "Others"
  // tile. Its click reuses the existing onSectorClick path with the 'Other'
  // category; its change % is the market-cap-weighted average of members.
  const totalCap = coinsWithPct.reduce((s, c) => s + c.marketCap, 0)
  const areaScale = totalCap > 0 ? (size.width * size.height) / totalCap : 0
  const isTiny = (c: TreemapDatum) => areaScale > 0 && c.marketCap * areaScale < MIN_TILE_AREA
  const tiny = coinsWithPct.filter(isTiny)
  let layoutData = coinsWithPct
  if (tiny.length >= 2) {
    const tinyCap = tiny.reduce((s, c) => s + c.marketCap, 0)
    const weightedPct =
      tinyCap > 0 ? tiny.reduce((s, c) => s + c.changePct * c.marketCap, 0) / tinyCap : 0
    layoutData = [
      ...coinsWithPct.filter((c) => !isTiny(c)),
      {
        name: OTHERS_NAME,
        category: 'Other',
        marketCap: tinyCap,
        changePct: weightedPct,
        isOthers: true,
        members: tiny.map((c) => c.name),
      },
    ]
  }
  const nodes = squarify(layoutData, 0, 0, size.width, size.height)
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
                background: timeframe === tf.key ? 'var(--color-brand-deep)' : 'transparent',
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
            const displayName = node.isOthers ? t('sectorTreemapOthers') : node.name
            const showName = node.width > 36 && node.height > 28
            const showPct = node.width > 44 && node.height > 44
            const showCat = node.width > 70 && node.height > 60
            const fontSize = Math.max(9, Math.min(14, Math.min(node.width / 6, node.height / 4)))
            const textTheme = getTileTextTheme(node.changePct, isLight)
            return (
              <div
                key={node.name}
                role="button"
                tabIndex={0}
                // Stable locator anchor for tests/scanners. The accessible NAME
                // stays stable too (name + category only) — live spot numbers
                // tick every 30s (useMarketSpot REFETCH_REALTIME), and putting
                // them in aria-label made the SR focus name + label-based
                // selectors churn mid-session. Volatile numbers live in the
                // aria-describedby sr-only span below instead.
                data-testid={`treemap-tile-${node.name}`}
                aria-label={`${displayName} (${node.category})`}
                aria-describedby={`treemap-desc-${node.name}`}
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
                {/* Volatile live numbers exposed as accessible DESCRIPTION
                    (not name) so the tile's name stays stable across the 30s
                    spot refetch — see aria-describedby on the tile div. */}
                <span id={`treemap-desc-${node.name}`} className="sr-only">
                  {`${node.changePct >= 0 ? '+' : ''}${node.changePct.toFixed(1)}%, ${t('sectorTreemapMCap')} $${(node.marketCap / 1e9).toFixed(1)}B`}
                </span>
                {showName && (
                  <span
                    style={{
                      fontSize,
                      fontWeight: 800,
                      color: textTheme.name,
                      textShadow: textTheme.nameShadow,
                      lineHeight: 1.1,
                      maxWidth: '90%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {displayName}
                  </span>
                )}
                {showPct && (
                  <span
                    style={
                      {
                        fontSize: Math.max(9, fontSize * 0.7),
                        fontWeight: 700,
                        color: textTheme.pct,
                        textShadow: textTheme.softShadow,
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
                      color: textTheme.cat,
                      textShadow: textTheme.softShadow,
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
              <strong>{node.isOthers ? t('sectorTreemapOthers') : node.name}</strong> /{' '}
              {node.category}
              <br />
              {t('sectorTreemapMCap')}: ${(node.marketCap / 1e9).toFixed(1)}B &middot;{' '}
              {node.changePct >= 0 ? '+' : ''}
              {node.changePct.toFixed(2)}%
              {node.isOthers && node.members && node.members.length > 0 && (
                <>
                  <br />
                  {node.members.join(' · ')}
                </>
              )}
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
