'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box, Text, Button } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { logger } from '@/lib/logger'

interface BookmarkFolder {
  id: string
  name: string
  description?: string | null
  avatar_url?: string | null
  post_count: number
  is_public: boolean
  is_default: boolean
}

interface SubscribedFolder {
  id: string
  name: string
  description?: string | null
  avatar_url?: string | null
  post_count: number
  subscriber_count: number
  owner_handle?: string
  owner_avatar_url?: string | null
  subscribed_at: string
}


export default function FavoritesPage() {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, email } = useAuthSession()
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [subscribedFolders, setSubscribedFolders] = useState<SubscribedFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'my' | 'subscribed'>('my')

  // 新建收藏夹
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderPublic, setNewFolderPublic] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    // 等待认证检查完成
    if (!authChecked) return

    if (!accessToken) {
      setLoading(false)
      return
    }

    const abortController = new AbortController()

    const load = async () => {
      setLoading(true)
      try {
        // 并行加载我的收藏夹和已订阅的收藏夹
        const [foldersResponse, subscribedResponse] = await Promise.all([
          fetch('/api/bookmark-folders', {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: abortController.signal,
          }),
          fetch('/api/bookmark-folders/subscribed', {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            signal: abortController.signal,
          }),
        ])

        const foldersData = await foldersResponse.json()
        const subscribedData = await subscribedResponse.json()

        if (foldersResponse.ok) {
          setFolders(foldersData.data?.folders || [])
        } else {
          logger.error('Error fetching folders:', foldersData.error)
          setFolders([])
          showToast(t('loadFoldersFailed'), 'error')
        }

        if (subscribedResponse.ok) {
          setSubscribedFolders(subscribedData.data?.folders || [])
        } else {
          // 订阅功能可能未启用，静默处理
          if (subscribedResponse.status !== 404) {
            logger.warn('[Favorites] Subscribed folders not available:', subscribedData.error?.message || subscribedResponse.status)
          }
          setSubscribedFolders([])
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') return
        logger.error('Error loading folders:', error)
        setFolders([])
        setSubscribedFolders([])
        showToast(t('loadFoldersFailedRetry'), 'error')
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      abortController.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is defined inside effect; showToast/t are stable refs
  }, [accessToken, authChecked])

  const createFolder = async () => {
    if (!newFolderName.trim() || !accessToken) return
    
    setCreating(true)
    try {
      const response = await fetch('/api/bookmark-folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          name: newFolderName.trim(),
          is_public: newFolderPublic,
        }),
      })
      
      const data = await response.json()
      if (response.ok) {
        const newFolder = data.data?.folder
        if (newFolder) setFolders(prev => [...prev, newFolder])
        setNewFolderName('')
        setNewFolderPublic(false)
        setShowCreateForm(false)
        showToast(t('folderCreated'), 'success')
      } else {
        showToast(data.error || t('createFailed'), 'error')
      }
    } catch (error) {
      logger.error('Error creating folder:', error)
      showToast(t('createFailed'), 'error')
    } finally {
      setCreating(false)
    }
  }

  const getDefaultAvatar = (name: string) => {
    const colors = ['var(--color-accent-error)', 'var(--color-chart-teal)', 'var(--color-chart-blue)', 'var(--color-chart-sage)', 'var(--color-chart-yellow)', 'var(--color-chart-pink)', 'var(--color-chart-mint)']
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  // 等待认证检查完成后再判断是否需要登录
  if (!authChecked || (authChecked && !accessToken && loading)) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            {t('myFavorites')}
          </Text>
          <ListSkeleton count={5} gap={12} />
        </Box>
      </Box>
    )
  }

  if (authChecked && !accessToken) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            {t('myFavorites')}
          </Text>
          <EmptyState
            title={t('pleaseLoginFirst')}
            description={t('loginToViewFavorites')}
            action={
              <Link
                href="/login?redirect=/favorites"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 44,
                  padding: '12px 24px',
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  borderRadius: tokens.radius.md,
                  textDecoration: 'none',
                  fontWeight: 900,
                  fontSize: '14px',
                }}
              >
                {t('goToLogin')}
              </Link>
            }
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box className="has-mobile-nav" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100, animation: 'fadeIn 0.3s ease-out' }}>
        <Breadcrumb items={[{ label: t('favorites') }]} />
        {/* 页面头部 */}
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Text size="2xl" weight="black">
            {t('myFavorites')}
          </Text>
          {activeTab === 'my' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              + {t('newFolder')}
            </Button>
          )}
        </Box>
        
        {/* 标签切换 */}
        <Box style={{ 
          display: 'flex', 
          gap: tokens.spacing[1], 
          marginBottom: tokens.spacing[6],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <button
            onClick={() => setActiveTab('my')}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'my' ? `2px solid ${tokens.colors.accent?.primary || tokens.colors.accent.brand}` : '2px solid transparent',
              color: activeTab === 'my' ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              fontWeight: activeTab === 'my' ? 700 : 400,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              marginBottom: -1,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('myFoldersTab')} ({folders.length})
          </button>
          <button
            onClick={() => setActiveTab('subscribed')}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'subscribed' ? `2px solid ${tokens.colors.accent?.primary || tokens.colors.accent.brand}` : '2px solid transparent',
              color: activeTab === 'subscribed' ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              fontWeight: activeTab === 'subscribed' ? 700 : 400,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              marginBottom: -1,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('subscribedFoldersTab')} ({subscribedFolders.length})
          </button>
        </Box>

        {/* 新建收藏夹表单 */}
        {showCreateForm && (
          <Box
            style={{
              marginBottom: tokens.spacing[6],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="base" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('newFolder')}
            </Text>
            <input
              type="text"
              placeholder={t('bookmarkFolderName')}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                marginBottom: tokens.spacing[3],
                fontSize: tokens.typography.fontSize.base,
              }}
            />
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={newFolderPublic}
                  onChange={(e) => setNewFolderPublic(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                <Text size="sm">{t('publicShowOnProfile')}</Text>
              </label>
            </Box>
            <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
              <Button
                variant="primary"
                size="sm"
                onClick={createFolder}
                disabled={creating || !newFolderName.trim()}
              >
                {creating ? t('creating') : t('create')}
              </Button>
              <Button
                variant="text"
                size="sm"
                onClick={() => {
                  setShowCreateForm(false)
                  setNewFolderName('')
                  setNewFolderPublic(false)
                }}
              >
                {t('cancel')}
              </Button>
            </Box>
          </Box>
        )}

        {/* 收藏夹列表 */}
        {loading ? (
          <ListSkeleton count={5} gap={12} />
        ) : activeTab === 'my' ? (
          // 我的收藏夹
          folders.length === 0 ? (
            <EmptyState
              title={t('noFolders')}
              description={t('noFoldersCta')}
              action={
                <button
                  onClick={() => setShowCreateForm(true)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 44,
                    padding: '10px 24px',
                    background: tokens.colors.accent.brand,
                    color: tokens.colors.white,
                    borderRadius: tokens.radius.md,
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  + {t('newFolder')}
                </button>
              }
            />
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {folders.map((folder) => (
                <Link
                  key={folder.id}
                  href={`/favorites/${folder.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[4],
                    padding: tokens.spacing[4],
                    borderRadius: tokens.radius.lg,
                    background: tokens.colors.bg.secondary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: `all ${tokens.transition.base}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)'
                    e.currentTarget.style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateX(4px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                    e.currentTarget.style.borderColor = tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateX(0)'
                  }}
                >
                  {/* 收藏夹头像 */}
                  <Box
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: tokens.radius.lg,
                      backgroundColor: folder.avatar_url ? undefined : getDefaultAvatar(folder.name),
                      backgroundImage: folder.avatar_url ? `url(${folder.avatar_url})` : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {!folder.avatar_url && (
                      <Text size="lg" weight="bold" style={{ color: tokens.colors.white }}>
                        {folder.name.charAt(0).toUpperCase()}
                      </Text>
                    )}
                  </Box>

                  {/* 收藏夹信息 */}
                  <Box style={{ flex: 1 }}>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[1], flexWrap: 'wrap' }}>
                      <Text size="base" weight="bold">
                        {folder.name}
                      </Text>
                      {folder.is_default && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            background: tokens.colors.accent?.primary + '20',
                            color: tokens.colors.accent?.primary,
                            borderRadius: tokens.radius.sm,
                          }}
                        >
                          {t('defaultLabel')}
                        </span>
                      )}
                      {folder.is_public ? (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            background: tokens.colors.accent.success + '20',
                            color: tokens.colors.accent.success,
                            borderRadius: tokens.radius.sm,
                          }}
                        >
                          {t('publicFolder')}
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            background: 'var(--glass-bg-medium)',
                            color: tokens.colors.text.tertiary,
                            borderRadius: tokens.radius.sm,
                          }}
                        >
                          {t('privateFolder')}
                        </span>
                      )}
                    </Box>
                    {folder.description && (
                      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[1] }}>
                        {folder.description}
                      </Text>
                    )}
                    <Text size="xs" color="tertiary">
                      {t('itemCount').replace('{n}', String(folder.post_count))}
                    </Text>
                  </Box>

                  {/* 箭头 */}
                  <Text size="lg" color="tertiary">
                    →
                  </Text>
                </Link>
              ))}
            </Box>
          )
        ) : (
          // 收藏的收藏夹
          subscribedFolders.length === 0 ? (
            <EmptyState
              title={t('noSubscribedFolders')}
              description={t('noSubscribedFoldersDesc')}
              action={
                <Link
                  href="/rankings"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 44,
                    padding: '10px 24px',
                    background: tokens.colors.accent.brand,
                    color: tokens.colors.white,
                    borderRadius: tokens.radius.md,
                    textDecoration: 'none',
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  {t('browsePublicFolders')}
                </Link>
              }
            />
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {subscribedFolders.map((folder) => (
                <Link
                  key={folder.id}
                  href={`/favorites/${folder.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[4],
                    padding: tokens.spacing[4],
                    borderRadius: tokens.radius.lg,
                    background: tokens.colors.bg.secondary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: `all ${tokens.transition.base}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)'
                    e.currentTarget.style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateX(4px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                    e.currentTarget.style.borderColor = tokens.colors.border.primary
                    e.currentTarget.style.transform = 'translateX(0)'
                  }}
                >
                  {/* 收藏夹头像 */}
                  <Box
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: tokens.radius.lg,
                      backgroundColor: folder.avatar_url ? undefined : getDefaultAvatar(folder.name),
                      backgroundImage: folder.avatar_url ? `url(${folder.avatar_url})` : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {!folder.avatar_url && (
                      <Text size="lg" weight="bold" style={{ color: tokens.colors.white }}>
                        {folder.name.charAt(0).toUpperCase()}
                      </Text>
                    )}
                  </Box>

                  {/* 收藏夹信息 */}
                  <Box style={{ flex: 1 }}>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[1] }}>
                      <Text size="base" weight="bold">
                        {folder.name}
                      </Text>
                      <span
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          background: tokens.colors.accent.warning + '20',
                          color: tokens.colors.accent.warning,
                          borderRadius: tokens.radius.sm,
                        }}
                      >
                        {t('subscribed')}
                      </span>
                    </Box>
                    {folder.description && (
                      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[1] }}>
                        {folder.description}
                      </Text>
                    )}
                    <Text size="xs" color="tertiary">
                      {t('itemCount').replace('{n}', String(folder.post_count))}
                      {folder.subscriber_count > 0 && ` · ${t('subscriberCount').replace('{n}', String(folder.subscriber_count))}`}
                      {folder.owner_handle && ` · @${folder.owner_handle}`}
                    </Text>
                  </Box>

                  {/* 箭头 */}
                  <Text size="lg" color="tertiary">
                    →
                  </Text>
                </Link>
              ))}
            </Box>
          )
        )}
      </Box>
      <MobileBottomNav />
    </Box>
  )
}


