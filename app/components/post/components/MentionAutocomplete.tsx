'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

interface MentionUser {
  id: string
  handle: string
  avatar_url?: string | null
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

  // Extract the @query from text at cursor position
  const getMentionQuery = useCallback((): { query: string; start: number } | null => {
    const before = text.slice(0, cursorPosition)
    const match = before.match(/@(\w{1,30})$/)
    if (!match) return null
    return {
      query: match[1],
      start: before.length - match[0].length,
    }
  }, [text, cursorPosition])

  const mentionInfo = getMentionQuery()

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

    tokenPromise.then(token => {
      if (token) headers['Authorization'] = `Bearer ${token}`
      return fetch(`/api/users/search?q=${encodeURIComponent(query)}&limit=5`, {
        headers,
        signal: controller.signal,
      })
    })
      .then(res => res.json())
      .then(data => {
        if (!controller.signal.aborted) {
          setUsers(data.users || [])
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

  if (!mentionInfo || users.length === 0) return null

  const handleSelect = (user: MentionUser) => {
    onSelect(
      user.handle,
      mentionInfo.start,
      cursorPosition
    )
    onClose()
  }

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        overflow: 'hidden',
        zIndex: 100,
        minWidth: 200,
        maxWidth: 300,
        ...style,
      }}
    >
      {loading && users.length === 0 && (
        <div style={{ padding: '8px 12px', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          Searching...
        </div>
      )}
      {users.map((user, i) => (
        <button
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
            fontSize: 13,
            color: tokens.colors.text.primary,
            transition: 'background 0.1s',
          }}
        >
          {user.avatar_url ? (
            <img
              src={user.avatar_url}
              alt=""
              width={24}
              height={24}
              style={{ borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              background: tokens.colors.accent.primary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
            }}>
              {user.handle?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span style={{ fontWeight: 500 }}>@{user.handle}</span>
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
    const hasMention = /@\w{0,30}$/.test(before)
    setShowMention(hasMention)
  }, [])

  const handleSelect = useCallback((
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
  }, [])

  return {
    showMention,
    cursorPos,
    handleTextChange,
    handleSelect,
    closeMention: () => setShowMention(false),
  }
}
