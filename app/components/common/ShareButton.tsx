'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

export type ShareContentType = 'trader' | 'post' | 'library'

interface ShareData {
  type: ShareContentType
  url: string
  // Trader
  traderName?: string
  period?: string
  roi?: number
  // Post
  title?: string
  // Library
  author?: string
}

function buildShareText(data: ShareData, t: (key: string) => string): string {
  switch (data.type) {
    case 'trader': {
      const name = data.traderName || ''
      const period = data.period || '90D'
      const roi = data.roi != null ? data.roi.toFixed(1) : '0'
      return t('shareTraderText')
        .replace('{name}', name)
        .replace('{period}', period)
        .replace('{roi}', roi)
        .replace('{url}', data.url)
    }
    case 'post': {
      const title = data.title || ''
      return t('sharePostText')
        .replace('{title}', title)
        .replace('{url}', data.url)
    }
    case 'library': {
      const title = data.title || ''
      const author = data.author || ''
      return t('shareLibraryText')
        .replace('{title}', title)
        .replace('{author}', author)
        .replace('{url}', data.url)
    }
    default:
      return data.url
  }
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  )
}

interface ShareButtonProps {
  data: ShareData
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'outline'
  showLabel?: boolean
}

export default function ShareButton({ data, size = 'sm', variant = 'ghost', showLabel = true }: ShareButtonProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()
  const { showToast } = useToast()

  const text = buildShareText(data, t)

  const handleNativeShare = useCallback(async () => {
    try {
      await navigator.share({ text, url: data.url })
    } catch {
      // Intentionally swallowed: user cancelled share dialog or Web Share API unavailable
    }
  }, [text, data.url])

  const handleClick = useCallback(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && /Mobi|Android/i.test(navigator.userAgent)) {
      handleNativeShare()
    } else {
      setOpen(prev => !prev)
    }
  }, [handleNativeShare])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(data.url)
      showToast(t('linkCopied'), 'success', 2000)
    } catch {
      showToast(t('copyFailed'), 'error', 2000)
    }
    setOpen(false)
  }, [data.url, showToast, t])

  const openPopup = useCallback((url: string) => {
    const popup = window.open(url, '_blank', 'noopener')
    if (!popup) showToast(t('popupBlocked') || 'Popup blocked. Please allow popups for this site.', 'warning')
    setOpen(false)
  }, [showToast, t])

  const shareToTwitter = useCallback(() => {
    openPopup(`https://x.com/intent/post?text=${encodeURIComponent(text)}`)
  }, [text, openPopup])

  const shareToTelegram = useCallback(() => {
    openPopup(`https://t.me/share/url?url=${encodeURIComponent(data.url)}&text=${encodeURIComponent(text)}`)
  }, [text, data.url, openPopup])

  const shareToWhatsApp = useCallback(() => {
    openPopup(`https://wa.me/?text=${encodeURIComponent(text)}`)
  }, [text, openPopup])

  const pad = size === 'sm' ? `${tokens.spacing[2]} ${tokens.spacing[3]}` : `${tokens.spacing[2]} ${tokens.spacing[4]}`
  const fontSize = size === 'sm' ? tokens.typography.fontSize.sm : tokens.typography.fontSize.base
  const bg = variant === 'ghost' ? tokens.colors.bg.tertiary : 'transparent'
  const border = variant === 'ghost' ? `1px solid ${tokens.colors.border.primary}` : `1px solid ${tokens.colors.border.primary}`

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={handleClick}
        style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
          padding: pad, fontSize, borderRadius: tokens.radius.lg,
          background: bg, border, color: tokens.colors.text.tertiary,
          cursor: 'pointer', transition: `all ${tokens.transition.base}`,
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = tokens.colors.bg.secondary
          e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}40`
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = bg
          e.currentTarget.style.borderColor = tokens.colors.border.primary
        }}
      >
        <ShareIcon />
        {showLabel ? t('share') : <span className="sr-only">{t('share')}</span>}
      </button>

      {open && (
        <div
          role="menu"
          onKeyDown={(e) => {
            // #26: Keyboard navigation for share dropdown
            const items = e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
            const active = document.activeElement as HTMLElement
            const idx = Array.from(items).indexOf(active as HTMLButtonElement)
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              const next = idx < items.length - 1 ? idx + 1 : 0
              items[next]?.focus()
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              const prev = idx > 0 ? idx - 1 : items.length - 1
              items[prev]?.focus()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            }
          }}
          style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6,
          minWidth: 180, padding: `${tokens.spacing[2]} 0`,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.lg,
          boxShadow: tokens.shadow.lg,
          zIndex: tokens.zIndex.dropdown,
          animation: 'shareDropdownIn 0.15s ease-out',
        }}>
          <DropdownItem label={t('shareToTwitter')} onClick={shareToTwitter} icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          } />
          <DropdownItem label={t('shareToTelegram')} onClick={shareToTelegram} icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0h-.056zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
          } />
          <DropdownItem label={t('shareToWhatsApp')} onClick={shareToWhatsApp} icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>
          } />
          <div style={{ height: 1, background: tokens.colors.border.primary, margin: `${tokens.spacing[1]} 0` }} />
          <DropdownItem label={t('copyLink')} onClick={copyLink} icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          } />
        </div>
      )}
    </div>
  )
}

function DropdownItem({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
        background: 'transparent', border: 'none',
        color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.sm,
        cursor: 'pointer', textAlign: 'left',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      onFocus={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary; e.currentTarget.style.outline = `2px solid ${tokens.colors.accent.brand}`; e.currentTarget.style.outlineOffset = '-2px' }}
      onBlur={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.outline = 'none' }}
    >
      <span style={{ color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center' }}>{icon}</span>
      {label}
    </button>
  )
}
