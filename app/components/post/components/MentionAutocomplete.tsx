'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { getMentionQuery } from '@/lib/posts/mentions'

interface MentionUser {
  id: string
  handle: string
  avatar_url?: string | null
}

function readMentionUsers(value: unknown): MentionUser[] {
  if (!value || typeof value !== 'object' || !('users' in value) || !Array.isArray(value.users)) {
    return []
  }

  return value.users
    .filter(
      (candidate): candidate is MentionUser =>
        Boolean(candidate) &&
        typeof candidate === 'object' &&
        'id' in candidate &&
        typeof candidate.id === 'string' &&
        'handle' in candidate &&
        typeof candidate.handle === 'string' &&
        candidate.handle.length > 0 &&
        candidate.handle.length <= 30 &&
        (!('avatar_url' in candidate) ||
          candidate.avatar_url === null ||
          typeof candidate.avatar_url === 'string')
    )
    .slice(0, 5)
}

interface MentionAutocompleteProps {
  /** The full text content of the textarea */
  text: string
  /** Cursor position in the textarea */
  cursorPosition: number
  /** Callback when user selects a mention */
  onSelect: (handle: string, startIndex: number, endIndex: number) => void
  /** Callback to close the dropdown */
  onClose: () => void
  /** Access token for API calls */
  accessToken: string | null
  /** Position relative to textarea */
  style?: React.CSSProperties
}

/**
 * @mention autocomplete dropdown.
 * Shows when user types @ followed by characters.
 * Fetches matching users from /api/users/search.
 */
export function MentionAutocomplete({
  text,
  cursorPosition,
  onSelect,
  onClose,
  accessToken,
  style,
}: MentionAutocompleteProps) {
  const [users, setUsers] = useState<MentionUser[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const mentionInfo = getMentionQuery(text, cursorPosition)

  useEffect(() => {
    if (!mentionInfo || mentionInfo.query.length < 1) {
      setUsers([])
      return
    }

    const query = mentionInfo.query
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)

    // Get access token dynamically
    const headers: Record<string, string> = {}
    const tokenPromise = accessToken
      ? Promise.resolve(accessToken)
      : import('@/lib/supabase/client').then(({ supabase }) =>
          supabase.auth.getSession().then(({ data }) => data.session?.access_token || null)
        )

    tokenPromise
      .then((token) => {
        if (token) headers['Authorization'] = `Bearer ${token}`
        return fetch(`/api/users/search?q=${encodeURIComponent(query)}&limit=5`, {
          headers,
          signal: controller.signal,
        })
      })
      .then((res) => {
        if (!res.ok) throw new Error(`Mention search failed with ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setUsers(readMentionUsers(data))
          setSelectedIndex(0)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsers([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [mentionInfo?.query, accessToken]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelect = useCallback(
    (user: MentionUser) => {
      const currentMention = getMentionQuery(text, cursorPosition)
      if (!currentMention) return
      onSelect(user.handle, currentMention.start, cursorPosition)
      onClose()
    },
    [cursorPosition, onClose, onSelect, text]
  )

  useEffect(() => {
    if (!mentionInfo || users.length === 0) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (!(document.activeElement instanceof HTMLTextAreaElement)) return

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((index) => (index + 1) % users.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((index) => (index - 1 + users.length) % users.length)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        handleSelect(users[selectedIndex] ?? users[0])
      }
    }

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLTextAreaElement) return
      if (target instanceof Node && menuRef.current?.contains(target)) return
      onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('focusin', handleFocusIn)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('focusin', handleFocusIn)
    }
  }, [handleSelect, mentionInfo, onClose, selectedIndex, users])

  if (!mentionInfo || (!loading && users.length === 0)) return null

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Mention suggestions"
      aria-busy={loading}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        boxShadow: tokens.shadow.md,
        overflow: 'hidden',
        zIndex: tokens.zIndex.popover,
        minWidth: 'min(200px, calc(100vw - 32px))',
        maxWidth: 'min(300px, calc(100vw - 32px))',
        ...style,
      }}
    >
      {loading && users.length === 0 && (
        <div
          style={{
            padding: '8px 12px',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          Searching...
        </div>
      )}
      {users.map((user, i) => (
        <button
          type="button"
          role="option"
          aria-label={`@${user.handle}`}
          aria-selected={i === selectedIndex}
          key={user.id}
          onClick={() => handleSelect(user)}
          onMouseEnter={() => setSelectedIndex(i)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '8px 12px',
            border: 'none',
            background: i === selectedIndex ? tokens.colors.bg.tertiary : 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.primary,
            transition: 'background 0.1s',
          }}
        >
          {user.avatar_url ? (
            <img
              src={user.avatar_url}
              alt={`${user.handle || 'User'} avatar`}
              width={24}
              height={24}
              style={{ borderRadius: tokens.radius.full, objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: tokens.radius.full,
                background: tokens.colors.accent.primary,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: tokens.colors.white,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
              }}
            >
              {user.handle?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span style={{ fontWeight: tokens.typography.fontWeight.medium }}>@{user.handle}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Hook to manage mention autocomplete state.
 * Use with a textarea to track cursor position and trigger autocomplete.
 */
export function useMentionAutocomplete() {
  const [showMention, setShowMention] = useState(false)
  const [cursorPos, setCursorPos] = useState(0)

  const handleTextChange = useCallback((text: string, textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return
    const pos = textarea.selectionStart || 0
    setCursorPos(pos)

    // Check if we're in a @mention context
    const before = text.slice(0, pos)
    setShowMention(getMentionQuery(before, before.length, true) !== null)
  }, [])

  const handleSelect = useCallback(
    (
      handle: string,
      startIndex: number,
      endIndex: number,
      text: string,
      setText: (text: string) => void
    ) => {
      // Replace @query with @handle + space
      const newText = text.slice(0, startIndex) + `@${handle} ` + text.slice(endIndex)
      setText(newText)
      setShowMention(false)
    },
    []
  )

  return {
    showMention,
    cursorPos,
    handleTextChange,
    handleSelect,
    closeMention: () => setShowMention(false),
  }
}
