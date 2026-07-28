'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { isFeedbackSuppressedRoute, isFloatingActionRoute } from '@/lib/features'
import {
  announceBottomOverlayOpen,
  subscribeToBottomOverlayOpen,
} from '@/lib/ui/bottomOverlayCoordinator'

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)
  const restoreLauncherOnCloseRef = useRef(false)
  const { t } = useLanguage()
  const { showToast } = useToast()
  const pathname = usePathname()

  // Pages where the create-post FAB + ScrollToTop stack in the same bottom-right
  // corner. Without offsetting, this feedback button sits directly under the FAB
  // (both anchored ~16-20px from the bottom) and gets covered (U9-5). Same
  // fabPages detection as ScrollToTop. Stack this ABOVE the reserved ScrollToTop
  // slot so all three widgets are legible regardless of scroll state.
  const hasFab = isFloatingActionRoute(pathname)
  const suppressed = isFeedbackSuppressedRoute(pathname)

  useEffect(
    () =>
      subscribeToBottomOverlayOpen((owner) => {
        if (owner === 'feedback') return
        restoreLauncherOnCloseRef.current = false
        setOpen(false)
      }),
    []
  )

  useEffect(() => {
    if (!suppressed) return
    restoreLauncherOnCloseRef.current = false
    setOpen(false)
  }, [suppressed])

  useEffect(() => {
    if (!open) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      restoreLauncherOnCloseRef.current = true
      setOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open])

  // An expanded feedback form cannot coexist with the complete bottom-right
  // stack on a 320x568 viewport. Make that mutual exclusion explicit before
  // paint and keep the page-owned Save/Cookie controls visible. Restore focus
  // only for a close initiated inside this overlay; another overlay owns focus
  // after coordinator-driven closure.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (!open) {
      if (wasOpenRef.current && restoreLauncherOnCloseRef.current) {
        launcherRef.current?.focus({ preventScroll: true })
      }
      wasOpenRef.current = false
      restoreLauncherOnCloseRef.current = false
      return
    }

    wasOpenRef.current = true
    restoreLauncherOnCloseRef.current = false
    root.classList.add('has-feedback-panel')
    closeRef.current?.focus({ preventScroll: true })
    return () => root.classList.remove('has-feedback-panel')
  }, [open])

  if (suppressed) return null

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
        restoreLauncherOnCloseRef.current = false
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
        ref={launcherRef}
        className="feedback-launch-button"
        onClick={() => {
          if (open) {
            restoreLauncherOnCloseRef.current = false
            setOpen(false)
            return
          }
          restoreLauncherOnCloseRef.current = false
          announceBottomOverlayOpen('feedback')
          setOpen(true)
        }}
        aria-label="Feedback"
        aria-expanded={open}
        style={{
          position: 'fixed',
          // +var(--transient-bottom-bar): lift clear of the cookie / guest-signup
          // bar when one is showing, instead of hiding behind it (z300 > this z100).
          bottom: hasFab
            ? 'calc(var(--mobile-nav-height, 60px) + var(--safe-area-inset-bottom, 0px) + 152px + var(--transient-bottom-bar, 0px) + var(--page-bottom-overlay-offset, 0px))'
            : 'calc(var(--mobile-nav-height, 60px) + var(--safe-area-inset-bottom, 0px) + 72px + var(--transient-bottom-bar, 0px) + var(--page-bottom-overlay-offset, 0px))',
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
          transition: `color ${tokens.transition.base}, background ${tokens.transition.base}, border-color ${tokens.transition.base}, box-shadow ${tokens.transition.base}`,
          color: 'var(--color-text-tertiary)',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div
          className="feedback-panel"
          role="dialog"
          aria-labelledby="feedback-panel-title"
          style={{
            position: 'fixed',
            bottom:
              'calc(var(--mobile-nav-height, 60px) + var(--safe-area-inset-bottom, 0px) + var(--transient-bottom-bar, 0px) + var(--page-bottom-overlay-offset, 0px) + 16px)',
            right: 'max(16px, var(--safe-area-inset-right, 0px))',
            width:
              'min(320px, calc(100vw - 32px - var(--safe-area-inset-left, 0px) - var(--safe-area-inset-right, 0px)))',
            maxHeight:
              'calc(100dvh - var(--safe-area-inset-top, 0px) - var(--mobile-nav-height, 60px) - var(--safe-area-inset-bottom, 0px) - var(--transient-bottom-bar, 0px) - var(--page-bottom-overlay-offset, 0px) - 32px)',
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.xl,
            boxShadow: '0 12px 40px var(--color-overlay-dark)',
            boxSizing: 'border-box',
            padding: tokens.spacing[4],
            zIndex: tokens.zIndex.max,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[3],
            overflow: 'hidden',
          }}
        >
          <div
            className="feedback-panel-header"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <span
              id="feedback-panel-title"
              style={{
                fontWeight: 700,
                fontSize: tokens.typography.fontSize.sm,
                color: 'var(--color-text-primary)',
              }}
            >
              {t('feedbackTitle')}
            </span>
            <button
              ref={closeRef}
              type="button"
              className="feedback-panel-close"
              aria-label={t('close')}
              onClick={() => {
                restoreLauncherOnCloseRef.current = true
                setOpen(false)
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-tertiary)',
                padding: 8,
                minWidth: 44,
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div
            className="feedback-panel-body"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing[3],
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }}
          >
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('feedbackPlaceholder')}
              maxLength={5000}
              rows={4}
              style={{
                width: '100%',
                minHeight: 88,
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-bg-tertiary)',
                color: 'var(--color-text-primary)',
                fontSize: tokens.typography.fontSize.sm,
                resize: 'none',
                outline: 'none',
                fontFamily: 'inherit',
                flexShrink: 0,
              }}
            />

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 44,
                fontSize: tokens.typography.fontSize.xs,
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              {t('feedbackScreenshot')}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} />
            </label>
          </div>

          <div
            className="feedback-panel-footer"
            style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}
          >
            <button
              type="button"
              className="feedback-panel-submit"
              onClick={handleSubmit}
              disabled={!message.trim() || submitting}
              style={{
                minHeight: 44,
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background:
                  !message.trim() || submitting
                    ? 'var(--color-accent-primary-20)'
                    : 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
                color: tokens.colors.white,
                fontWeight: 700,
                fontSize: tokens.typography.fontSize.sm,
                cursor: !message.trim() || submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? `⏳ ${t('feedbackSubmitting')}` : t('feedbackSubmit')}
            </button>
            {!message.trim() && !submitting && (
              <div
                className="feedback-panel-required"
                style={{ fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'center' }}
              >
                {t('feedbackRequired')}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
