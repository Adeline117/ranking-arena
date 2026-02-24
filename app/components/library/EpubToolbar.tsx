'use client'

import { tokens } from '@/lib/design-tokens'

interface EpubToolbarProps {
  ready: boolean
  progressPercent: number
  currentPage: number
  totalPages: number
  sessionElapsedSec: number
  isZh: boolean
  showAudioReader: boolean
  themeIsDark: boolean
  panelBorder: string
  accent: string
  timeRemainingStr: string
  onToggleAudio: () => void
}

/** Bottom progress bar with session timer and audio toggle */
export function EpubToolbar({
  ready,
  progressPercent,
  currentPage,
  totalPages,
  sessionElapsedSec,
  isZh,
  showAudioReader,
  themeIsDark,
  panelBorder,
  accent,
  timeRemainingStr,
  onToggleAudio,
}: EpubToolbarProps) {
  if (!ready) return null

  const elapsed = sessionElapsedSec
  const formatDur = (seconds: number) => {
    if (seconds < 60) return isZh ? `${seconds}秒` : `${seconds}s`
    const m = Math.floor(seconds / 60)
    if (m < 60) return isZh ? `${m}分钟` : `${m}min`
    const h = Math.floor(m / 60)
    const rm = m % 60
    return isZh ? `${h}小时${rm > 0 ? rm + '分钟' : ''}` : `${h}h ${rm > 0 ? rm + 'm' : ''}`
  }

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 16px',
      background: themeIsDark ? 'var(--color-blur-overlay)' : 'var(--glass-bg-heavy)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      borderTop: `1px solid ${panelBorder}`,
      fontSize: 11, color: themeIsDark ? 'var(--glass-border-heavy)' : 'var(--color-backdrop-light)',
      zIndex: 50,
    }}>
      <span>{progressPercent}% -- {currentPage}/{totalPages}</span>
      <span>
        {isZh ? '本次阅读 ' : 'Session: '}{formatDur(elapsed)}
      </span>
      <span>
        {isZh ? '预计剩余 ' : 'Remaining: '}{timeRemainingStr}
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
        {isZh ? '朗读模式' : 'Audio'}
      </button>
    </div>
  )
}
