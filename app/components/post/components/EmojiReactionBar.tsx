'use client'

/**
 * Emoji Reaction Bar (Rocket.Chat/Misskey pattern)
 * Shows aggregated emoji pills below post content.
 * Click existing pill to toggle your reaction, "+" opens picker.
 */

import { useState, useCallback, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { useLoginModal } from '@/lib/hooks/useLoginModal'

const EMOJI_OPTIONS = ['👍', '🔥', '💎', '🚀', '❤️', '👀', '🎯', '💰', '📈', '📉', '🤔', '😂']

interface EmojiReactionBarProps {
  postId: string
  initialCounts?: Record<string, number>
  initialUserEmojis?: string[]
}

export const EmojiReactionBar = memo(function EmojiReactionBar({
  postId,
  initialCounts = {},
  initialUserEmojis = [],
}: EmojiReactionBarProps) {
  const { getAuthHeaders, isLoggedIn } = useAuthSession()
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts)
  const [userEmojis, setUserEmojis] = useState<Set<string>>(new Set(initialUserEmojis))
  const [showPicker, setShowPicker] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)

  const toggleEmoji = useCallback(async (emoji: string) => {
    if (!isLoggedIn) {
      useLoginModal.getState().openLoginModal()
      return
    }

    const authHeaders = getAuthHeaders()
    if (!authHeaders) return

    // Optimistic update
    const wasActive = userEmojis.has(emoji)
    setUserEmojis(prev => {
      const next = new Set(prev)
      if (wasActive) next.delete(emoji); else next.add(emoji)
      return next
    })
    setCounts(prev => ({
      ...prev,
      [emoji]: Math.max(0, (prev[emoji] || 0) + (wasActive ? -1 : 1)),
    }))
    setShowPicker(false)
    setLoading(emoji)

    try {
      const res = await fetch(`/api/posts/${postId}/emoji-react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...getCsrfHeaders() },
        body: JSON.stringify({ emoji }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        // Reconcile with server truth
        setCounts(data.data.counts)
        setUserEmojis(new Set(data.data.userEmojis))
      }
    } catch {
      // Rollback
      setUserEmojis(prev => {
        const next = new Set(prev)
        if (wasActive) next.add(emoji); else next.delete(emoji)
        return next
      })
      setCounts(prev => ({
        ...prev,
        [emoji]: Math.max(0, (prev[emoji] || 0) + (wasActive ? 1 : -1)),
      }))
    } finally {
      setLoading(null)
    }
  }, [postId, isLoggedIn, getAuthHeaders, userEmojis])

  // Sort emojis by count (highest first), filter out zero-count
  const sortedEmojis = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', position: 'relative' }}>
      {sortedEmojis.map(([emoji, count]) => {
        const isActive = userEmojis.has(emoji)
        return (
          <button
            key={emoji}
            onClick={() => toggleEmoji(emoji)}
            className="interactive-scale"
            disabled={loading === emoji}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: tokens.radius.full,
              border: `1px solid ${isActive ? 'var(--color-accent-primary-40)' : tokens.colors.border.primary}`,
              background: isActive ? 'var(--color-accent-primary-12)' : 'transparent',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1.6,
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            <span>{emoji}</span>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: isActive ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {count}
            </span>
          </button>
        )
      })}

      {/* Add reaction button */}
      <button
        onClick={() => setShowPicker(!showPicker)}
        className="interactive-scale"
        aria-label="Add emoji reaction"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: tokens.radius.full,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: 'transparent',
          cursor: 'pointer',
          fontSize: 14,
          color: tokens.colors.text.tertiary,
          transition: `all ${tokens.transition.fast}`,
        }}
      >
        +
      </button>

      {/* Emoji picker popover */}
      {showPicker && (
        <div
          className="dropdown-enter"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: 4,
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            gap: 2,
            padding: tokens.spacing[2],
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            boxShadow: tokens.shadow.lg,
            zIndex: tokens.zIndex.popover,
          }}
        >
          {EMOJI_OPTIONS.map(emoji => (
            <button
              key={emoji}
              onClick={() => toggleEmoji(emoji)}
              className="interactive-scale"
              style={{
                width: 36,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                border: 'none',
                borderRadius: tokens.radius.md,
                background: userEmojis.has(emoji) ? 'var(--color-accent-primary-15)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
})
