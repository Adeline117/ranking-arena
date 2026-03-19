'use client'

import { useState, useEffect } from 'react'
import { useLanguage } from '../Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

const MESSAGES: Record<string, string> = {
  en: 'Arena is in closed beta — data is being updated and some features are under development.',
  zh: 'Arena 处于内测阶段，数据正在更新中，部分功能仍在开发。',
  ko: 'Arena는 비공개 베타 단계입니다. 데이터가 업데이트 중이며 일부 기능은 개발 중입니다.',
  ja: 'Arena はクローズドベータ版です。データ更新中で、一部機能は開発中です。',
}

const DISMISS_KEY = 'beta-banner-dismissed-at'
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

export default function BetaBanner() {
  const { language } = useLanguage()
  const [dismissed, setDismissed] = useState(true) // default hidden to avoid flash

  useEffect(() => {
    try {
      const dismissedAt = localStorage.getItem(DISMISS_KEY)
      if (dismissedAt) {
        const elapsed = Date.now() - Number(dismissedAt)
        if (elapsed < DISMISS_DURATION_MS) {
          setDismissed(true)
          return
        }
        // Expired — clear and show
        localStorage.removeItem(DISMISS_KEY)
      }
      setDismissed(false)
    } catch {
      setDismissed(false)
    }
  }, [])

  if (process.env.NEXT_PUBLIC_SHOW_BETA_BANNER === 'false') return null
  if (dismissed) return null

  const message = MESSAGES[language] || MESSAGES.en

  return (
    <div
      style={{
        background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
        color: 'white',
        textAlign: 'center',
        padding: '8px 40px 8px 16px',
        fontSize: '14px',
        fontWeight: 600,
        // Use fixed positioning so this banner never causes layout shift.
        // It overlays content without pushing other elements down.
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: tokens.zIndex.max,
      }}
    >
      🚧 {message}
      <button
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, String(Date.now()))
          } catch { /* localStorage unavailable */ }
          setDismissed(true)
        }}
        aria-label="Dismiss"
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          color: 'white',
          fontSize: '18px',
          cursor: 'pointer',
          padding: '4px 8px',
          lineHeight: 1,
          opacity: 0.8,
        }}
      >
        ✕
      </button>
    </div>
  )
}
