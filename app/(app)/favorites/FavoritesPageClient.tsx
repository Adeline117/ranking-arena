'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { tokens, alpha } from '@/lib/design-tokens'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { Box, Text, Button } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorState from '@/app/components/ui/ErrorState'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import PageHeader from '@/app/components/ui/PageHeader'
import { logger } from '@/lib/logger'
import { useTabsA11y } from '@/lib/hooks/useTabsA11y'
import { isViewerScopeCurrent, type ViewerKey } from '@/lib/auth/viewer-scope'

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

type LoadStatus = 'idle' | 'loading' | 'success' | 'error'
type FolderLane = 'my' | 'subscribed'
type RequestScope = {
  viewerKey: ViewerKey
  sessionGeneration: number
  userId: string
}

const FOLDER_CACHE_TTL_MS = 60_000
const FOLDER_REQUEST_TIMEOUT_MS = 15_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function isBookmarkFolder(value: unknown): value is BookmarkFolder {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isNullableString(value.description) &&
    isNullableString(value.avatar_url) &&
    typeof value.post_count === 'number' &&
    Number.isFinite(value.post_count) &&
    typeof value.is_public === 'boolean' &&
    typeof value.is_default === 'boolean'
  )
}

function isSubscribedFolder(value: unknown): value is SubscribedFolder {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isNullableString(value.description) &&
    isNullableString(value.avatar_url) &&
    typeof value.post_count === 'number' &&
    Number.isFinite(value.post_count) &&
    typeof value.subscriber_count === 'number' &&
    Number.isFinite(value.subscriber_count) &&
    isNullableString(value.owner_handle) &&
    isNullableString(value.owner_avatar_url) &&
    typeof value.subscribed_at === 'string'
  )
}

function isRequestScopeCurrent(
  expected: RequestScope,
  current: {
    viewerKey: ViewerKey
    sessionGeneration: number
    userId: string | null
  }
): boolean {
  return (
    expected.viewerKey === current.viewerKey &&
    expected.sessionGeneration === current.sessionGeneration &&
    expected.userId === current.userId &&
    isViewerScopeCurrent(expected)
  )
}

async function readFolderList<T>(
  response: Response,
  isFolder: (value: unknown) => value is T
): Promise<T[]> {
  if (!response.ok) throw new Error(`Folder request failed with HTTP ${response.status}`)

  const payload: unknown = await response.json()
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('data' in payload) ||
    !payload.data ||
    typeof payload.data !== 'object' ||
    !('folders' in payload.data) ||
    !Array.isArray(payload.data.folders) ||
    !payload.data.folders.every(isFolder)
  ) {
    throw new Error('Folder request returned an invalid payload')
  }

  return payload.data.folders
}

