'use client'

/**
 * ShareLeaderboardButton - Creates a ranking snapshot and share link
 *
 * Clicking creates a snapshot using /api/ranking-snapshot, generates
 * a short link /s/[token], and shows a share panel.
 */

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

interface TraderData {
  trader_key: string
  display_name: string | null
  platform: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
}

interface Props {
  traders: TraderData[]
  exchange?: string
}

export default function ShareLeaderboardButton({ traders, exchange }: Props) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [sharing, setSharing] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)

  const handleShare = useCallback(async () => {
    if (sharing) return
    setSharing(true)

    try {
      // Create snapshot via API
      const top25 = traders.slice(0, 25)
      const topTrader = top25[0]

      const res = await fetch('/api/ranking-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: exchange || 'all',
          timeRange: '90D',
          traders: top25.map((tr, i) => ({
            rank: i + 1,
            trader_id: tr.trader_key,
            handle: tr.display_name || tr.trader_key,
            source: tr.platform,
            roi: tr.roi,
            pnl: tr.pnl,
            win_rate: tr.win_rate,
            max_drawdown: tr.max_drawdown,
            arena_score: tr.arena_score,
          })),
          topTraderHandle: topTrader?.display_name || topTrader?.trader_key || '',
          topTraderRoi: topTrader?.roi || 0,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        const url = `${window.location.origin}/s/${data.token}`
        setShareUrl(url)

        // Try native share on mobile, otherwise copy to clipboard
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && /Mobi|Android/i.test(navigator.userAgent)) {
          await navigator.share({
            title: 'Arena Leaderboard Snapshot',
            url,
          }).catch(() => { // eslint-disable-line no-restricted-syntax -- fire-and-forget
            // user cancelled
          })
        } else {
          try {
            await navigator.clipboard.writeText(url)
            showToast(t('linkCopied'), 'success')
          } catch {
            showToast(t('copyFailed') || 'Copy failed', 'error')
          }
        }
      } else {
        // Fallback: just share the current page URL
        const url = window.location.href
        try {
          await navigator.clipboard.writeText(url)
          showToast(t('linkCopied'), 'success')
        } catch {
          showToast(t('copyFailed') || 'Copy failed', 'error')
        }
        setShareUrl(url)
      }
    } catch (_err) {
      // Fallback: share current URL
      const url = window.location.href
      try {
        await navigator.clipboard.writeText(url)
        showToast(t('linkCopied'), 'success')
      } catch {
        console.warn('[ShareLeaderboard] clipboard failed')
      }
    } finally {
      setSharing(false)
    }
  }, [traders, exchange, sharing, showToast, t])

  return (
    <button
      onClick={handleShare}
      disabled={sharing}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 16px',
        minHeight: 44,
        borderRadius: tokens.radius.md,
        border: '1px solid var(--glass-border-light)',
        background: 'transparent',
        color: tokens.colors.text.secondary,
        fontSize: 13,
        fontWeight: 600,
        cursor: sharing ? 'wait' : 'pointer',
        opacity: sharing ? 0.7 : 1,
        transition: 'all 0.15s',
      }}
      title={t('shareSnapshot')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
      </svg>
      {sharing ? '...' : t('shareSnapshot')}
    </button>
  )
}
