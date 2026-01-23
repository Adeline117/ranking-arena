'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import Avatar from './Avatar'
import UserFollowButton from './UserFollowButton'

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
  isPublic?: boolean // 该列表是否公开
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
  const [users, setUsers] = useState<FollowUser[]>([])
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [hiddenMessage, setHiddenMessage] = useState('')
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (isOpen && handle) {
      loadUsers()
    }

    // 清理：组件卸载或关闭时取消请求
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, handle, type])

  const loadUsers = async () => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    setLoading(true)
    try {
      const endpoint = type === 'followers'
        ? `/api/users/${encodeURIComponent(handle)}/followers`
        : `/api/users/${encodeURIComponent(handle)}/following`

      const url = currentUserId
        ? `${endpoint}?requesterId=${currentUserId}`
        : endpoint

      const response = await fetch(url, {
        signal: abortControllerRef.current.signal,
      })
      const data = await response.json()

      if (response.ok) {
        if (data.hidden) {
          setHidden(true)
          setHiddenMessage(data.message || '该用户已关闭列表展示')
          setUsers([])
        } else {
          setHidden(false)
          setUsers(data.followers || data.following || [])
        }
      } else {
        console.error('加载失败:', data.error)
        setUsers([])
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('加载失败:', error)
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

  const title = type === 'followers' ? '被关注' : '关注中'

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: tokens.zIndex.modal,
      }}
      onClick={onClose}
    >
      <Box
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
        {/* 头部 */}
        <Box style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: tokens.spacing[4],
          paddingBottom: tokens.spacing[3],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Text size="lg" weight="bold">{title}</Text>
            {/* 隐私状态说明 - 仅自己可见 */}
            {isOwnProfile && (
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                <span style={{ 
                  fontSize: 10, 
                  color: isPublic ? tokens.colors.accent.success : tokens.colors.accent.warning,
                }}>
                  {isPublic ? '○' : '●'}
                </span>
                <Text size="xs" color="tertiary">
                  {isPublic ? '公开 - 其他人可以查看' : '私密 - 仅自己可见'}
                </Text>
              </Box>
            )}
          </Box>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 24,
              cursor: 'pointer',
              color: tokens.colors.text.tertiary,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </Box>

        {/* 用户列表 */}
        <Box style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[6] }}>
              <Text size="sm" color="tertiary">加载中...</Text>
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
                {type === 'followers' ? '暂无人关注 TA' : '暂未关注任何人'}
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
                  {/* 头像 */}
                  <Avatar
                    userId={user.id}
                    name={user.handle}
                    avatarUrl={user.avatar_url}
                    size={44}
                    style={{ flexShrink: 0 }}
                  />

                  {/* 用户信息 */}
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

                  {/* 关注按钮 - 不显示自己的关注按钮 */}
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
