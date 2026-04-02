'use client'

/**
 * ShareOnXButton — opens the X compose window pre-filled with the trader's
 * wrapped rank card link and a concise share text.
 *
 * The button links to /wrapped/[handle] so X scrapes the OG image
 * from that page and shows the rank card inline in the tweet.
 *
 * Props:
 *   handle       — trader handle (used for /wrapped/ URL)
 *   displayName  — human-readable name shown in share text
 *   platform     — exchange source string (binance_futures, bybit, …)
 *   rank         — leaderboard rank number (optional)
 *   roi          — ROI percentage (optional)
 *   window       — time window override; if omitted, reads from global period store
 */

import { useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { usePeriodStore } from '@/lib/stores/periodStore'

interface ShareOnXButtonProps {
  handle: string
  displayName?: string
  platform?: string
  rank?: number | null
  roi?: number | null
  window?: string
}

const PLATFORM_LABELS: Record<string, string> = {
  binance_futures: 'Binance', binance_spot: 'Binance Spot',
  bybit: 'Bybit', bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget', okx: 'OKX', okx_futures: 'OKX',
  hyperliquid: 'Hyperliquid', gmx: 'GMX', mexc: 'MEXC',
  kucoin: 'KuCoin', coinex: 'CoinEx',
}

function formatRoiShort(roi: number): string {
  const sign = roi >= 0 ? '+' : '-'
  const abs = Math.abs(roi)
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K%`
  return `${sign}${abs.toFixed(1)}%`
}

function XIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 1200 1227"
      fill="currentColor"
      style={{ flexShrink: 0 }}
    >
      <path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z" />
    </svg>
  )
}

export default function ShareOnXButton({
  handle,
  displayName,
  platform,
  rank,
  roi,
  window: windowProp,
}: ShareOnXButtonProps) {
  const storePeriod = usePeriodStore(s => s.period)
  // Use prop if explicitly provided, otherwise read from global period store
  const windowParam = windowProp || storePeriod.toLowerCase()
  const name = displayName || handle

  const buildXUrl = useCallback(() => {
    const base =
      typeof window !== 'undefined'
        ? `${window.location.origin}`
        : 'https://www.arenafi.org'

    const params = new URLSearchParams()
    if (platform) params.set('platform', platform)
    params.set('window', windowParam)
    const sharePageUrl = `${base}/wrapped/${encodeURIComponent(handle)}?${params}`

    const platformLabel = platform ? (PLATFORM_LABELS[platform] ?? platform.replace(/_/g, ' ')) : ''
    const windowLabel = windowParam.toUpperCase()

    const lines: string[] = []
    if (rank) {
      lines.push(`Ranked ${rank} on Arena${platformLabel ? ` (${platformLabel})` : ''}`)
    } else {
      lines.push(`${name} on Arena${platformLabel ? ` | ${platformLabel}` : ''}`)
    }
    if (roi != null) {
      lines.push(`${formatRoiShort(roi)} ROI — ${windowLabel}`)
    }
    lines.push('')
    lines.push(sharePageUrl)

    const text = encodeURIComponent(lines.join('\n'))
    return `https://x.com/intent/post?text=${text}`
  }, [handle, platform, rank, roi, windowParam, name])

  const handleClick = useCallback(() => {
    const url = buildXUrl()
    const popup = window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500')
    if (!popup) {
      // Fallback: navigate directly if popup blocked
      window.location.href = url
    }
  }, [buildXUrl])

  return (
    <button
      onClick={handleClick}
      title="Share rank on X"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.lg,
        background: 'var(--glass-bg-medium)',
        border: '1px solid var(--glass-border-medium)',
        color: tokens.colors.text.primary,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.bold,
        cursor: 'pointer',
        transition: `all ${tokens.transition.base}`,
        whiteSpace: 'nowrap' as const,
        lineHeight: 1,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'var(--glass-bg-heavy)'
        e.currentTarget.style.borderColor = 'var(--color-border-secondary)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'var(--glass-bg-medium)'
        e.currentTarget.style.borderColor = 'var(--glass-border-medium)'
      }}
    >
      <XIcon />
      Share Rank
    </button>
  )
}
