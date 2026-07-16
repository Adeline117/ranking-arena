'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ButtonSpinner } from '../../ui/LoadingSpinner'
import { ARENA_PURPLE } from '@/lib/utils/content'
import { STICKERS } from '@/lib/stickers'
import { useCommentDraftPersistence } from '../hooks/useCommentDraftPersistence'

interface CommentInputProps {
  postId: string
  viewerKey: string
  submittingComment: boolean
  onSubmitComment: (postId: string, content: string) => Promise<boolean>
  language: string
  t: (key: string) => string
}

export function CommentInput({
  postId,
  viewerKey,
  submittingComment,
  onSubmitComment,
  language,
  t,
}: CommentInputProps): React.ReactNode {
  const {
    draft: newComment,
    setDraft: setNewComment,
    captureDraftSnapshot,
    clearDraftIfUnchanged,
  } = useCommentDraftPersistence(postId, viewerKey)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)

  const submitCurrentDraft = async () => {
    const content = newComment.trim()
    if (submittingComment || !content) return

    const draftSnapshot = captureDraftSnapshot(postId)
    if (await onSubmitComment(postId, content)) {
      clearDraftIfUnchanged(draftSnapshot)
    }
  }

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return
    let mounted = true
    const handler = () => setShowEmojiPicker(false)
    // Defer so the click that opened the picker doesn't immediately close it
    const timer = setTimeout(() => {
      if (mounted) document.addEventListener('click', handler)
    }, 0)
    return () => {
      mounted = false
      clearTimeout(timer)
      document.removeEventListener('click', handler)
    }
  }, [showEmojiPicker])

  return (
    <div style={{ marginBottom: 16, position: 'relative' }}>
      <div
        style={{
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.tertiary,
          padding: '10px 14px',
          // Reserve room for the toolbar row (36px buttons + 6px breathing space)
          paddingBottom: 48,
          transition: 'border-color 0.2s',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = ARENA_PURPLE
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = tokens.colors.border.primary
        }}
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
          enterKeyHint="send"
          placeholder={t('writeComment')}
          aria-label={t('writeComment')}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (submittingComment || !newComment.trim()) return
              void submitCurrentDraft()
            }
          }}
          className="comment-input-textarea"
          style={{
            width: '100%',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: tokens.colors.text.primary,
            // Desktop: 14px. Mobile override in globals.css bumps to 16px
            // to prevent iOS Safari auto-zoom on focus.
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
        <div
          style={{
            position: 'absolute',
            bottom: 6,
            left: 10,
            right: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {/* Left: action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {/* Sticker picker */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => {
                  setShowEmojiPicker((prev) => !prev)
                }}
                aria-label={t('postEmoji')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  // 36×36 touch target (was ~26×26). WCAG 2.2 minimum 24×24, AAA 44×44.
                  width: 36,
                  height: 36,
                  padding: 0,
                  borderRadius: tokens.radius.sm,
                  color: showEmojiPicker ? ARENA_PURPLE : tokens.colors.text.tertiary,
                  fontSize: 16,
                  lineHeight: 1.2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title={t('postEmoji')}
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
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </button>
              {showEmojiPicker && (
                <div
                  style={{
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
                  }}
                >
                  {STICKERS.map((sticker) => (
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
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = tokens.colors.bg.tertiary
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                      title={language === 'zh' ? sticker.name_zh : sticker.name_en}
                    >
                      <Image
                        src={sticker.path}
                        alt={sticker.name_en}
                        width={36}
                        height={36}
                        loading="lazy"
                        style={{ objectFit: 'contain' }}
                      />
                      <span
                        style={{ fontSize: 10, color: tokens.colors.text.tertiary, lineHeight: 1 }}
                      >
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
              aria-label={t('postMention')}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                // 36×36 touch target (was ~22×22). See sticker button above.
                width: 36,
                height: 36,
                padding: 0,
                borderRadius: tokens.radius.sm,
                color: tokens.colors.text.tertiary,
                fontSize: 14,
                fontWeight: 700,
                lineHeight: 1.2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              title={t('postMention')}
            >
              @
            </button>

            {/* Image attach intentionally omitted until upload is wired (was a
                file-picker that dead-ended in a "coming soon" toast). */}
          </div>

          {/* Right: character counter + send button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                color:
                  newComment.length > 1900
                    ? 'var(--color-accent-error)'
                    : tokens.colors.text.tertiary,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {newComment.length}/2000
            </span>
            <button
              onClick={submitCurrentDraft}
              disabled={submittingComment || !newComment.trim()}
              style={{
                // Match toolbar button height (36px) for consistent touch targets
                minHeight: 36,
                padding: '6px 14px',
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
    </div>
  )
}
