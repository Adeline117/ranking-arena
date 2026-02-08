'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'
import { DynamicStickerPicker } from '../../ui/Dynamic'
import type { Sticker } from '@/lib/stickers'

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
  const { language } = useLanguage()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showStickerPicker, setShowStickerPicker] = useState(false)

  if (typeof document === 'undefined') return null

  const insertText = (text: string) => {
    const textarea = textareaRef.current
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = comment.slice(0, start) + text + comment.slice(end)
      if (newValue.length <= 280) {
        onCommentChange(newValue)
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + text.length
          textarea.focus()
        })
      }
    } else {
      const newValue = comment + text
      if (newValue.length <= 280) {
        onCommentChange(newValue)
      }
    }
  }

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
          ref={textareaRef}
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
            outline: 'none',
          }}
          maxLength={280}
        />

        {/* Toolbar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 4,
          marginBottom: 16,
        }}>
          {/* Sticker picker */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => { setShowStickerPicker(prev => !prev); setShowEmojiPicker(false) }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                color: tokens.colors.text.tertiary,
                display: 'flex',
                alignItems: 'center',
              }}
              title={language === 'zh' ? '贴纸' : 'Sticker'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
                <path d="M14 3v4a2 2 0 0 0 2 2h4" />
                <circle cx="10" cy="13" r="2" />
                <path d="m20 17-1.09-1.09a2 2 0 0 0-2.82 0L10 22" />
              </svg>
            </button>
            <DynamicStickerPicker
              isOpen={showStickerPicker}
              onClose={() => setShowStickerPicker(false)}
              onSelect={(sticker: Sticker) => {
                insertText(`[sticker:${sticker.id}]`)
                setShowStickerPicker(false)
              }}
            />
          </div>

          {/* Emoji picker */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => { setShowEmojiPicker(prev => !prev); setShowStickerPicker(false) }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 6,
                color: tokens.colors.text.tertiary,
                fontSize: 18,
                lineHeight: 1,
                display: 'flex',
                alignItems: 'center',
              }}
              title={language === 'zh' ? '表情' : 'Emoji'}
            >
              :)
            </button>
            {showEmojiPicker && (
              <div style={{
                position: 'absolute',
                bottom: 32,
                left: 0,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: 12,
                padding: 8,
                display: 'grid',
                gridTemplateColumns: 'repeat(8, 1fr)',
                gap: 2,
                zIndex: 100,
                boxShadow: tokens.shadow.lg,
                width: 280,
              }}>
                {[':)',':D','XD','<3',';)',':P','B)',':/',
                  '+1','-1','hot','100','go','$','up','dn',
                  'bull','bear','gem','hi','!?','$$','strong','luv',
                  'eye','aim','zap','moon','sun','deal','yay','rip'].map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => {
                      insertText(emoji)
                      setShowEmojiPicker(false)
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      fontSize: 13,
                      cursor: 'pointer',
                      padding: 4,
                      borderRadius: 4,
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* @ mention */}
          <button
            type="button"
            onClick={() => {
              insertText('@')
            }}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 6,
              color: tokens.colors.text.tertiary,
              fontSize: 14,
              fontWeight: 700,
              lineHeight: 1,
            }}
            title={language === 'zh' ? '@提及用户' : '@Mention'}
          >
            @
          </button>

          {/* Character count */}
          <span style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: comment.length > 260 ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
          }}>
            {comment.length}/280
          </span>
        </div>

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
              background: loading ? 'rgba(139,111,168,0.3)' : tokens.colors.accent.brand,
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
