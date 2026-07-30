'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { Box, Text, Button } from '../base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from './Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'
import ErrorState from './ErrorState'
import type { ViewerKey } from '@/lib/auth/viewer-scope'

type BookmarkFolder = {
  id: string
  name: string
  description?: string | null
  avatar_url?: string | null
  is_public: boolean
  is_default: boolean
  post_count: number
}

type BookmarkModalScope = {
  viewerKey: ViewerKey
  sessionGeneration: number
  userId: string
}

const BOOKMARK_MODAL_TIMEOUT_MS = 15_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isBookmarkFolder(value: unknown): value is BookmarkFolder {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    value.name.length <= 50 &&
    (value.description === undefined ||
      value.description === null ||
      typeof value.description === 'string') &&
    (value.avatar_url === undefined ||
      value.avatar_url === null ||
      typeof value.avatar_url === 'string') &&
    typeof value.is_public === 'boolean' &&
    typeof value.is_default === 'boolean' &&
    Number.isSafeInteger(value.post_count) &&
    Number(value.post_count) >= 0
  )
}

function isScopeCurrent(
  expected: BookmarkModalScope,
  current: {
    viewerKey: ViewerKey
    sessionGeneration: number
    userId: string | null
  }
): boolean {
  return (
    expected.viewerKey === current.viewerKey &&
    expected.sessionGeneration === current.sessionGeneration &&
    expected.userId === current.userId
  )
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  if (typeof payload.error === 'string') return payload.error
  if (isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message
  }
  return fallback
}

interface BookmarkModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (folderId: string) => void
  postId: string
}

