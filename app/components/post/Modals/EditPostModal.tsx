'use client'

import { tokens } from '@/lib/design-tokens'

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
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: tokens.zIndex.modal,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 500,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
          padding: 24,
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 20, color: tokens.colors.text.primary }}>
          {t('editPost')}
        </h2>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
            {t('title')}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 12,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: 14,
              outline: 'none',
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
            {t('content')}
          </label>
          <textarea
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            rows={8}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 12,
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
              borderRadius: 10,
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
              borderRadius: 10,
              border: 'none',
              background: saving || !title.trim() ? 'rgba(139,111,168,0.3)' : tokens.colors.accent.brand,
              color: '#fff',
              fontWeight: 900,
              fontSize: 14,
              cursor: saving || !title.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