export default function FavoritesPageClient({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, userId, viewerKey, sessionGeneration } = useAuthSession()
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [subscribedFolders, setSubscribedFolders] = useState<SubscribedFolder[]>([])
  const [foldersStatus, setFoldersStatus] = useState<LoadStatus>('idle')
  const [subscribedStatus, setSubscribedStatus] = useState<LoadStatus>('idle')
  const [dataViewerKey, setDataViewerKey] = useState<ViewerKey>('pending')
  const [activeTab, setActiveTab] = useState<'my' | 'subscribed'>('my')
  // B2 tabs a11y: my/subscribed folders share the single list region below.
  const favTabsA11y = useTabsA11y({
    tabs: ['my', 'subscribed'] as const,
    active: activeTab,
    onChange: setActiveTab,
    idPrefix: 'fav',
    sharedPanelId: 'fav-panel',
  })

  // 新建收藏夹
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderPublic, setNewFolderPublic] = useState(false)
  const [creating, setCreating] = useState(false)

  const currentScopeRef = useRef({ viewerKey, sessionGeneration, userId })
  currentScopeRef.current = { viewerKey, sessionGeneration, userId }
  const requestIdsRef = useRef<Record<FolderLane, number>>({ my: 0, subscribed: 0 })
  const requestControllersRef = useRef<Partial<Record<FolderLane, AbortController>>>({})
  const createRequestIdRef = useRef(0)
  // Cache only validated successes and bind them to the stable viewer identity.
  // Token refreshes for one viewer keep the cache; account changes synchronously
  // hide it and reset both timestamps.
  const successCacheRef = useRef<{
    viewerKey: ViewerKey
    my: number | null
    subscribed: number | null
  }>({ viewerKey: 'pending', my: null, subscribed: null })

  const loadFolders = useCallback(
    async (force = false) => {
      if (
        !authChecked ||
        !accessToken ||
        !userId ||
        viewerKey === 'pending' ||
        viewerKey === 'anon'
      ) {
        return
      }

      const scope: RequestScope = { viewerKey, sessionGeneration, userId }
      const cachedAt =
        successCacheRef.current.viewerKey === viewerKey ? successCacheRef.current.my : null
      if (!force && cachedAt !== null && Date.now() - cachedAt < FOLDER_CACHE_TTL_MS) return

      requestControllersRef.current.my?.abort()
      const controller = new AbortController()
      requestControllersRef.current.my = controller
      const requestId = ++requestIdsRef.current.my
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, FOLDER_REQUEST_TIMEOUT_MS)
      setFoldersStatus('loading')

      try {
        const response = await fetch('/api/bookmark-folders', {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        })
        const nextFolders = await readFolderList(response, isBookmarkFolder)
        if (
          controller.signal.aborted ||
          requestIdsRef.current.my !== requestId ||
          !isRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          return
        }

        setFolders(nextFolders)
        setFoldersStatus('success')
        if (successCacheRef.current.viewerKey === viewerKey) {
          successCacheRef.current.my = Date.now()
        }
      } catch (error) {
        if (
          (!timedOut && controller.signal.aborted) ||
          requestIdsRef.current.my !== requestId ||
          !isRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          return
        }
        logger.error('Error fetching folders:', error)
        // Preserve this viewer's last-good list; an error must never become an
        // authoritative empty response or advance the success cache.
        setFoldersStatus('error')
      } finally {
        clearTimeout(timeoutId)
        if (requestControllersRef.current.my === controller) {
          delete requestControllersRef.current.my
        }
      }
    },
    [accessToken, authChecked, sessionGeneration, userId, viewerKey]
  )

  const loadSubscribedFolders = useCallback(
    async (force = false) => {
      if (
        !authChecked ||
        !accessToken ||
        !userId ||
        viewerKey === 'pending' ||
        viewerKey === 'anon'
      ) {
        return
      }

      const scope: RequestScope = { viewerKey, sessionGeneration, userId }
      const cachedAt =
        successCacheRef.current.viewerKey === viewerKey ? successCacheRef.current.subscribed : null
      if (!force && cachedAt !== null && Date.now() - cachedAt < FOLDER_CACHE_TTL_MS) return

      requestControllersRef.current.subscribed?.abort()
      const controller = new AbortController()
      requestControllersRef.current.subscribed = controller
      const requestId = ++requestIdsRef.current.subscribed
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, FOLDER_REQUEST_TIMEOUT_MS)
      setSubscribedStatus('loading')

      try {
        const response = await fetch('/api/bookmark-folders/subscribed', {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        })
        // The route's feature-unavailable contract is a 200 with an empty
        // folders array. A 404 indicates routing/deployment failure.
        const nextFolders = await readFolderList(response, isSubscribedFolder)
        if (
          controller.signal.aborted ||
          requestIdsRef.current.subscribed !== requestId ||
          !isRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          return
        }

        setSubscribedFolders(nextFolders)
        setSubscribedStatus('success')
        if (successCacheRef.current.viewerKey === viewerKey) {
          successCacheRef.current.subscribed = Date.now()
        }
      } catch (error) {
        if (
          (!timedOut && controller.signal.aborted) ||
          requestIdsRef.current.subscribed !== requestId ||
          !isRequestScopeCurrent(scope, currentScopeRef.current)
        ) {
          return
        }
        logger.warn('[Favorites] Failed to fetch subscribed folders:', error)
        setSubscribedStatus('error')
      } finally {
        clearTimeout(timeoutId)
        if (requestControllersRef.current.subscribed === controller) {
          delete requestControllersRef.current.subscribed
        }
      }
    },
    [accessToken, authChecked, sessionGeneration, userId, viewerKey]
  )

  useEffect(() => {
    const viewerChanged = successCacheRef.current.viewerKey !== viewerKey
    if (viewerChanged) {
      requestControllersRef.current.my?.abort()
      requestControllersRef.current.subscribed?.abort()
      requestIdsRef.current.my += 1
      requestIdsRef.current.subscribed += 1
      createRequestIdRef.current += 1
      successCacheRef.current = { viewerKey, my: null, subscribed: null }
      setDataViewerKey(viewerKey)
      setFolders([])
      setSubscribedFolders([])
      setFoldersStatus('idle')
      setSubscribedStatus('idle')
      setCreating(false)
      setShowCreateForm(false)
      setNewFolderName('')
      setNewFolderPublic(false)
    }

    if (
      !authChecked ||
      !accessToken ||
      !userId ||
      viewerKey === 'pending' ||
      viewerKey === 'anon'
    ) {
      return
    }

    void loadFolders(viewerChanged)
    void loadSubscribedFolders(viewerChanged)
  }, [accessToken, authChecked, loadFolders, loadSubscribedFolders, userId, viewerKey])

  useEffect(
    () => () => {
      requestControllersRef.current.my?.abort()
      requestControllersRef.current.subscribed?.abort()
      requestIdsRef.current.my += 1
      requestIdsRef.current.subscribed += 1
      createRequestIdRef.current += 1
    },
    []
  )

  const createFolder = async () => {
    if (
      !newFolderName.trim() ||
      !accessToken ||
      !userId ||
      viewerKey === 'pending' ||
      viewerKey === 'anon'
    ) {
      return
    }

    const scope: RequestScope = { viewerKey, sessionGeneration, userId }
    if (!isRequestScopeCurrent(scope, currentScopeRef.current)) return
    const requestId = ++createRequestIdRef.current
    setCreating(true)
    try {
      const response = await fetch('/api/bookmark-folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          name: newFolderName.trim(),
          is_public: newFolderPublic,
        }),
      })

      const data = await response.json()
      if (
        requestId !== createRequestIdRef.current ||
        !isRequestScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      if (response.ok) {
        // The pre-create GET can resolve after this write and overwrite an
        // optimistic append. Invalidate it and reload the authoritative list.
        requestControllersRef.current.my?.abort()
        requestIdsRef.current.my += 1
        if (successCacheRef.current.viewerKey === viewerKey) {
          successCacheRef.current.my = null
        }
        setNewFolderName('')
        setNewFolderPublic(false)
        setShowCreateForm(false)
        showToast(t('folderCreated'), 'success')
        void loadFolders(true)
      } else {
        showToast(data.error || t('createFailed'), 'error')
      }
    } catch (error) {
      if (
        requestId !== createRequestIdRef.current ||
        !isRequestScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      logger.error('Error creating folder:', error)
      showToast(t('createFailed'), 'error')
    } finally {
      if (
        requestId === createRequestIdRef.current &&
        isRequestScopeCurrent(scope, currentScopeRef.current)
      ) {
        setCreating(false)
      }
    }
  }

  const getDefaultAvatar = (name: string) => {
    const colors = [
      'var(--color-accent-error)',
      'var(--color-chart-teal)',
      'var(--color-chart-blue)',
      'var(--color-chart-sage)',
      'var(--color-chart-yellow)',
      'var(--color-chart-pink)',
      'var(--color-chart-mint)',
    ]
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

  // Embedded in /saved hub: the hub owns the page wrapper (min-height/bg) and
  // renders the h1 + tab bar, so suppress this page's own full-page chrome
  // (100vh wrapper, Breadcrumb, top-level PageHeader/title) to avoid stacked
  // duplicate headers + a wrong "Home › Favorites" breadcrumb.
  const outerStyle: React.CSSProperties = embedded
    ? { color: tokens.colors.text.primary }
    : {
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }
  const loginHref = embedded ? '/login?redirect=/saved?tab=posts' : '/login?redirect=/favorites'
  const viewerDataReady = dataViewerKey === viewerKey
  const visibleFolders = viewerDataReady ? folders : []
  const visibleSubscribedFolders = viewerDataReady ? subscribedFolders : []
  const activeStatus = activeTab === 'my' ? foldersStatus : subscribedStatus
  const activeFolderCount =
    activeTab === 'my' ? visibleFolders.length : visibleSubscribedFolders.length
  const panelLoading =
    !viewerDataReady ||
    activeStatus === 'idle' ||
    (activeStatus === 'loading' && activeFolderCount === 0)

  // 等待认证检查完成后再判断是否需要登录
  if (!authChecked) {
    return (
      <Box style={outerStyle}>
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          {!embedded && (
            <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
              {t('myFavorites')}
            </Text>
          )}
          <ListSkeleton count={5} gap={12} />
        </Box>
      </Box>
    )
  }

  if (authChecked && !accessToken) {
    return (
      <Box style={outerStyle}>
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          {!embedded && (
            <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
              {t('myFavorites')}
            </Text>
          )}
          <EmptyState
            title={t('pleaseLoginFirst')}
            description={t('loginToViewFavorites')}
            action={
              <Link
                href={loginHref}
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
                  fontWeight: tokens.typography.fontWeight.black,
                  fontSize: tokens.typography.fontSize.base,
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
    <Box style={outerStyle}>
      <Box
        className="has-mobile-nav"
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: embedded ? 0 : tokens.spacing[6],
          paddingBottom: 100,
          animation: 'fadeIn 0.3s ease-out',
        }}
      >
        {!embedded && <Breadcrumb items={[{ label: t('favorites') }]} />}
        {/* 页面头部 — embedded 时由 /saved hub 提供标题,故只保留 "+ 新建收藏夹"
            操作按钮(仍需可用),抑制重复的 "My Favorites" 标题避免堆叠。 */}
        {embedded ? (
          activeTab === 'my' && (
            <Box
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                marginBottom: tokens.spacing[3],
              }}
            >
              <Button
                variant="primary"
                size="sm"
                aria-label={t('newFolder')}
                onClick={() => setShowCreateForm(!showCreateForm)}
              >
                + {t('newFolder')}
              </Button>
            </Box>
          )
        ) : (
          <PageHeader
            title={t('myFavorites')}
            compact
            actions={
              activeTab === 'my' ? (
                <Button
                  variant="primary"
                  size="sm"
                  aria-label={t('newFolder')}
                  onClick={() => setShowCreateForm(!showCreateForm)}
                >
                  + {t('newFolder')}
                </Button>
              ) : undefined
            }
          />
        )}

        {/* 标签切换 */}
        <Box
          {...favTabsA11y.getTabListProps()}
          aria-label={t('myFavorites')}
          style={{
            display: 'flex',
            gap: tokens.spacing[1],
            marginBottom: tokens.spacing[6],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <button
            type="button"
            {...favTabsA11y.getTabProps('my')}
            onClick={() => setActiveTab('my')}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              minHeight: 44,
              background: 'transparent',
              border: 'none',
              borderBottom:
                activeTab === 'my'
                  ? `2px solid ${tokens.colors.accent?.primary || tokens.colors.accent.brand}`
                  : '2px solid transparent',
              color: activeTab === 'my' ? tokens.colors.text.primary : tokens.colors.text.tertiary,
              fontWeight:
                activeTab === 'my'
                  ? tokens.typography.fontWeight.bold
                  : tokens.typography.fontWeight.normal,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              marginBottom: -1,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('myFoldersTab')} ({visibleFolders.length})
          </button>
          <button
            type="button"
            {...favTabsA11y.getTabProps('subscribed')}
            onClick={() => setActiveTab('subscribed')}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              minHeight: 44,
              background: 'transparent',
              border: 'none',
              borderBottom:
                activeTab === 'subscribed'
                  ? `2px solid ${tokens.colors.accent?.primary || tokens.colors.accent.brand}`
                  : '2px solid transparent',
              color:
                activeTab === 'subscribed'
                  ? tokens.colors.text.primary
                  : tokens.colors.text.tertiary,
              fontWeight:
                activeTab === 'subscribed'
                  ? tokens.typography.fontWeight.bold
                  : tokens.typography.fontWeight.normal,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              marginBottom: -1,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('subscribedFoldersTab')} ({visibleSubscribedFolders.length})
          </button>
        </Box>

        {/* 新建收藏夹表单 */}
        {viewerDataReady && showCreateForm && (
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
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                marginBottom: tokens.spacing[3],
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  cursor: 'pointer',
                }}
              >
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
        <div {...favTabsA11y.getSharedPanelProps()}>
          {viewerDataReady && activeTab === 'my' && foldersStatus === 'error' && (
            <ErrorState
              title={t('loadFoldersFailed')}
              description={t('loadFoldersFailedRetry')}
              retry={() => void loadFolders(true)}
              variant="compact"
            />
          )}
          {viewerDataReady && activeTab === 'subscribed' && subscribedStatus === 'error' && (
            <ErrorState
              title={t('loadFoldersFailed')}
              description={t('loadFoldersFailedRetry')}
              retry={() => void loadSubscribedFolders(true)}
              variant="compact"
            />
          )}
          {panelLoading ? (
            <ListSkeleton count={5} gap={12} />
          ) : activeTab === 'my' ? (
            // 我的收藏夹
            visibleFolders.length === 0 ? (
              foldersStatus === 'success' ? (
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
                        fontWeight: tokens.typography.fontWeight.bold,
                        fontSize: tokens.typography.fontSize.base,
                      }}
                    >
                      + {t('newFolder')}
                    </button>
                  }
                />
              ) : null
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {visibleFolders.map((folder) => (
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
                      e.currentTarget.style.background =
                        tokens.colors.bg.tertiary || 'var(--overlay-hover)'
                      e.currentTarget.style.borderColor =
                        tokens.colors.border.secondary || tokens.colors.border.primary
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
                        backgroundColor: folder.avatar_url
                          ? undefined
                          : getDefaultAvatar(folder.name),
                        backgroundImage: folder.avatar_url
                          ? `url(${folder.avatar_url})`
                          : undefined,
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
                          {(folder.is_default ? t('defaultFolderName') : folder.name)
                            .charAt(0)
                            .toUpperCase()}
                        </Text>
                      )}
                    </Box>

                    {/* 收藏夹信息 */}
                    <Box style={{ flex: 1 }}>
                      <Box
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: tokens.spacing[2],
                          marginBottom: tokens.spacing[1],
                          flexWrap: 'wrap',
                        }}
                      >
                        <Text size="base" weight="bold">
                          {folder.is_default ? t('defaultFolderName') : folder.name}
                        </Text>
                        {folder.is_default && (
                          <span
                            style={{
                              // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
                              fontSize: 10,
                              padding: '2px 6px',
                              background: alpha(tokens.colors.accent.primary, 13),
                              color: tokens.colors.accent.primary,
                              borderRadius: tokens.radius.sm,
                            }}
                          >
                            {t('defaultLabel')}
                          </span>
                        )}
                        {folder.is_public ? (
                          <span
                            style={{
                              // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
                              fontSize: 10,
                              padding: '2px 6px',
                              background: alpha(tokens.colors.accent.success, 13),
                              color: tokens.colors.accent.success,
                              borderRadius: tokens.radius.sm,
                            }}
                          >
                            {t('publicFolder')}
                          </span>
                        ) : (
                          <span
                            style={{
                              // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
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
                        <Text
                          size="sm"
                          color="secondary"
                          style={{ marginBottom: tokens.spacing[1] }}
                        >
                          {folder.description}
                        </Text>
                      )}
                      <Text size="xs" color="tertiary">
                        {t('itemCount').replace('{n}', String(folder.post_count ?? 0))}
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
          ) : // 收藏的收藏夹
          visibleSubscribedFolders.length === 0 ? (
            subscribedStatus === 'success' ? (
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
                      fontWeight: tokens.typography.fontWeight.bold,
                      fontSize: tokens.typography.fontSize.base,
                    }}
                  >
                    {t('browsePublicFolders')}
                  </Link>
                }
              />
            ) : null
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {visibleSubscribedFolders.map((folder) => (
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
                    e.currentTarget.style.background =
                      tokens.colors.bg.tertiary || 'var(--overlay-hover)'
                    e.currentTarget.style.borderColor =
                      tokens.colors.border.secondary || tokens.colors.border.primary
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
                      backgroundColor: folder.avatar_url
                        ? undefined
                        : getDefaultAvatar(folder.name),
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
                    <Box
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        marginBottom: tokens.spacing[1],
                      }}
                    >
                      <Text size="base" weight="bold">
                        {folder.name}
                      </Text>
                      <span
                        style={{
                          // eslint-disable-next-line no-restricted-syntax -- off-scale micro badge by design
                          fontSize: 10,
                          padding: '2px 6px',
                          background: alpha(tokens.colors.accent.warning, 13),
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
                      {t('itemCount').replace('{n}', String(folder.post_count ?? 0))}
                      {folder.subscriber_count > 0 &&
                        ` · ${t('subscriberCount').replace('{n}', String(folder.subscriber_count))}`}
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
          )}
        </div>
      </Box>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}
