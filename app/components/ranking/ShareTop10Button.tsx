'use client'

import React, { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import type { Trader } from './RankingTable'

interface ShareTop10ButtonProps {
  traders: Trader[]
  timeRange?: string
  disabled?: boolean
}

export default function ShareTop10Button({ traders, timeRange = '90D', disabled }: ShareTop10ButtonProps) {
  const { language } = useLanguage()
  const [copied, setCopied] = useState(false)

  const handleShare = async () => {
    const top10 = traders.slice(0, 10)
    if (top10.length === 0) return

    const lines = [
      `Ranking Arena Top 10 (${timeRange})`,
      '─'.repeat(30),
      ...top10.map((t, i) => {
        const handle = t.handle || t.id
        const displayName = handle.startsWith('0x') && handle.length > 20
          ? `${handle.substring(0, 6)}...${handle.substring(handle.length - 4)}`
          : handle
        const score = t.arena_score != null ? t.arena_score.toFixed(1) : '—'
        const roi = t.roi >= 0 ? `+${t.roi.toFixed(1)}%` : `${t.roi.toFixed(1)}%`
        return `#${i + 1} ${displayName} | Score: ${score} | ROI: ${roi}`
      }),
      '',
      'rankingarena.com',
    ]
    const text = lines.join('\n')

    // Try native share API on mobile
    if (navigator.share) {
      try {
        await navigator.share({ title: `Ranking Arena Top 10 (${timeRange})`, text })
        return
      } catch {
        // Fallback to clipboard
      }
    }

    // Clipboard fallback
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Final fallback
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <button
      onClick={handleShare}
      disabled={disabled || traders.length === 0}
      title={language === 'zh' ? '分享 Top 10' : 'Share Top 10'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: tokens.typography.fontWeight.semibold,
        color: copied ? tokens.colors.accent.success : tokens.colors.text.secondary,
        background: tokens.glass.bg.light,
        border: `1px solid ${copied ? tokens.colors.accent.success : tokens.colors.border.primary}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: `all ${tokens.transition.fast}`,
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? (
        <>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {language === 'zh' ? '已复制' : 'Copied!'}
        </>
      ) : (
        <>
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="16,6 12,2 8,6" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="2" x2="12" y2="15" strokeLinecap="round" />
          </svg>
          Top 10
        </>
      )}
    </button>
  )
}
