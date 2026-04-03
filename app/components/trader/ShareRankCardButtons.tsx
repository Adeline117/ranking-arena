'use client'

/**
 * ShareRankCardButtons -- share buttons for trader pages
 *
 * Provides:
 * 1. Copy link button (copies trader URL with optional referral code)
 * 2. Share on X button (opens X compose with rank card link + OG image)
 */

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

interface ShareRankCardButtonsProps {
  handle: string
  displayName?: string
  platform?: string
  rank?: number | null
  roi?: number | null
  arenaScore?: number | null
  window?: string
  referralCode?: string | null
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function CheckIconSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 1200 1227" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z" />
    </svg>
  )
}

const PLATFORM_LABELS: Record<string, string> = {
  binance_futures: 'Binance', binance_spot: 'Binance Spot',
  bybit: 'Bybit', bitget_futures: 'Bitget',
  okx: 'OKX', okx_futures: 'OKX',
  hyperliquid: 'Hyperliquid', gmx: 'GMX',
  mexc: 'MEXC', gateio: 'Gate.io', dydx: 'dYdX',
}

function formatRoiShort(roi: number): string {
  const sign = roi >= 0 ? '+' : '-'
  const abs = Math.abs(roi)
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K%`
  return `${sign}${abs.toFixed(1)}%`
}

export default function ShareRankCardButtons({
  handle,
  displayName,
  platform,
  rank,
  roi,
  arenaScore,
  window: windowProp = '90d',
  referralCode,
}: ShareRankCardButtonsProps) {
  const [copied, setCopied] = useState(false)
  const { t } = useLanguage()
  const { showToast } = useToast()

  const buildShareUrl = useCallback(() => {
    const base = typeof window !== 'undefined'
      ? window.location.origin
      : 'https://www.arenafi.org'

    const params = new URLSearchParams()
    if (platform) params.set('platform', platform)
    params.set('window', windowProp)
    if (referralCode) params.set('ref', referralCode)

    return `${base}/share/rank/${encodeURIComponent(handle)}?${params}`
  }, [handle, platform, windowProp, referralCode])

  const copyLink = useCallback(async () => {
    try {
      const url = buildShareUrl()
      await navigator.clipboard.writeText(url)
      setCopied(true)
      showToast(t('linkCopied'), 'success')
      setTimeout(() => setCopied(false), 2500)
    } catch {
      showToast(t('copyFailed') || 'Failed to copy', 'error')
    }
  }, [buildShareUrl, showToast, t])

  const shareOnX = useCallback(() => {
    const url = buildShareUrl()
    const name = displayName || handle
    const platformLabel = platform ? (PLATFORM_LABELS[platform] ?? platform.replace(/_/g, ' ')) : ''

    const lines: string[] = []
    if (rank && rank > 0) {
      lines.push(`Ranked #${rank} on Arena${platformLabel ? ` (${platformLabel})` : ''}`)
    } else {
      lines.push(`${name} on Arena${platformLabel ? ` | ${platformLabel}` : ''}`)
    }
    if (roi != null) {
      lines.push(`${formatRoiShort(roi)} ROI${arenaScore != null ? ` | Score: ${Math.round(arenaScore)}` : ''}`)
    }
    lines.push('')
    lines.push(url)

    const text = encodeURIComponent(lines.join('\n'))
    window.open(`https://x.com/intent/post?text=${text}`, '_blank', 'noopener,noreferrer,width=600,height=500')
  }, [buildShareUrl, handle, displayName, platform, rank, roi, arenaScore])

  const btnBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.md,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.tertiary,
    color: tokens.colors.text.secondary,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    transition: `all ${tokens.transition.base}`,
    whiteSpace: 'nowrap',
    lineHeight: 1.2,
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        onClick={copyLink}
        title={t('copyShareLink') || 'Copy share link'}
        style={{
          ...btnBase,
          color: copied ? tokens.colors.accent.success : tokens.colors.text.secondary,
          borderColor: copied ? `${tokens.colors.accent.success}40` : tokens.colors.border.primary,
        }}
      >
        {copied ? <CheckIconSmall /> : <CopyIcon />}
        <span className="hide-below-sm">
          {copied ? (t('copied') || 'Copied!') : (t('copyShareLink') || 'Copy Link')}
        </span>
      </button>

      <button
        onClick={shareOnX}
        title={t('shareOnX') || 'Share on X'}
        style={btnBase}
      >
        <XIcon />
        <span className="hide-below-sm">
          {t('shareOnX') || 'Share on X'}
        </span>
      </button>

      <button
        onClick={() => window.print()}
        title={t('printOrPdf') || 'Print / Save as PDF'}
        className="print-hide"
        style={btnBase}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 6 2 18 2 18 9" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
        <span className="hide-below-sm">
          {t('printOrPdf') || 'Print / PDF'}
        </span>
      </button>
    </div>
  )
}
