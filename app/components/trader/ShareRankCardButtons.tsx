'use client'

/**
 * ShareRankCardButtons -- share buttons for trader pages
 *
 * Provides:
 * 1. Copy link button (copies trader URL with optional referral code)
 * 2. Share on X button (opens X compose with rank card link + OG image)
 */

import { useState, useCallback } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { platformLabel, formatRoiShort } from '@/lib/constants/platform-labels'

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
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function CheckIconSmall() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
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
  const [embedCopied, setEmbedCopied] = useState(false)
  const { t } = useLanguage()
  const { showToast } = useToast()

  const buildShareUrl = useCallback(() => {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://www.arenafi.org'

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
      showToast(t('copyFailed'), 'error')
    }
  }, [buildShareUrl, showToast, t])

  const copyEmbed = useCallback(async () => {
    try {
      const base =
        typeof window !== 'undefined' ? window.location.origin : 'https://www.arenafi.org'
      const h = encodeURIComponent(handle)
      const profileParams = new URLSearchParams()
      if (platform) profileParams.set('platform', platform)
      const profileUrl = `${base}/trader/${h}${profileParams.toString() ? `?${profileParams}` : ''}`
      const badgeUrl = `${base}/api/badge/trader/${h}.svg`
      const alt = (displayName || handle).replace(/"/g, '')
      // Anchor-wrapped <img> so every embed is a backlink to the trader's Arena
      // profile (SEO + growth loop).
      const snippet = `<a href="${profileUrl}"><img src="${badgeUrl}" alt="${alt} on Arena" width="268" height="64" /></a>`
      await navigator.clipboard.writeText(snippet)
      setEmbedCopied(true)
      showToast(t('embedCopied'), 'success')
      setTimeout(() => setEmbedCopied(false), 2500)
    } catch {
      showToast(t('copyFailed'), 'error')
    }
  }, [handle, platform, displayName, showToast, t])

  const shareOnX = useCallback(() => {
    const url = buildShareUrl()
    const name = displayName || handle
    const platLabel = platformLabel(platform)

    const lines: string[] = []
    if (rank && rank > 0) {
      // `rank` here is the exchange-internal leaderboard position (same value the
      // profile header labels "Ranked N on <exchange>"). Attribute it to the
      // exchange, not "Arena", so the share text doesn't contradict the header
      // by re-badging an exchange rank as an Arena rank.
      lines.push(platLabel ? `Ranked #${rank} on ${platLabel}` : `Ranked #${rank} on Arena`)
    } else {
      lines.push(`${name} on Arena${platLabel ? ` | ${platLabel}` : ''}`)
    }
    if (roi != null) {
      lines.push(
        `${formatRoiShort(roi)} ROI${arenaScore != null ? ` | Score: ${Math.round(arenaScore)}` : ''}`
      )
    }
    lines.push('')
    lines.push(url)

    const text = encodeURIComponent(lines.join('\n'))
    window.open(
      `https://x.com/intent/post?text=${text}`,
      '_blank',
      'noopener,noreferrer,width=600,height=500'
    )
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
        title={t('copyShareLink')}
        style={{
          ...btnBase,
          color: copied ? tokens.colors.accent.success : tokens.colors.text.secondary,
          borderColor: copied
            ? `${alpha(tokens.colors.accent.success, 25)}`
            : tokens.colors.border.primary,
        }}
      >
        {copied ? <CheckIconSmall /> : <CopyIcon />}
        <span className="hide-below-sm">{copied ? t('copied') : t('copyShareLink')}</span>
      </button>

      <button onClick={shareOnX} title={t('shareOnX')} style={btnBase}>
        <XIcon />
        <span className="hide-below-sm">{t('shareOnX')}</span>
      </button>

      <button
        onClick={copyEmbed}
        title={t('embedBadge')}
        className="print-hide"
        style={{
          ...btnBase,
          color: embedCopied ? tokens.colors.accent.success : tokens.colors.text.secondary,
          borderColor: embedCopied
            ? `${alpha(tokens.colors.accent.success, 25)}`
            : tokens.colors.border.primary,
        }}
      >
        {embedCopied ? (
          <CheckIconSmall />
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        )}
        <span className="hide-below-sm">{embedCopied ? t('copied') : t('embedBadge')}</span>
      </button>

      <button
        onClick={() => window.print()}
        title={t('printOrPdf')}
        className="print-hide"
        style={btnBase}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 6 2 18 2 18 9" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
        <span className="hide-below-sm">{t('printOrPdf')}</span>
      </button>
    </div>
  )
}
