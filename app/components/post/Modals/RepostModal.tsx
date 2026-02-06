'use client'

import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'

interface RepostModalProps {
  postId: string
  comment: string
  onCommentChange: (comment: string) => void
  onRepost: (postId: string, comment: string) => void
  onCancel: () => void
  loading: boolean
  t: (key: string) => string
}

export function RepostModal({
  postId,
  comment,
  onCommentChange,
  onRepost,
  onCancel,
  loading,
  t,
}: RepostModalProps) {
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      onClick={() => {
        onCancel()
      }}
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
          maxWidth: 400,
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 16, color: tokens.colors.text.primary }}>
          {t('repostToFeed')}
        </h2>

        <textarea
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          placeholder={t('addCommentOptional')}
          style={{
            width: '100%',
            minHeight: 80,
            padding: 12,
            borderRadius: 12,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: 14,
            resize: 'vertical',
            marginBottom: 16,
            outline: 'none',
          }}
          maxLength={280}
        />

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 20px',
              borderRadius: 10,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontWeight: 700,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            {t('cancel')}
          </button>
          <button
            onClick={() => onRepost(postId, comment)}
            disabled={loading}
            style={{
              padding: '10px 20px',
              borderRadius: 10,
              border: 'none',
              background: loading ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
              color: '#fff',
              fontWeight: 900,
              fontSize: 14,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? t('reposting') : t('repost')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
