'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

type ExportFormat = 'csv' | 'json' | 'pdf'

interface ExportButtonProps {
  onExport: (format: ExportFormat) => Promise<void> | void
  /** Hide PDF option (e.g. when there's no visual element to capture) */
  hidePDF?: boolean
  size?: 'sm' | 'md'
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export default function ExportButton({ onExport, hidePDF, size = 'sm' }: ExportButtonProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<ExportFormat | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
  }, [])

  useEffect(() => {
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, handleClickOutside])

  const handleExport = async (format: ExportFormat) => {
    setLoading(format)
    try {
      await onExport(format)
      showToast(t('exportSuccess') || '导出成功', 'success')
    } catch {
      showToast(t('errorOccurred') || '出错了', 'error')
    } finally {
      setLoading(null)
      setOpen(false)
    }
  }

  const pad = size === 'sm' ? '6px 10px' : '8px 14px'
  const fontSize = size === 'sm' ? '12px' : '13px'

  const options: { format: ExportFormat; label: string }[] = [
    { format: 'csv', label: t('exportCSV') || '导出 CSV' },
    { format: 'json', label: t('exportJSON') || '导出 JSON' },
    ...(!hidePDF ? [{ format: 'pdf' as ExportFormat, label: t('exportPDF') || '导出 PDF' }] : []),
  ]

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          padding: pad, fontSize,
          background: tokens.colors.bg.secondary,
          color: tokens.colors.text.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md,
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
        onMouseEnter={e => { (e.target as HTMLElement).style.color = tokens.colors.text.primary }}
        onMouseLeave={e => { (e.target as HTMLElement).style.color = tokens.colors.text.secondary }}
      >
        <DownloadIcon />
        <span>{t('export') || '导出'}</span>
      </button>
      {open && (
        <div className="dropdown-enter" style={{
          position: 'absolute', top: '100%', right: 0, marginTop: '4px',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md,
          padding: '4px',
          zIndex: tokens.zIndex.dropdown,
          minWidth: '140px',
          boxShadow: 'var(--shadow-md-dark)',
        }}>
          {options.map(({ format, label }) => (
            <button
              key={format}
              onClick={() => handleExport(format)}
              disabled={loading !== null}
              style={{
                display: 'block', width: '100%',
                padding: '8px 12px', fontSize: '13px',
                background: 'transparent',
                color: loading === format ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                border: 'none', borderRadius: tokens.radius.sm,
                cursor: loading !== null ? 'wait' : 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)' }}
              onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent' }}
            >
              {loading === format ? (t('preparing') || '准备中...') : label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
