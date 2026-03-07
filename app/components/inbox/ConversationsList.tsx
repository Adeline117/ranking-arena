'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import Avatar from '@/app/components/ui/Avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import CreateGroupModal from '@/app/components/features/CreateGroupModal'
import { logger } from '@/lib/logger'

type GroupChannel = {
  id: string
  name: string
  type: string
  avatar_url: string | null
  last_message_at: string
  last_message_preview: string | null
}

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
        borderRadius: tokens.radius.md,
        background: tokens.colors.accent.primary,
        color: tokens.colors.white,
        fontSize: 12,
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
  const [groupChannels, setGroupChannels] = useState<GroupChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [chatFilter, setChatFilter] = useState<'all' | 'direct' | 'group'>('all')
  const setUnreadMessages = useInboxStore((s) => s.setUnreadMessages)
  const { language, t } = useLanguage()
  const { user, accessToken, getAuthHeadersAsync } = useAuthSession()
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

      // Also load group channels
      try {
        const groupRes = await fetch('/api/channels?type=group', { headers, signal: abortSignal })
        if (groupRes.ok) {
          const groupData = await groupRes.json()
          setGroupChannels(groupData.channels || [])
        }
      } catch { /* ignore */ }
    } catch (err) {
      if (abortSignal?.aborted) return

      logger.error('Failed to load conversations:', err)
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

  // Realtime: auto-refresh when new DMs arrive for this user
  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel(`inbox:${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'direct_messages',
        filter: `receiver_id=eq.${user.id}`,
      }, (payload) => {
        // Incremental update: update the affected conversation in-place
        const newMsg = payload.new as { conversation_id?: string; content?: string; created_at?: string; sender_id?: string }
        if (!newMsg.conversation_id) { loadConversations(); return }
        setConversations(prev => {
          const idx = prev.findIndex(c => c.id === newMsg.conversation_id)
          if (idx === -1) {
            // New conversation not in list yet — full refresh needed
            loadConversations()
            return prev
          }
          const updated = [...prev]
          updated[idx] = {
            ...updated[idx],
            last_message_at: newMsg.created_at || new Date().toISOString(),
            last_message_preview: newMsg.content || '',
            unread_count: updated[idx].unread_count + 1,
          }
          // Re-sort by last_message_at descending
          updated.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
          setUnreadMessages(calculateTotalUnread(updated))
          return updated
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id, loadConversations, setUnreadMessages])

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
      {/* Header with filter tabs + create group button */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
      }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'direct', 'group'] as const).map(f => (
            <button key={f} onClick={() => setChatFilter(f)} style={{
              padding: '4px 10px', borderRadius: tokens.radius.lg, border: 'none',
              background: chatFilter === f ? tokens.colors.accent.brand : 'transparent',
              color: chatFilter === f ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              minHeight: 28,
            }}>
              {f === 'all' ? t('allChats') : f === 'direct' ? t('directMessages') : t('groupMessages')}
            </button>
          ))}
        </div>
        <button onClick={() => setShowCreateGroup(true)} style={{
          width: 32, height: 32, borderRadius: '50%', border: 'none',
          background: tokens.colors.bg.tertiary, color: tokens.colors.text.secondary,
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} title={t('createGroupChat')} aria-label={t('createGroupChat')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
      </div>
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} />

      {loading ? (
        <div style={{ padding: tokens.spacing[3], display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], padding: `${tokens.spacing[3]} ${tokens.spacing[4]}` }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: tokens.colors.bg.tertiary, flexShrink: 0, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div style={{ width: '40%', height: 14, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                  <div style={{ width: 40, height: 10, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                </div>
                <div style={{ width: '65%', height: 12, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
              </div>
            </div>
          ))}
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

            className="hover-lift"
          >
            {t('retry')}
          </button>
        </div>
      ) : conversations.length === 0 && groupChannels.length === 0 ? (
        <div style={{
          padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[3],
        }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--color-accent-primary-15) 0%, var(--color-accent-primary-08) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: tokens.colors.text.primary, marginBottom: 4 }}>
              {t('noMessages')}
            </div>
            <div style={{ fontSize: 12, color: tokens.colors.text.tertiary, lineHeight: 1.5, maxWidth: 240, margin: '0 auto' }}>
              {t('noMessagesHint') || (language === 'zh' ? '关注交易者后可以发起私信对话' : 'Follow traders to start a conversation')}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* Group channels */}
          {(chatFilter === 'all' || chatFilter === 'group') && groupChannels.map((ch) => (
            <Link key={`ch-${ch.id}`} href={`/channels/${ch.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="hover-bg-secondary" style={{
                display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                cursor: 'pointer',
              }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                  background: `linear-gradient(135deg, ${tokens.colors.accent.brand}44, ${tokens.colors.accent.brand}22)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="1.5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: tokens.colors.text.primary }}>{ch.name}</span>
                    <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, flexShrink: 0 }}>
                      {formatTime(ch.last_message_at)}
                    </span>
                  </div>
                  <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                    {ch.last_message_preview || t('groupChat')}
                  </span>
                </div>
              </div>
            </Link>
          ))}
          {/* Direct conversations */}
          {(chatFilter === 'all' || chatFilter === 'direct') && conversations.map((conv) => (
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
                  background: conv.unread_count > 0 ? 'var(--color-notification-unread)' : 'transparent',
                  transition: 'background 0.15s',
                  cursor: 'pointer',
                }}
                className="hover-bg-secondary"
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
