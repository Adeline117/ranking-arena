'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/ui/Toast'
import type { PersonalityType } from '../../components/types'

interface ShareActionsProps {
  type: PersonalityType
  matchPercent: number
  resultUrl: string
  tr: (key: string) => string
}

export default function ShareActions({ type, matchPercent, resultUrl, tr }: ShareActionsProps) {
  const { showToast } = useToast()
  const [downloading, setDownloading] = useState(false)

  const shareText = tr('quizShareText')
    .replace('{type}', tr(type.nameKey))
    .replace('{match}', String(matchPercent))
    .replace('{url}', resultUrl)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resultUrl)
      showToast(tr('quizCopied'), 'success')
    } catch {
      showToast(tr('quizCopyFailed'), 'error')
    }
  }

  const handleShareX = () => {
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleShareTelegram = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(resultUrl)}&text=${encodeURIComponent(shareText)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const ogUrl = `/api/og/quiz?type=${type.id}&match=${matchPercent}`
      const res = await fetch(ogUrl)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `arena-${type.id}-personality.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      showToast(tr('quizDownloadFailed'), 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: tr('quizTitle'), text: shareText, url: resultUrl })
      } catch {
        // User cancelled — ignore
      }
    }
  }

  const btnStyle = {
    flex: 1,
    minWidth: 80,
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid var(--glass-border-light)',
    background: 'var(--color-overlay-subtle)',
    color: 'var(--color-text-primary)',
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.medium,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    transition: 'border-color 0.2s, background 0.2s',
  } as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Share buttons row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={handleShareX} style={btnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          X
        </button>
        <button onClick={handleShareTelegram} style={btnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
          </svg>
          Telegram
        </button>
        <button onClick={handleCopy} style={btnStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {tr('quizCopyLink')}
        </button>
      </div>

      {/* Download + Native share */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleDownload}
          disabled={downloading}
          style={{
            ...btnStyle,
            opacity: downloading ? 0.6 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {downloading ? '...' : tr('quizDownloadCard')}
        </button>
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <button onClick={handleNativeShare} style={btnStyle}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            {tr('quizShare')}
          </button>
        )}
      </div>
    </div>
  )
}
