'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { authedFetch } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import {
  readCollectionItemAddAcknowledgement,
  readCollectionListAcknowledgement,
  readCollectionUuid,
  type CollectionItemType,
  type CollectionSummary,
} from '@/lib/collections/client-contract'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'

interface AddToCollectionButtonProps {
  itemType: CollectionItemType
  itemId: string
  /** Optional compact style */
  compact?: boolean
}

type CollectionOperation = {
  controller: AbortController
  resourceScopeKey: string
  viewer: SettingsViewerSnapshot
}

type CollectionAddOperation = CollectionOperation & {
  collectionId: string
}

export default function AddToCollectionButton({
  itemType,
  itemId,
  compact,
}: AddToCollectionButtonProps) {
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const { t } = useLanguage()
  const { showToast } = useToast()
  const canonicalItemId = readCollectionUuid(itemId)
  const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${itemType}\u0000${canonicalItemId ?? itemId}`
  const resourceScopeKeyRef = useRef(resourceScopeKey)
  resourceScopeKeyRef.current = resourceScopeKey

  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<CollectionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)
  const openRef = useRef(false)
  const loadOperationRef = useRef<CollectionOperation | null>(null)
  const addOperationRef = useRef<CollectionAddOperation | null>(null)

  const operationIsCurrent = useCallback(
    (operation: CollectionOperation): boolean =>
      mountedRef.current &&
      resourceScopeKeyRef.current === operation.resourceScopeKey &&
      isSettingsViewerCurrent(operation.viewer, authRef.current),
    []
  )

  const captureViewer = useCallback((): SettingsViewerSnapshot | null => {
    const viewer = captureSettingsViewer(authRef.current)
    return viewer && resourceScopeKeyRef.current === resourceScopeKey ? viewer : null
  }, [resourceScopeKey])

  const closeMenu = useCallback(() => {
    openRef.current = false
    loadOperationRef.current?.controller.abort()
    addOperationRef.current?.controller.abort()
    loadOperationRef.current = null
    addOperationRef.current = null
    setOpen(false)
    setLoading(false)
    setAdding(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadOperationRef.current?.controller.abort()
      addOperationRef.current?.controller.abort()
      loadOperationRef.current = null
      addOperationRef.current = null
    }
  }, [])

  useEffect(() => {
    closeMenu()
    setCollections([])
    setLoadError(false)
  }, [closeMenu, resourceScopeKey])

  // Close on outside click and invalidate work so a hidden menu cannot emit a late toast.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeMenu()
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [closeMenu, open])

  const loadCollections = useCallback(async () => {
    if (loadOperationRef.current || addOperationRef.current) return
    const viewer = captureViewer()
    if (!viewer) {
      showToast(t('collectionLoginFirst'), 'error')
      return
    }
    if (!canonicalItemId) {
      showToast(t('collectionAddFailed'), 'error')
      return
    }

    const operation: CollectionOperation = {
      controller: new AbortController(),
      resourceScopeKey,
      viewer,
    }
    loadOperationRef.current = operation
    openRef.current = true
    setOpen(true)
    setLoading(true)
    setLoadError(false)
    try {
      const result = await authedFetch<unknown>(
        '/api/collections',
        'GET',
        viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (
        result.stale ||
        loadOperationRef.current !== operation ||
        !openRef.current ||
        !operationIsCurrent(operation)
      ) {
        return
      }
      const nextCollections = result.ok
        ? readCollectionListAcknowledgement(result.data, viewer.userId)
        : null
      if (!nextCollections) throw new Error(`Collection list failed (${result.status})`)
      setCollections(nextCollections)
      setLoadError(false)
    } catch (error) {
      if (
        !operation.controller.signal.aborted &&
        loadOperationRef.current === operation &&
        openRef.current &&
        operationIsCurrent(operation)
      ) {
        logger.error('Failed to load collections', error)
        setLoadError(true)
      }
    } finally {
      if (loadOperationRef.current === operation) {
        loadOperationRef.current = null
        if (operationIsCurrent(operation)) setLoading(false)
      }
    }
  }, [canonicalItemId, captureViewer, operationIsCurrent, resourceScopeKey, showToast, t])

  const addToCollection = useCallback(
    async (requestedCollectionId: string) => {
      if (addOperationRef.current || loadOperationRef.current || !openRef.current) return
      const viewer = captureViewer()
      const collectionId = readCollectionUuid(requestedCollectionId)
      if (!viewer || !canonicalItemId || !collectionId) {
        showToast(t('collectionAddFailed'), 'error')
        return
      }

      const operation: CollectionAddOperation = {
        collectionId,
        controller: new AbortController(),
        resourceScopeKey,
        viewer,
      }
      addOperationRef.current = operation
      setAdding(collectionId)
      try {
        const result = await authedFetch<unknown>(
          `/api/collections/${collectionId}/items`,
          'POST',
          viewer.accessToken,
          { item_type: itemType, item_id: canonicalItemId },
          15_000,
          {
            expectedUserId: viewer.userId,
            expectedSessionGeneration: viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (
          result.stale ||
          addOperationRef.current !== operation ||
          !openRef.current ||
          !operationIsCurrent(operation)
        ) {
          return
        }
        if (result.status === 409) {
          showToast(t('collectionAlreadyIn'), 'info')
          return
        }
        const acknowledgement = result.ok
          ? readCollectionItemAddAcknowledgement(result.data, {
              actorId: viewer.userId,
              collectionId,
              itemId: canonicalItemId,
              itemType,
            })
          : null
        if (!acknowledgement) throw new Error(`Collection add failed (${result.status})`)

        setCollections((current) =>
          current.map((collection) =>
            collection.id === collectionId
              ? { ...collection, item_count: collection.item_count + 1 }
              : collection
          )
        )
        showToast(t('collectionAddedSuccess'), 'success')
        closeMenu()
      } catch (error) {
        if (
          !operation.controller.signal.aborted &&
          addOperationRef.current === operation &&
          openRef.current &&
          operationIsCurrent(operation)
        ) {
          logger.error('Failed to add to collection', error)
          showToast(t('collectionAddFailed'), 'error')
        }
      } finally {
        if (addOperationRef.current === operation) {
          addOperationRef.current = null
          if (operationIsCurrent(operation)) setAdding(null)
        }
      }
    },
    [
      canonicalItemId,
      captureViewer,
      closeMenu,
      itemType,
      operationIsCurrent,
      resourceScopeKey,
      showToast,
      t,
    ]
  )

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => {
          if (loadOperationRef.current || addOperationRef.current) return
          if (openRef.current) closeMenu()
          else void loadCollections()
        }}
        aria-label={t('collectionSaveTo')}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-busy={loading}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 44,
          padding: compact ? '6px 10px' : '8px 16px',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md,
          color: tokens.colors.text.primary,
          fontSize: compact ? tokens.typography.fontSize.xs : tokens.typography.fontSize.base,
          fontWeight: tokens.typography.fontWeight.semibold,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.borderColor =
            tokens.colors.accent?.primary || tokens.colors.accent.brand
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.borderColor = tokens.colors.border.primary
        }}
      >
        <span style={{ fontSize: compact ? 14 : 16 }}>★</span>
        {!compact && t('collectionSaveTo')}
      </button>

      {open && (
        <Box
          role="menu"
          className="dropdown-enter"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            width: 240,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            boxShadow: tokens.shadow.lg,
            zIndex: tokens.zIndex.dropdown,
            overflow: 'hidden',
          }}
        >
          <Box
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="sm" weight="bold">
              {t('collectionChoose')}
            </Text>
          </Box>

          {loading && collections.length === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }} role="status">
              <Text size="sm" color="tertiary">
                {t('collectionLoading')}
              </Text>
            </Box>
          ) : (
            <>
              {loadError && (
                <Box
                  role="alert"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <Text size="xs" color="tertiary" style={{ flex: 1 }}>
                    {t('operationFailed')}
                  </Text>
                  <button
                    type="button"
                    onClick={() => void loadCollections()}
                    style={{
                      minWidth: 64,
                      minHeight: 44,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      borderRadius: tokens.radius.md,
                      background: tokens.colors.bg.tertiary,
                      color: tokens.colors.text.primary,
                      cursor: 'pointer',
                    }}
                  >
                    {t('retry')}
                  </button>
                </Box>
              )}
              {loading && collections.length > 0 && (
                <Box style={{ padding: tokens.spacing[2], textAlign: 'center' }} role="status">
                  <Text size="xs" color="tertiary">
                    {t('collectionLoading')}
                  </Text>
                </Box>
              )}
              {!loadError && collections.length === 0 ? (
                <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  <Text size="sm" color="tertiary">
                    {t('collectionEmpty')}
                  </Text>
                </Box>
              ) : collections.length > 0 ? (
                <Box style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {collections.map((collection) => (
                    <button
                      key={collection.id}
                      type="button"
                      role="menuitem"
                      onClick={() => void addToCollection(collection.id)}
                      disabled={adding !== null || loading}
                      aria-busy={adding === collection.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        width: '100%',
                        minHeight: 44,
                        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.primary,
                        fontSize: tokens.typography.fontSize.sm,
                        cursor: adding !== null || loading ? 'wait' : 'pointer',
                        textAlign: 'left',
                        transition: `background ${tokens.transition.base}`,
                        opacity: adding === collection.id ? 0.5 : 1,
                      }}
                      onMouseEnter={(event) => {
                        if (adding === null && !loading) {
                          event.currentTarget.style.background =
                            tokens.colors.bg.tertiary || 'var(--overlay-hover)'
                        }
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <span style={{ flexShrink: 0 }}>📁</span>
                      <span
                        style={{
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {collection.name}
                      </span>
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: tokens.colors.text.tertiary,
                        }}
                      >
                        {collection.item_count}
                      </span>
                    </button>
                  ))}
                </Box>
              ) : null}
            </>
          )}
        </Box>
      )}
    </div>
  )
}
