'use client'

import { useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { ButtonSpinner } from '@/app/components/ui/LoadingSpinner'

interface EditPostModalProps {
  title: string
  content: string
  onTitleChange: (title: string) => void
  onContentChange: (content: string) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  t: (key: string) => string
}

export function EditPostModal({
  title,
  content,
  onTitleChange,
  onContentChange,
  onSave,
  onCancel,
  saving,
  t,
}: EditPostModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const timer = setTimeout(() => {
      if (dialogRef.current) {
        const firstInput = dialogRef.current.querySelector<HTMLElement>('input, textarea')
        firstInput?.focus()
      }
    }, 50)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [onCancel])

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-backdrop-medium)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: tokens.zIndex.modal,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('editPost') || 'Edit post'}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 500,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.xl,
          padding: 24,
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 20, color: tokens.colors.text.primary }}>
          {t('editPost')}
        </h2>

        <div style={{ marginBottom: 16 }}>
          <label htmlFor="edit-post-title" style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
            {t('title')}
          </label>
          <input
            id="edit-post-title"
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: 14,
              outline: 'none',
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label htmlFor="edit-post-content" style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
            {t('content')}
          </label>
          <textarea
            id="edit-post-content"
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            rows={8}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: 14,
              outline: 'none',
              resize: 'vertical',
              lineHeight: 1.6,
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              padding: '10px 20px',
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontWeight: 700,
              fontSize: 14,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {t('cancel')}
          </button>
          <button
            onClick={onSave}
            disabled={saving || !title.trim()}
            style={{
              padding: '10px 20px',
              borderRadius: tokens.radius.md,
              border: 'none',
              background: saving || !title.trim() ? 'var(--color-accent-primary-30)' : tokens.colors.accent.brand,
              color: tokens.colors.white,
              fontWeight: 900,
              fontSize: 14,
              cursor: saving || !title.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {saving && <ButtonSpinner size="xs" />}
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
