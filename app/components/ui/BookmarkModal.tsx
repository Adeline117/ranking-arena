'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { getCsrfHeaders } from '@/lib/api/client'
import { useToast } from './Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { logger } from '@/lib/logger'

type BookmarkFolder = {
  id: string
  name: string
  description?: string
  avatar_url?: string
  is_public: boolean
  is_default: boolean
  post_count: number
}

interface BookmarkModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (folderId: string) => void
  postId: string
}

export default function BookmarkModal({ isOpen, onClose, onSelect, postId: _postId }: BookmarkModalProps) {
  const { showToast } = useToast()
  const { accessToken, authChecked } = useAuthSession()
  const { t } = useLanguage()
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderPublic, setNewFolderPublic] = useState(true)
  const modalRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)

  useEffect(() => {
    if (isOpen && authChecked && accessToken) {
      loadFolders()
    }
    if (!isOpen) {
      setShowCreateForm(false)
      setNewFolderName('')
      setNewFolderPublic(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFolders is defined in closure, not a stable ref
  }, [isOpen, authChecked, accessToken])

  useEffect(() => {
    if (!isOpen) return

    triggerRef.current = document.activeElement
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Focus first focusable element
    requestAnimationFrame(() => {
      if (modalRef.current) {
        const first = modalRef.current.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        first?.focus()
      }
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = originalOverflow
      document.removeEventListener('keydown', handleKeyDown)
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
      }
    }
  }, [isOpen, onClose])

  const loadFolders = async () => {
    setLoading(true)

    try {
      if (!accessToken) {
        setFolders([])
        return
      }

      const response = await fetch('/api/bookmark-folders', {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      })

      if (response.status === 401) {
        setFolders([])
        return
      }

      if (!response.ok) {
        showToast(t('loadBookmarksFailed'), 'error')
        setFolders([])
        return
      }

      const data = await response.json()
      setFolders(data.data?.folders || data.folders || [])
    } catch (error) {
      logger.error('Load bookmarks failed:', error)
      showToast(t('loadBookmarksFailed'), 'error')
      setFolders([])
    } finally {
      setLoading(false)
    }
  }

  const createFolder = async () => {
    if (!newFolderName.trim() || !accessToken) return

    setCreating(true)
    try {
      const response = await fetch('/api/bookmark-folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          name: newFolderName.trim(),
          is_public: newFolderPublic
        })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: t('createFailed') }))
        showToast(data.error?.message || data.error || t('createFailed'), 'error')
        return
      }

      const data = await response.json()
      const newFolder = data.data?.folder || data.folder
      if (newFolder) {
        setFolders(prev => [...prev, newFolder])
      }
      setNewFolderName('')
      setNewFolderPublic(true)
      setShowCreateForm(false)
      showToast(t('bookmarkFolderCreated'), 'success')
    } catch (error) {
      logger.error('Create bookmark folder failed:', error)
      showToast(t('createFailed'), 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleSelectFolder = (folderId: string) => {
    onSelect(folderId)
    onClose()
  }

  const getDefaultAvatar = (name: string) => {
    const colors = ['var(--color-accent-error)', 'var(--color-chart-teal)', 'var(--color-chart-blue)', 'var(--color-chart-sage)', 'var(--color-chart-yellow)', 'var(--color-chart-pink)', 'var(--color-chart-mint)']
    const index = name.charCodeAt(0) % colors.length
    return colors[index]
  }

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
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3], display: 'block' }}>
            {t('bookmarkTo')}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4], display: 'block' }}>
            {t('loginToBookmark') || 'Log in to save bookmarks'}
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
              {t('login') || 'Log In'}
            </Button>
            <Button variant="text" size="sm" onClick={onClose}>
              {t('cancel') || 'Cancel'}
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
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Text size="lg" weight="bold">{t('bookmarkTo')}</Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <Button
              variant="text"
              size="sm"
              onClick={() => setShowCreateForm(!showCreateForm)}
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
                fontSize: 20,
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
          <Box style={{
            marginBottom: tokens.spacing[4],
            padding: tokens.spacing[3],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}>
            <input
              type="text"
              aria-label={t('bookmarkFolderName')}
              placeholder={t('bookmarkFolderName')}
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
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], cursor: 'pointer' }}>
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

        {loading ? (
          <Text size="sm" color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
            {t('loading')}
          </Text>
        ) : folders.length === 0 ? (
          <Text size="sm" color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
            {t('noBookmarkFolders')}
          </Text>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            {folders.filter(folder => folder && folder.id && folder.name).map((folder) => (
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
                    backgroundColor: folder?.avatar_url ? undefined : getDefaultAvatar(folder?.name || ''),
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
                    <Text size="sm" weight="semibold">{folder.name}</Text>
                    {folder.is_default && (
                      <span style={{
                        fontSize: 12,
                        padding: '2px 6px',
                        background: tokens.colors.accent?.primary + '20',
                        color: tokens.colors.accent?.primary,
                        borderRadius: tokens.radius.sm,
                      }}>
                        {t('defaultLabel')}
                      </span>
                    )}
                    {folder.is_public && (
                      <span style={{
                        fontSize: 12,
                        padding: '2px 6px',
                        background: 'var(--color-accent-success-20)',
                        color: 'var(--color-accent-success)',
                        borderRadius: tokens.radius.sm,
                      }}>
                        {t('publicLabel')}
                      </span>
                    )}
                  </Box>
                  <Text size="xs" color="tertiary">{t('bookmarkItems').replace('{count}', String(folder.post_count || 0))}</Text>
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
