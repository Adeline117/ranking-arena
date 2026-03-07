'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { t as moduleT } from '@/lib/i18n'

interface EpubToolbarProps {
  ready: boolean
  progressPercent: number
  currentPage: number
  totalPages: number
  sessionElapsedSec: number
  showAudioReader: boolean
  themeIsDark: boolean
  panelBorder: string
  accent: string
  timeRemainingStr: string
  onToggleAudio: () => void
}

function formatDur(seconds: number): string {
  const sec = moduleT('durationSec')
  const min = moduleT('durationMin')
  const hour = moduleT('durationHour')
  const minSuffix = moduleT('durationMinSuffix')
  if (seconds < 60) return `${seconds}${sec}`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}${min}`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}${hour}${rm > 0 ? ` ${rm}${minSuffix}` : ''}`
}

/** Bottom progress bar with session timer and audio toggle */
export function EpubToolbar({
  ready,
  progressPercent,
  currentPage,
  totalPages,
  sessionElapsedSec,
  showAudioReader,
  themeIsDark,
  panelBorder,
  accent,
  timeRemainingStr,
  onToggleAudio,
}: EpubToolbarProps) {
  const { t } = useLanguage()
  if (!ready) return null

  const elapsed = sessionElapsedSec

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 16px',
      background: themeIsDark ? 'var(--color-blur-overlay)' : 'var(--glass-bg-heavy)',
      backdropFilter: tokens.glass.blur.sm, WebkitBackdropFilter: tokens.glass.blur.sm,
      borderTop: `1px solid ${panelBorder}`,
      fontSize: 11, color: themeIsDark ? 'var(--glass-border-heavy)' : 'var(--color-backdrop-light)',
      zIndex: 50,
    }}>
      <span>{progressPercent}% -- {currentPage}/{totalPages}</span>
      <span>
        {t('epubSessionLabel')}{formatDur(elapsed)}
      </span>
      <span>
        {t('epubRemainingLabel')}{timeRemainingStr}
      </span>
      <button
        onClick={onToggleAudio}
        style={{
          padding: '2px 10px', borderRadius: tokens.radius.sm, fontSize: 11,
          border: `1px solid ${panelBorder}`,
          background: showAudioReader ? accent : 'transparent',
          color: showAudioReader ? 'var(--color-on-accent)' : 'inherit',
          cursor: 'pointer', transition: 'all 0.15s',
        }}
      >
        {t('epubAudioModeLabel')}
      </button>
    </div>
  )
}
