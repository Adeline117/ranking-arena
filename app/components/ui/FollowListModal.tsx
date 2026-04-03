'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import Avatar from './Avatar'
import UserFollowButton from './UserFollowButton'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from './Toast'
import { supabase } from '@/lib/supabase/client'

type FollowUser = {
  id: string
  handle: string
  bio?: string
  avatar_url?: string
  followed_at: string
  is_following: boolean
}

interface FollowListModalProps {
  isOpen: boolean
  onClose: () => void
  type: 'followers' | 'following'
  handle: string
  currentUserId?: string | null
  isOwnProfile?: boolean
  isPublic?: boolean
}

export default function FollowListModal({
  isOpen,
  onClose,
  type,
  handle,
  currentUserId,
  isOwnProfile = false,
  isPublic = true,
}: FollowListModalProps) {
  const router = useRouter()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [users, setUsers] = useState<FollowUser[]>([])
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [hiddenMessage, setHiddenMessage] = useState('')
  const abortControllerRef = useRef<AbortController | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (isOpen && handle) {
      loadUsers()
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadUsers is defined in closure, not a stable ref
  }, [isOpen, handle, type])

  // Scroll lock when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  // Focus trap + escape key
  useEffect(() => {
    if (!isOpen) return
    previousFocusRef.current = document.activeElement as HTMLElement
    const timer = setTimeout(() => {
      if (modalRef.current) {
        const firstBtn = modalRef.current.querySelector<HTMLElement>('button')
        firstBtn?.focus()
      }
    }, 50)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [isOpen, onClose])

  const loadUsers = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    setLoading(true)
    try {
      const endpoint = `/api/users/${encodeURIComponent(handle)}/follow?list=${type}`

      // Pass auth token instead of requesterId in query params (security: prevent IDOR)
      const headers: Record<string, string> = {}
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        headers['Authorization'] = `Bearer ${session.access_token}`
      }

      const response = await fetch(endpoint, {
        signal: abortControllerRef.current.signal,
        headers,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(errorData.error || t('loadFailed'))
      }

      const data = await response.json()

      // Validate response data structure
      if (typeof data !== 'object' || data === null) {
        throw new Error(t('invalidResponse'))
      }

      if (data.hidden) {
        setHidden(true)
        setHiddenMessage(data.message || t('userHiddenList'))
        setUsers([])
      } else {
        setHidden(false)
        // Validate that the data contains an array
        const userList = data.followers || data.following
        if (Array.isArray(userList)) {
          setUsers(userList)
        } else {
          setUsers([])
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        const errorMsg = error instanceof Error ? error.message : t('loadFailed')
        showToast(errorMsg, 'error')
        setUsers([])
      }
    } finally {
      setLoading(false)
    }
  }

  const handleUserClick = (userHandle: string) => {
    onClose()
    router.push(`/u/${encodeURIComponent(userHandle)}`)
  }

  if (!isOpen) return null

  const title = type === 'followers' ? t('followers') : t('following')

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'var(--color-backdrop)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: tokens.zIndex.modal,
      }}
      onClick={onClose}
    >
      <Box
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="follow-list-modal-title"
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: '90%',
          maxWidth: 420,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <Box style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
          paddingBottom: tokens.spacing[3],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Text id="follow-list-modal-title" size="lg" weight="bold">{title}</Text>
            {isOwnProfile && (
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                <span style={{
                  fontSize: 12,
                  color: isPublic ? tokens.colors.accent.success : tokens.colors.accent.warning,
                }}>
                  {isPublic ? '\u25CB' : '\u25CF'}
                </span>
                <Text size="xs" color="tertiary">
                  {isPublic ? t('publicListVisible') : t('privateListHidden')}
                </Text>
              </Box>
            )}
          </Box>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 24,
              cursor: 'pointer',
              color: tokens.colors.text.tertiary,
              lineHeight: 1.2,
              padding: 4,
            }}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </Box>

        {/* User list */}
        <Box style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Text size="sm" color="tertiary">{t('loading')}</Text>
            </Box>
          ) : hidden ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Box style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: tokens.colors.bg.tertiary,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
                marginBottom: tokens.spacing[3],
                opacity: 0.5,
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
              </Box>
              <Text size="sm" color="tertiary">{hiddenMessage}</Text>
            </Box>
          ) : users.length === 0 ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Text size="sm" color="tertiary">
                {type === 'followers' ? t('noFollowersYet') : t('notFollowingAnyone')}
              </Text>
            </Box>
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {users.map((user) => (
                <Box
                  key={user.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.md,
                    cursor: 'pointer',
                    transition: `background ${tokens.transition.base}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                  onClick={() => handleUserClick(user.handle)}
                >
                  <Avatar
                    userId={user.id}
                    name={user.handle}
                    avatarUrl={user.avatar_url}
                    size={44}
                    style={{ flexShrink: 0 }}
                  />

                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" weight="semibold" style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {user.handle}
                    </Text>
                    {user.bio && (
                      <Text size="xs" color="tertiary" style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                      }}>
                        {user.bio}
                      </Text>
                    )}
                  </Box>

                  {currentUserId && user.id !== currentUserId && (
                    <Box onClick={(e) => e.stopPropagation()}>
                      <UserFollowButton
                        targetUserId={user.id}
                        currentUserId={currentUserId}
                        size="sm"
                        initialFollowing={user.is_following}
                      />
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}
