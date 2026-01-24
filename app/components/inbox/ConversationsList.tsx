'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { getAuthSession, refreshAuthToken } from '@/lib/auth/client'
import Avatar from '@/app/components/ui/Avatar'

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

export default function ConversationsList() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const setUnreadMessages = useInboxStore((s) => s.setUnreadMessages)

  const loadConversations = useCallback(async () => {
    try {
      setLoading(true)
      let auth = await getAuthSession()
      if (!auth) {
        auth = await refreshAuthToken()
        if (!auth) return
      }

      const res = await fetch('/api/conversations', {
        headers: { 'Authorization': `Bearer ${auth.accessToken}` },
      })

      if (res.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          const retryRes = await fetch('/api/conversations', {
            headers: { 'Authorization': `Bearer ${refreshed.accessToken}` },
          })
          const retryData = await retryRes.json()
          if (retryRes.ok && retryData.conversations) {
            setConversations(retryData.conversations)
            const totalUnread = retryData.conversations.reduce((sum: number, c: Conversation) => sum + c.unread_count, 0)
            setUnreadMessages(totalUnread)
            return
          }
        }
        return
      }

      const data = await res.json()
      if (data.conversations) {
        setConversations(data.conversations)
        const totalUnread = data.conversations.reduce((sum: number, c: Conversation) => sum + c.unread_count, 0)
        setUnreadMessages(totalUnread)
      }
    } catch (err) {
      console.error('Failed to load conversations:', err)
    } finally {
      setLoading(false)
    }
  }, [setUnreadMessages])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    if (days === 0) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (days === 1) return '昨天'
    if (days < 7) return `${days}天前`
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
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
        私信
      </div>

      {loading ? (
        <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          加载中...
        </div>
      ) : conversations.length === 0 ? (
        <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
          暂无私信
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
                      {conv.last_message_preview || '开始聊天'}
                    </span>
                    {conv.unread_count > 0 && (
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
                        {conv.unread_count > 99 ? '99+' : conv.unread_count}
                      </span>
                    )}
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