export default function BookmarkModal({
  isOpen,
  onClose,
  onSelect,
  postId: _postId,
}: BookmarkModalProps) {
  const { showToast } = useToast()
  const { accessToken, authChecked, userId, viewerKey, sessionGeneration } = useAuthSession()
  const { t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderPublic, setNewFolderPublic] = useState(true)
  const [dataViewerKey, setDataViewerKey] = useState<ViewerKey>('pending')
  const modalRef = useRef<HTMLDivElement>(null)
  const currentScopeRef = useRef({ viewerKey, sessionGeneration, userId })
  currentScopeRef.current = { viewerKey, sessionGeneration, userId }
  const stateViewerKeyRef = useRef<ViewerKey>(viewerKey)
  const loadRequestIdRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const createRequestIdRef = useRef(0)
  const createControllerRef = useRef<AbortController | null>(null)

  const loadFolders = useCallback(async () => {
    if (!accessToken || !userId || viewerKey === 'pending' || viewerKey === 'anon') {
      return
    }
    const scope: BookmarkModalScope = { viewerKey, sessionGeneration, userId }
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    const requestId = ++loadRequestIdRef.current
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, BOOKMARK_MODAL_TIMEOUT_MS)
    setLoading(true)
    setLoadFailed(false)
    setFolders([])

    try {
      const response = await fetch('/api/bookmark-folders', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      })
      if (
        controller.signal.aborted ||
        loadRequestIdRef.current !== requestId ||
        !isScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }

      if (response.status === 401) {
        setLoadFailed(true)
        setDataViewerKey(viewerKey)
        return
      }

      if (!response.ok) {
        showToast(tRef.current('loadBookmarksFailed'), 'error')
        setLoadFailed(true)
        setDataViewerKey(viewerKey)
        return
      }

      const data: unknown = await response.json()
      if (
        controller.signal.aborted ||
        loadRequestIdRef.current !== requestId ||
        !isScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      const loadedFolders = isRecord(data)
        ? isRecord(data.data)
          ? data.data.folders
          : data.folders
        : null
      if (
        !Array.isArray(loadedFolders) ||
        !loadedFolders.every(isBookmarkFolder) ||
        new Set(loadedFolders.map((folder) => folder.id)).size !== loadedFolders.length
      ) {
        throw new Error('Bookmark folders response is missing a folders array')
      }
      setFolders(loadedFolders)
      setDataViewerKey(viewerKey)
    } catch (error) {
      if (
        (!timedOut && controller.signal.aborted) ||
        loadRequestIdRef.current !== requestId ||
        !isScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      logger.error('Load bookmarks failed:', error)
      showToast(tRef.current('loadBookmarksFailed'), 'error')
      setLoadFailed(true)
      setDataViewerKey(viewerKey)
    } finally {
      clearTimeout(timeoutId)
      if (
        loadRequestIdRef.current === requestId &&
        isScopeCurrent(scope, currentScopeRef.current)
      ) {
        setLoading(false)
      }
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null
      }
    }
  }, [accessToken, sessionGeneration, showToast, userId, viewerKey])

  useEffect(() => {
    const viewerChanged = stateViewerKeyRef.current !== viewerKey
    if (viewerChanged) {
      stateViewerKeyRef.current = viewerKey
      loadControllerRef.current?.abort()
      createControllerRef.current?.abort()
      loadRequestIdRef.current += 1
      createRequestIdRef.current += 1
      setFolders([])
      setLoading(true)
      setLoadFailed(false)
      setCreating(false)
      setShowCreateForm(false)
      setNewFolderName('')
      setNewFolderPublic(true)
      setDataViewerKey('pending')
    }

    if (!isOpen) {
      loadControllerRef.current?.abort()
      createControllerRef.current?.abort()
      loadRequestIdRef.current += 1
      createRequestIdRef.current += 1
      setFolders([])
      setLoading(true)
      setLoadFailed(false)
      setCreating(false)
      setShowCreateForm(false)
      setNewFolderName('')
      setNewFolderPublic(true)
      setDataViewerKey(viewerKey)
      return
    }

    if (authChecked && accessToken && userId) void loadFolders()

    return () => {
      loadControllerRef.current?.abort()
    }
  }, [accessToken, authChecked, isOpen, loadFolders, userId, viewerKey])

  useEffect(
    () => () => {
      loadControllerRef.current?.abort()
      createControllerRef.current?.abort()
      loadRequestIdRef.current += 1
      createRequestIdRef.current += 1
    },
    []
  )

  useModalA11y({ open: isOpen, onClose, modalRef })

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

    const scope: BookmarkModalScope = { viewerKey, sessionGeneration, userId }
    const folderName = newFolderName.trim()
    const folderIsPublic = newFolderPublic
    createControllerRef.current?.abort()
    const controller = new AbortController()
    createControllerRef.current = controller
    const requestId = ++createRequestIdRef.current
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, BOOKMARK_MODAL_TIMEOUT_MS)
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
          name: folderName,
          is_public: folderIsPublic,
        }),
        signal: controller.signal,
      })
      const data: unknown = await response.json().catch(() => null)
      if (
        controller.signal.aborted ||
        createRequestIdRef.current !== requestId ||
        !isScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }

      if (!response.ok) {
        showToast(apiErrorMessage(data, tRef.current('createFailed')), 'error')
        return
      }

      const newFolder = isRecord(data)
        ? isRecord(data.data)
          ? data.data.folder
          : data.folder
        : null
      if (!isBookmarkFolder(newFolder)) {
        throw new Error('Create bookmark folder returned an invalid payload')
      }
      setFolders((currentFolders) =>
        currentFolders.some((folder) => folder.id === newFolder.id)
          ? currentFolders
          : [...currentFolders, newFolder]
      )
      setNewFolderName('')
      setNewFolderPublic(true)
      setShowCreateForm(false)
      showToast(tRef.current('bookmarkFolderCreated'), 'success')
    } catch (error) {
      if (
        (!timedOut && controller.signal.aborted) ||
        createRequestIdRef.current !== requestId ||
        !isScopeCurrent(scope, currentScopeRef.current)
      ) {
        return
      }
      logger.error('Create bookmark folder failed:', error)
      showToast(tRef.current('createFailed'), 'error')
    } finally {
      clearTimeout(timeoutId)
      if (
        createRequestIdRef.current === requestId &&
        isScopeCurrent(scope, currentScopeRef.current)
      ) {
        setCreating(false)
      }
      if (createControllerRef.current === controller) {
        createControllerRef.current = null
      }
    }
  }

  const handleSelectFolder = (folderId: string) => {
    onSelect(folderId)
    onClose()
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

  const viewerDataReady = dataViewerKey === viewerKey
  const visibleFolders = viewerDataReady ? folders : []
  const foldersLoading = loading || !viewerDataReady

  if (!isOpen || typeof document === 'undefined') return null

  // Show login prompt when user is not authenticated
  if (authChecked && !accessToken) {
    const loginPromptContent = (
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
          role="dialog"
          aria-modal="true"
          aria-label={t('bookmarkSelectFolder')}
          style={{
            background: tokens.colors.bg.primary,
            borderRadius: tokens.radius.xl,
            padding: tokens.spacing[6],
            width: '90%',
            maxWidth: 400,
            border: `1px solid ${tokens.colors.border.primary}`,
            textAlign: 'center',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Text
            size="lg"
            weight="bold"
            style={{ marginBottom: tokens.spacing[3], display: 'block' }}
          >
            {t('bookmarkTo')}
          </Text>
          <Text
            size="sm"
            color="tertiary"
            style={{ marginBottom: tokens.spacing[4], display: 'block' }}
          >
            {t('loginToBookmark')}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2], justifyContent: 'center' }}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                onClose()
                useLoginModal.getState().openLoginModal()
              }}
            >
              {t('login')}
            </Button>
            <Button variant="text" size="sm" onClick={onClose}>
              {t('cancel')}
            </Button>
          </Box>
        </Box>
      </Box>
    )
    return createPortal(loginPromptContent, document.body)
  }

  const modalContent = (
    <Box
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'var(--color-backdrop)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 'max(10vh, env(safe-area-inset-top, 40px))',
        zIndex: tokens.zIndex.modal,
        overflowY: 'auto',
      }}
      onClick={onClose}
      ref={modalRef}
    >
      <Box
        role="dialog"
        aria-modal="true"
        aria-label={t('bookmarkSelectFolder')}
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: '90%',
          maxWidth: 400,
          maxHeight: '80vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[4],
          }}
        >
          <Text size="lg" weight="bold">
            {t('bookmarkTo')}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <Button
              variant="text"
              size="sm"
              onClick={() => setShowCreateForm(!showCreateForm)}
              disabled={foldersLoading || loadFailed}
              style={{ color: tokens.colors.accent?.primary }}
            >
              {t('newBookmarkFolder')}
            </Button>
            <button
              aria-label="Close"
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: tokens.typography.fontSize.xl,
                cursor: 'pointer',
                color: tokens.colors.text.tertiary,
                minWidth: 44,
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </Box>
        </Box>

        {showCreateForm && (
          <Box
            style={{
              marginBottom: tokens.spacing[4],
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
            }}
          >
            <input
              type="text"
              aria-label={t('bookmarkFolderName')}
              placeholder={t('bookmarkFolderName')}
              maxLength={50}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              style={{
                width: '100%',
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                marginBottom: tokens.spacing[2],
              }}
            />
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                marginBottom: tokens.spacing[2],
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[1],
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={newFolderPublic}
                  onChange={(e) => setNewFolderPublic(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                <Text size="sm">{t('publicUncheckForPrivate')}</Text>
              </label>
            </Box>
            <Button
              variant="primary"
              size="sm"
              onClick={createFolder}
              disabled={creating || !newFolderName.trim()}
              style={{ width: '100%' }}
            >
              {creating ? t('creating') : t('create')}
            </Button>
          </Box>
        )}

        {foldersLoading ? (
          <Text
            size="sm"
            color="tertiary"
            style={{ textAlign: 'center', padding: tokens.spacing[4] }}
          >
            {t('loading')}
          </Text>
        ) : loadFailed ? (
          <ErrorState title={t('loadBookmarksFailed')} retry={loadFolders} variant="compact" />
        ) : visibleFolders.length === 0 ? (
          <Text
            size="sm"
            color="tertiary"
            style={{ textAlign: 'center', padding: tokens.spacing[4] }}
          >
            {t('noBookmarkFolders')}
          </Text>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {visibleFolders.map((folder) => (
              <Box
                key={folder.id}
                role="button"
                tabIndex={0}
                aria-label={folder.name}
                onClick={() => handleSelectFolder(folder.id)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleSelectFolder(folder.id)
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  cursor: 'pointer',
                  transition: `background ${tokens.transition.base}`,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <Box
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: tokens.radius.md,
                    backgroundColor: folder?.avatar_url
                      ? undefined
                      : getDefaultAvatar(folder?.name || ''),
                    backgroundImage: folder?.avatar_url ? `url(${folder.avatar_url})` : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {!folder?.avatar_url && folder?.name && (
                    <Text size="lg" weight="bold" style={{ color: tokens.colors.white }}>
                      {folder.name.charAt(0)}
                    </Text>
                  )}
                </Box>

                <Box style={{ flex: 1 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                    <Text size="sm" weight="semibold">
                      {folder.name}
                    </Text>
                    {folder.is_default && (
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          padding: '2px 6px',
                          background: tokens.colors.accent?.primary + '20',
                          color: tokens.colors.accent?.primary,
                          borderRadius: tokens.radius.sm,
                        }}
                      >
                        {t('defaultLabel')}
                      </span>
                    )}
                    {folder.is_public && (
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          padding: '2px 6px',
                          background: 'var(--color-accent-success-20)',
                          color: 'var(--color-accent-success)',
                          borderRadius: tokens.radius.sm,
                        }}
                      >
                        {t('publicLabel')}
                      </span>
                    )}
                  </Box>
                  <Text size="xs" color="tertiary">
                    {t('bookmarkItems').replace('{count}', String(folder.post_count || 0))}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )

  return createPortal(modalContent, document.body)
}
