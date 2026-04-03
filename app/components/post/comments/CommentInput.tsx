'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ButtonSpinner } from '../../ui/LoadingSpinner'
import { ARENA_PURPLE } from '@/lib/utils/content'
import { useToast } from '../../ui/Toast'
import { STICKERS } from '@/lib/stickers'

interface CommentInputProps {
  postId: string
  newComment: string
  setNewComment: (val: string) => void
  submittingComment: boolean
  onSubmitComment: (postId: string) => void
  language: string
  t: (key: string) => string
}

export function CommentInput({
  postId,
  newComment,
  setNewComment,
  submittingComment,
  onSubmitComment,
  language,
  t,
}: CommentInputProps): React.ReactNode {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const { showToast } = useToast()
  const commentInputRef = useRef<HTMLTextAreaElement>(null)

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return
    let mounted = true
    const handler = () => setShowEmojiPicker(false)
    // Defer so the click that opened the picker doesn't immediately close it
    const timer = setTimeout(() => {
      if (mounted) document.addEventListener('click', handler)
    }, 0)
    return () => { mounted = false; clearTimeout(timer); document.removeEventListener('click', handler) }
  }, [showEmojiPicker])

  return (
    <div style={{ marginBottom: 16, position: 'relative' }}>
      <div
        style={{
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.tertiary,
          padding: '10px 14px',
          paddingBottom: 38,
          transition: 'border-color 0.2s',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = ARENA_PURPLE }}
        onBlur={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary }}
      >
        <textarea
          ref={commentInputRef}
          value={newComment}
          maxLength={2000}
          onChange={(e) => {
            setNewComment(e.target.value)
            // Auto-expand
            const ta = e.target
            ta.style.height = 'auto'
            ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
          }}
          placeholder={t('writeComment')}
          aria-label={t('writeComment')}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (submittingComment || !newComment.trim()) return
              onSubmitComment(postId)
            }
          }}
          style={{
            width: '100%',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: tokens.colors.text.primary,
            fontSize: 14,
            resize: 'none',
            outline: 'none',
            minHeight: 22,
            maxHeight: 160,
            lineHeight: '22px',
            fontFamily: 'inherit',
            overflow: 'hidden',
          }}
        />

        {/* Toolbar row - bottom of input box */}
        <div style={{
          position: 'absolute',
          bottom: 6,
          left: 10,
          right: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          {/* Left: action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {/* Sticker picker */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => { setShowEmojiPicker(prev => !prev) }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: tokens.radius.sm,
                  color: showEmojiPicker ? ARENA_PURPLE : tokens.colors.text.tertiary,
                  fontSize: 16,
                  lineHeight: 1.2,
                  display: 'flex',
                  alignItems: 'center',
                }}
                title={t('postEmoji')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </button>
              {showEmojiPicker && (
                <div style={{
                  position: 'fixed',
                  bottom: 80,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.lg,
                  padding: 8,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(5, 1fr)',
                  gap: 4,
                  zIndex: tokens.zIndex.max,
                  boxShadow: 'var(--shadow-lg-dark)',
                  width: 'min(300px, calc(100vw - 32px))',
                  maxHeight: 280,
                  overflowY: 'auto',
                }}>
                  {STICKERS.map(sticker => (
                    <button
                      key={sticker.id}
                      onClick={() => {
                        setNewComment(newComment + `[sticker:${sticker.id}]`)
                        setShowEmojiPicker(false)
                        commentInputRef.current?.focus()
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 4,
                        borderRadius: tokens.radius.sm,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      title={language === 'zh' ? sticker.name_zh : sticker.name_en}
                    >
                      <Image src={sticker.path} alt={sticker.name_en} width={36} height={36} loading="lazy" style={{ objectFit: 'contain' }} />
                      <span style={{ fontSize: 10, color: tokens.colors.text.tertiary, lineHeight: 1 }}>
                        {language === 'zh' ? sticker.name_zh : sticker.name_en}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* @ mention */}
            <button
              type="button"
              onClick={() => {
                setNewComment(newComment + '@')
                commentInputRef.current?.focus()
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
              title={t('postMention')}
            >
              @
            </button>

            {/* Image (placeholder for future) */}
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/*'
                  input.onchange = () => {
                    // Future: upload and attach image
                    showToast(t('commentImageComingSoon'), 'warning')
                  }
                  input.click()
                }
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: tokens.radius.sm,
                color: tokens.colors.text.tertiary,
                fontSize: 16,
                lineHeight: 1.2,
                display: 'flex',
                alignItems: 'center',
              }}
              title={t('postImage')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </button>
          </div>

          {/* Right: send button */}
          <button
            onClick={() => onSubmitComment(postId)}
            disabled={submittingComment || !newComment.trim()}
            style={{
              padding: '4px 12px',
              borderRadius: tokens.radius.md,
              border: 'none',
              background: newComment.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
              color: tokens.colors.white,
              fontSize: 13,
              fontWeight: 700,
              cursor: submittingComment || !newComment.trim() ? 'default' : 'pointer',
              opacity: submittingComment ? 0.6 : 1,
              transition: 'all 0.2s',
              lineHeight: '22px',
            }}
          >
            {submittingComment ? <ButtonSpinner size="xs" /> : t('send')}
          </button>
        </div>
      </div>
    </div>
  )
}
