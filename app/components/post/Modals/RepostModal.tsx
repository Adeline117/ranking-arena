'use client'

import { useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'
import { DynamicStickerPicker } from '../../ui/Dynamic'
import ModalOverlay from '../../ui/ModalOverlay'
import type { Sticker } from '@/lib/stickers'

interface RepostModalProps {
  postId: string
  onRepost: (postId: string, comment: string) => Promise<boolean>
  onCancel: () => void
  loading: boolean
  t: (key: string) => string
}

export function RepostModal({ postId, onRepost, onCancel, loading, t }: RepostModalProps) {
  const { t: tLocal } = useLanguage()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [comment, setComment] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showStickerPicker, setShowStickerPicker] = useState(false)

  const handleCancel = () => {
    setComment('')
    onCancel()
  }

  const handleRepost = async () => {
    if (await onRepost(postId, comment)) handleCancel()
  }

  const insertText = (text: string) => {
    const textarea = textareaRef.current
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = comment.slice(0, start) + text + comment.slice(end)
      if (newValue.length <= 280) {
        setComment(newValue)
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + text.length
          textarea.focus()
        })
      }
    } else {
      const newValue = comment + text
      if (newValue.length <= 280) {
        setComment(newValue)
      }
    }
  }

  return (
    <ModalOverlay open onClose={handleCancel} label={t('repost')} maxWidth={400} portal>
      <div
        style={{
          padding: 24,
        }}
      >
        <h2
          style={{
            fontSize: 18,
            fontWeight: 900,
            marginBottom: 16,
            color: tokens.colors.text.primary,
          }}
        >
          {t('repostToFeed')}
        </h2>

        <textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t('addCommentOptional')}
          aria-label={t('addCommentOptional')}
          style={{
            width: '100%',
            minHeight: 80,
            padding: 12,
            borderRadius: tokens.radius.lg,
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 4,
            marginBottom: 16,
          }}
        >
          {/* Sticker picker */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => {
                setShowStickerPicker((prev) => !prev)
                setShowEmojiPicker(false)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: tokens.radius.sm,
                color: tokens.colors.text.tertiary,
                display: 'flex',
                alignItems: 'center',
              }}
              aria-label={tLocal('postSticker')}
              title={tLocal('postSticker')}
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
                aria-hidden="true"
              >
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
              onClick={() => {
                setShowEmojiPicker((prev) => !prev)
                setShowStickerPicker(false)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: tokens.radius.sm,
                color: tokens.colors.text.tertiary,
                fontSize: 18,
                lineHeight: 1.2,
                display: 'flex',
                alignItems: 'center',
              }}
              aria-label={tLocal('postEmoji')}
              title={tLocal('postEmoji')}
            >
              :)
            </button>
            {showEmojiPicker && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 32,
                  left: 0,
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.lg,
                  padding: 8,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(8, 1fr)',
                  gap: 2,
                  zIndex: tokens.zIndex.dropdown,
                  boxShadow: tokens.shadow.lg,
                  width: 280,
                }}
              >
                {[
                  ':)',
                  ':D',
                  'XD',
                  '<3',
                  ';)',
                  ':P',
                  'B)',
                  ':/',
                  '+1',
                  '-1',
                  'hot',
                  '100',
                  'go',
                  '$',
                  'up',
                  'dn',
                  'bull',
                  'bear',
                  'gem',
                  'hi',
                  '!?',
                  '$$',
                  'strong',
                  'luv',
                  'eye',
                  'aim',
                  'zap',
                  'moon',
                  'sun',
                  'deal',
                  'yay',
                  'rip',
                ].map((emoji) => (
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
                      borderRadius: tokens.radius.sm,
                      lineHeight: 1.2,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.tertiary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
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
              borderRadius: tokens.radius.sm,
              color: tokens.colors.text.tertiary,
              fontSize: 14,
              fontWeight: 700,
              lineHeight: 1.2,
            }}
            aria-label={tLocal('postMention')}
            title={tLocal('postMention')}
          >
            @
          </button>

          {/* Character count */}
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              color:
                comment.length > 260 ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
            }}
          >
            {comment.length}/280
          </span>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={handleCancel}
            style={{
              padding: '10px 20px',
              borderRadius: tokens.radius.md,
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
            onClick={handleRepost}
            disabled={loading}
            style={{
              padding: '10px 20px',
              borderRadius: tokens.radius.md,
              border: 'none',
              background: loading ? 'var(--color-accent-primary-30)' : tokens.colors.accent.brand,
              color: tokens.colors.white,
              fontWeight: 900,
              fontSize: 14,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? t('reposting') : t('repost')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
