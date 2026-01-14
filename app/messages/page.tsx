'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text } from '@/app/components/Base'
import Avatar from '@/app/components/UI/Avatar'

type Conversation = {
  id: string
  other_user: {
    id: string
    handle: string
    avatar_url?: string
    bio?: string
  }
  last_message_at: string
  last_message_preview?: string
  unread_count: number
}

export default function MessagesPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (!data.user) {
        router.push('/login')
        return
      }
      
      loadConversations(data.user.id)
    })
  }, [router])

  const loadConversations = async (uid: string) => {
    try {
      setLoading(true)
      const res = await fetch(`/api/conversations?userId=${uid}`)
      const data = await res.json()
      
      if (data.conversations) {
        setConversations(data.conversations)
      }
    } catch (error) {
      console.error('Error loading conversations:', error)
    } finally {
      setLoading(false)
    }
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else if (days === 1) {
      return '昨天'
    } else if (days < 7) {
      return `${days}天前`
    } else {
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          私信
        </Text>

        {conversations.length === 0 ? (
          <Box
            bg="secondary"
            p={8}
            radius="xl"
            border="primary"
            style={{ textAlign: 'center' }}
          >
            <Text size="lg" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
              暂无私信
            </Text>
            <Text size="sm" color="tertiary">
              当你和其他用户开始私信聊天后，会话将显示在这里
            </Text>
          </Box>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/messages/${conv.id}`}
                style={{ textDecoration: 'none' }}
              >
                <Box
                  bg="secondary"
                  p={4}
                  radius="lg"
                  border="primary"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[4],
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                  }}
                  className="hover-bg"
                >
                  <Avatar
                    userId={conv.other_user.id}
                    name={conv.other_user.handle}
                    avatarUrl={conv.other_user.avatar_url}
                    size={50}
                  />
                  
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
                      <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                        @{conv.other_user.handle}
                      </Text>
                      <Text size="xs" color="tertiary">
                        {formatTime(conv.last_message_at)}
                      </Text>
                    </Box>
                    <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text
                        size="sm"
                        color="secondary"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '80%',
                        }}
                      >
                        {conv.last_message_preview || '开始聊天'}
                      </Text>
                      {conv.unread_count > 0 && (
                        <Box
                          style={{
                            background: '#8b6fa8',
                            color: '#fff',
                            borderRadius: '50%',
                            width: 20,
                            height: 20,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                            fontWeight: 'bold',
                          }}
                        >
                          {conv.unread_count > 99 ? '99+' : conv.unread_count}
                        </Box>
                      )}
                    </Box>
                  </Box>
                </Box>
              </Link>
            ))}
          </Box>
        )}
      </Box>

      <style jsx global>{`
        .hover-bg:hover {
          background-color: ${tokens.colors.bg.tertiary} !important;
        }
      `}</style>
    </Box>
  )
}

