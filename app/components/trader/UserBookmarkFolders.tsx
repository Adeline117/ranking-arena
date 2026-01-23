'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import Card from '@/app/components/ui/Card'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'

type BookmarkFolder = {
  id: string
  name: string
  description?: string | null
  avatar_url?: string | null
  post_count: number
  subscriber_count?: number
  is_public: boolean
}

type UserBookmarkFoldersProps = {
  userId: string
  isOwnProfile?: boolean
}

/**
 * 用户公开收藏夹展示组件
 * 在用户主页右侧展示公开的收藏夹
 */
export default function UserBookmarkFolders({ userId, isOwnProfile = false }: UserBookmarkFoldersProps) {
  const { language } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [subscriptions, setSubscriptions] = useState<Record<string, boolean>>({})
  const [subscribing, setSubscribing] = useState<Record<string, boolean>>({})

  // 获取当前用户信息
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null)
      setCurrentUserId(data.session?.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    const load = async () => {
      try {
        // 如果是自己的主页，显示所有收藏夹；否则只显示公开的
        let query = supabase
          .from('bookmark_folders')
          .select('id, name, description, avatar_url, post_count, is_public')
          .eq('user_id', userId)
          .order('is_default', { ascending: false })
          .order('created_at', { ascending: false })

        if (!isOwnProfile) {
          query = query.eq('is_public', true)
        }

        const { data, error } = await query

        if (error) {
          // 如果表不存在或权限不足，静默处理
          // 错误代码: 42P01=表不存在, PGRST116=没有找到资源, PGRST204=schema cache中没找到表, 42703=列不存在
          const ignoredCodes = ['42P01', 'PGRST116', 'PGRST204', '42703']
          if (!ignoredCodes.includes(error.code || '')) {
            console.error('Error loading bookmark folders:', error.message || error)
          }
          setFolders([])
          return
        }
        console.log('[UserBookmarkFolders] Loaded folders:', data?.length, 'isOwnProfile:', isOwnProfile)
        setFolders(data || [])
        
        // 如果不是自己的主页，获取当前用户对这些收藏夹的订阅状态
        if (!isOwnProfile && accessToken && data && data.length > 0) {
          const folderIds = data.map(f => f.id)
          const { data: subs } = await supabase
            .from('folder_subscriptions')
            .select('folder_id')
            .eq('user_id', currentUserId || '')
            .in('folder_id', folderIds)
          
          if (subs) {
            const subsMap: Record<string, boolean> = {}
            subs.forEach(s => { subsMap[s.folder_id] = true })
            setSubscriptions(subsMap)
          }
        }
      } catch (_err) {
        // 静默处理异常，不显示收藏夹组件
        setFolders([])
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [userId, isOwnProfile, accessToken, currentUserId])

  // 处理订阅/取消订阅
  const handleSubscribe = useCallback(async (e: React.MouseEvent, folderId: string) => {
    e.preventDefault()
    e.stopPropagation()
    
    if (!accessToken) {
      router.push('/login')
      return
    }
    
    setSubscribing(prev => ({ ...prev, [folderId]: true }))
    
    try {
      const isSubscribed = subscriptions[folderId]
      const response = await fetch(`/api/bookmark-folders/${folderId}/subscribe`, {
        method: isSubscribed ? 'DELETE' : 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      const data = await response.json()
      
      if (response.ok) {
        setSubscriptions(prev => ({ ...prev, [folderId]: !isSubscribed }))
        // 更新订阅者数量
        setFolders(prev => prev.map(f =>
          f.id === folderId
            ? { ...f, subscriber_count: data.data?.subscriber_count ?? (f.subscriber_count || 0) }
            : f
        ))
      } else {
        // 显示错误提示
        console.error('Subscribe error:', data.error || 'Unknown error')
      }
    } catch (err) {
      console.error('Error toggling subscription:', err)
      showToast(language === 'zh' ? '操作失败，请重试' : 'Operation failed, please try again', 'error')
    } finally {
      setSubscribing(prev => ({ ...prev, [folderId]: false }))
    }
  }, [accessToken, subscriptions, router, showToast, language])

  if (loading) {
    return null
  }

  if (folders.length === 0) {
    return null
  }

  const getDefaultAvatar = (name: string) => {
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8']
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  return (
    <Card title={language === 'zh' ? '收藏夹' : 'Bookmark Folders'}>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {folders.map((folder) => (
          <Link
            key={folder.id}
            href={`/favorites/${folder.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[3],
              padding: tokens.spacing[2],
              borderRadius: tokens.radius.md,
              textDecoration: 'none',
              color: tokens.colors.text.primary,
              transition: `all ${tokens.transition.base}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.secondary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            {/* Avatar */}
            <Box
              style={{
                width: 36,
                height: 36,
                borderRadius: tokens.radius.md,
                backgroundColor: folder.avatar_url ? undefined : getDefaultAvatar(folder.name),
                backgroundImage: folder.avatar_url ? `url(${folder.avatar_url})` : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                border: `1px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {!folder.avatar_url && (
                <Text size="sm" weight="bold" style={{ color: '#fff' }}>
                  {folder.name.charAt(0).toUpperCase()}
                </Text>
              )}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 2 }}>
                <Text size="sm" weight="semibold">
                  {folder.name}
                </Text>
                {/* 私密标识 - 仅在自己的主页显示 */}
                {isOwnProfile && !folder.is_public && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: '1px 4px',
                      background: tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)',
                      color: tokens.colors.text.tertiary,
                      borderRadius: tokens.radius.sm,
                    }}
                  >
                    {language === 'zh' ? '私密' : 'Private'}
                  </span>
                )}
              </Box>
              <Text size="xs" color="tertiary">
                {folder.post_count} {language === 'zh' ? '个收藏' : 'bookmarks'}
                {!isOwnProfile && (folder.subscriber_count || 0) > 0 && (
                  <> · {folder.subscriber_count} {language === 'zh' ? '人收藏' : 'subscribers'}</>
                )}
              </Text>
            </Box>

            {/* 收藏按钮 - 非自己的主页显示 */}
            {!isOwnProfile && folder.is_public && (
              <button
                onClick={(e) => handleSubscribe(e, folder.id)}
                disabled={subscribing[folder.id]}
                style={{
                  padding: '4px 8px',
                  borderRadius: tokens.radius.sm,
                  border: 'none',
                  background: subscriptions[folder.id] 
                    ? 'rgba(255,215,0,0.15)' 
                    : tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)',
                  color: subscriptions[folder.id] 
                    ? '#FFD700' 
                    : tokens.colors.text.secondary,
                  fontSize: 12,
                  cursor: subscribing[folder.id] ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  transition: `all ${tokens.transition.base}`,
                  flexShrink: 0,
                }}
              >
                {subscribing[folder.id] ? (
                  '...'
                ) : subscriptions[folder.id] ? (
                  <>
                    <span>★</span>
                    {language === 'zh' ? '已收藏' : 'Saved'}
                  </>
                ) : (
                  <>
                    <span>☆</span>
                    {language === 'zh' ? '收藏' : 'Save'}
                  </>
                )}
              </button>
            )}

            {/* 箭头 - 仅在自己的主页显示 */}
            {isOwnProfile && (
              <Text size="sm" color="tertiary">
                →
              </Text>
            )}
          </Link>
        ))}

        {/* 查看全部链接 */}
        {isOwnProfile && (
          <Link
            href="/favorites"
            style={{
              display: 'block',
              textAlign: 'center',
              padding: tokens.spacing[2],
              color: tokens.colors.accent?.primary || '#8b6fa8',
              fontSize: tokens.typography.fontSize.sm,
              textDecoration: 'none',
              borderRadius: tokens.radius.md,
              transition: `background ${tokens.transition.base}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.secondary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            {language === 'zh' ? '管理收藏夹' : 'Manage Folders'}
          </Link>
        )}
      </Box>
    </Card>
  )
}
