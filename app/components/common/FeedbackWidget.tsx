'use client'

import { useState, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const { t } = useLanguage()
  const { showToast } = useToast()

  const handleSubmit = async () => {
    if (!message.trim() || submitting) return
    setSubmitting(true)

    try {
      const body: Record<string, string> = {
        message: message.trim(),
        page_url: window.location.href,
        user_agent: navigator.userAgent,
      }

      const file = fileRef.current?.files?.[0]
      if (file && file.size < 5 * 1024 * 1024) {
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onloadend = () => resolve(reader.result as string)
          reader.readAsDataURL(file)
        })
        body.screenshot = base64
      }

      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        showToast(t('feedbackSuccess'), 'success')
        setMessage('')
        setOpen(false)
        if (fileRef.current) fileRef.current.value = ''
      } else {
        showToast(t('feedbackError'), 'error')
      }
    } catch {
      showToast(t('feedbackError'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Feedback"
        style={{
          position: 'fixed',
          bottom: 'calc(var(--mobile-nav-height, 60px) + 16px)',
          right: 16,
          width: 44,
          height: 44,
          borderRadius: tokens.radius.full,
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-primary)',
          boxShadow: '0 4px 16px var(--color-overlay-light)',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          zIndex: tokens.zIndex.dropdown,
          transition: `all ${tokens.transition.base}`,
          color: 'var(--color-text-tertiary)',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'fixed',
            bottom: 'calc(var(--mobile-nav-height, 60px) + 72px)',
            right: 16,
            width: 'min(320px, calc(100vw - 32px))',
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.xl,
            boxShadow: '0 12px 40px var(--color-overlay-dark)',
            padding: tokens.spacing[5],
            zIndex: tokens.zIndex.max,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[3],
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-primary)' }}>
              {t('feedbackTitle')}
            </span>
            <button
              onClick={() => setOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 8, minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('feedbackPlaceholder')}
            maxLength={5000}
            rows={4}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.sm,
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: tokens.typography.fontSize.xs,
              color: 'var(--color-text-tertiary)',
              cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            {t('feedbackScreenshot')}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} />
          </label>

          <button
            onClick={handleSubmit}
            disabled={!message.trim() || submitting}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: 'none',
              background: !message.trim() || submitting
                ? 'var(--color-accent-primary-20)'
                : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
              color: tokens.colors.white,
              fontWeight: 700,
              fontSize: tokens.typography.fontSize.sm,
              cursor: !message.trim() || submitting ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? t('feedbackSubmitting') : t('feedbackSubmit')}
          </button>
        </div>
      )}
    </>
  )
}
