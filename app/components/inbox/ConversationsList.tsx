'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import Avatar from '@/app/components/ui/Avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

type Conversation = {
  id: string
  other_user: {
    id: string
    handle: string | null
    avatar_url?: string | null
  }
  last_message_at: string
  last_message_preview?: string
  unread_count: number
}

function calculateTotalUnread(conversations: Conversation[]): number {
  return conversations.reduce((sum, c) => sum + c.unread_count, 0)
}

function UnreadBadge({ count }: { count: number }): React.ReactElement | null {
  if (count <= 0) return null

  return (
    <span
      style={{
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        background: tokens.colors.accent.primary,
        color: '#fff',
        fontSize: 10,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 4px',
        flexShrink: 0,
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function ConversationsList(): React.ReactElement {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const setUnreadMessages = useInboxStore((s) => s.setUnreadMessages)
  const { language, t } = useLanguage()
  const { accessToken, getAuthHeadersAsync } = useAuthSession()
  const { showToast } = useToast()

  const loadConversations = useCallback(async (abortSignal?: AbortSignal) => {
    if (!accessToken) return

    try {
      setLoading(true)
      setError(null)
      const headers = await getAuthHeadersAsync()
      const res = await fetch('/api/conversations', {
        headers,
        signal: abortSignal
      })

      if (abortSignal?.aborted) return

      if (!res.ok) {
        const errorMessage = res.status === 401
          ? t('authenticationFailed')
          : t('failedToLoadConversations')
        setError(errorMessage)
        showToast(errorMessage, 'error')
        return
      }

      const data = await res.json()
      if (data.conversations) {
        setConversations(data.conversations)
        setUnreadMessages(calculateTotalUnread(data.conversations))
      }
    } catch (err) {
      if (abortSignal?.aborted) return

      console.error('Failed to load conversations:', err)
      const errorMessage = err instanceof Error ? err.message : t('unexpectedError')
      setError(errorMessage)
      showToast(t('failedToLoadConversations'), 'error')
    } finally {
      if (!abortSignal?.aborted) {
        setLoading(false)
      }
    }
  }, [accessToken, getAuthHeadersAsync, setUnreadMessages, showToast, t])

  useEffect(() => {
    const abortController = new AbortController()

    if (accessToken) {
      loadConversations(abortController.signal)
    }

    return () => {
      abortController.abort()
    }
  }, [accessToken, loadConversations])

  function formatTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    const locale = language === 'zh' ? 'zh-CN' : 'en-US'

    if (days === 0) {
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }
    if (days === 1) {
      return t('yesterday')
    }
    if (days < 7) {
      return t('daysAgo').replace('{days}', String(days))
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }

  return (
    <div>
      <div
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          fontWeight: 700,
          fontSize: tokens.typography.fontSize.sm,
          color: tokens.colors.text.primary,
        }}
      >
        {t('messages')}
      </div>

      {loading ? (
        <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {t('loading')}
        </div>
      ) : error ? (
        <div style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <div style={{ color: tokens.colors.accent.error, fontSize: 13, marginBottom: tokens.spacing[2] }}>
            {error}
          </div>
          <button
            onClick={() => loadConversations()}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              background: tokens.colors.accent.primary,
              color: tokens.colors.white,
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              transition: `all ${tokens.transition.base}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)'
              e.currentTarget.style.boxShadow = tokens.shadow.sm
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            {t('retry')}
          </button>
        </div>
      ) : conversations.length === 0 ? (
        <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          {t('noMessages')}
        </div>
      ) : (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {conversations.map((conv) => (
            <Link
              key={conv.id}
              href={`/messages/${conv.id}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  background: conv.unread_count > 0 ? 'rgba(149,117,205,0.06)' : 'transparent',
                  transition: 'background 0.15s',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
                onMouseLeave={(e) => { e.currentTarget.style.background = conv.unread_count > 0 ? 'rgba(149,117,205,0.06)' : 'transparent' }}
              >
                <div style={{ flexShrink: 0 }}>
                  <Avatar
                    userId={conv.other_user.id}
                    name={conv.other_user.handle || 'User'}
                    avatarUrl={conv.other_user.avatar_url}
                    size={40}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: conv.unread_count > 0 ? 800 : 600, fontSize: 13, color: tokens.colors.text.primary }}>
                      {conv.other_user.handle || `User ${conv.other_user.id.slice(0, 8)}`}
                    </span>
                    <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, flexShrink: 0 }}>
                      {formatTime(conv.last_message_at)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: conv.unread_count > 0 ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {conv.last_message_preview || t('startChat')}
                    </span>
                    <UnreadBadge count={conv.unread_count} />
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
