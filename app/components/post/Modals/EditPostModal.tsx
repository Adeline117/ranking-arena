'use client'

import { tokens } from '@/lib/design-tokens'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
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
  return (
    <ModalOverlay open onClose={onCancel} label={t('editPost')} maxWidth={500}>
      <div style={{ padding: 24 }}>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 900,
            marginBottom: 20,
            color: tokens.colors.text.primary,
          }}
        >
          {t('editPost')}
        </h2>

        <div style={{ marginBottom: 16 }}>
          <label
            htmlFor="edit-post-title"
            style={{
              display: 'block',
              marginBottom: 6,
              fontSize: 13,
              fontWeight: 800,
              color: tokens.colors.text.primary,
            }}
          >
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
          <label
            htmlFor="edit-post-content"
            style={{
              display: 'block',
              marginBottom: 6,
              fontSize: 13,
              fontWeight: 800,
              color: tokens.colors.text.primary,
            }}
          >
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
              background:
                saving || !title.trim()
                  ? 'var(--color-accent-primary-30)'
                  : tokens.colors.accent.brand,
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
    </ModalOverlay>
  )
}
