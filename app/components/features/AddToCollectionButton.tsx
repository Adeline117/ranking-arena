'use client'

import { useState, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'

interface Collection {
  id: string
  name: string
  item_count: number
}

interface AddToCollectionButtonProps {
  itemType: 'trader' | 'book' | 'post'
  itemId: string
  /** Optional compact style */
  compact?: boolean
}

export default function AddToCollectionButton({ itemType, itemId, compact }: AddToCollectionButtonProps) {
  const { accessToken } = useAuthSession()
  const { t } = useLanguage()
  const { showToast } = useToast()

  const [open, setOpen] = useState(false)
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const loadCollections = async () => {
    if (!accessToken) {
      showToast(t('collectionLoginFirst'), 'error')
      return
    }
    setOpen(true)
    setLoading(true)
    try {
      const res = await fetch('/api/collections', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })
      const data = await res.json()
      if (res.ok) setCollections(data.data?.collections || [])
    } catch (err) {
      logger.error('Failed to load collections', err)
    } finally {
      setLoading(false)
    }
  }

  const addToCollection = async (collectionId: string) => {
    setAdding(collectionId)
    try {
      const res = await fetch(`/api/collections/${collectionId}/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ item_type: itemType, item_id: itemId }),
      })
      const data = await res.json()
      if (res.ok) {
        showToast(t('collectionAddedSuccess'), 'success')
        setOpen(false)
      } else if (res.status === 409) {
        showToast(t('collectionAlreadyIn'), 'info')
      } else {
        showToast(data.data?.error || 'Failed', 'error')
      }
    } catch (err) {
      logger.error('Failed to add to collection', err)
      showToast(t('collectionAddFailed'), 'error')
    } finally {
      setAdding(null)
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => open ? setOpen(false) : loadCollections()}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: compact ? '6px 10px' : '8px 16px',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md,
          color: tokens.colors.text.primary,
          fontSize: compact ? 12 : 14,
          fontWeight: 600,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = tokens.colors.accent?.primary || tokens.colors.accent.brand }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary }}
      >
        <span style={{ fontSize: compact ? 14 : 16 }}>★</span>
        {!compact && t('collectionSaveTo')}
      </button>

      {open && (
        <Box className="dropdown-enter" style={{
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
        }}>
          <Box style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`, borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
            <Text size="sm" weight="bold">
              {t('collectionChoose')}
            </Text>
          </Box>

          {loading ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">{t('collectionLoading')}</Text>
            </Box>
          ) : collections.length === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">{t('collectionEmpty')}</Text>
            </Box>
          ) : (
            <Box style={{ maxHeight: 240, overflowY: 'auto' }}>
              {collections.map((col) => (
                <button
                  key={col.id}
                  onClick={() => addToCollection(col.id)}
                  disabled={adding === col.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    width: '100%',
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    background: 'transparent',
                    border: 'none',
                    color: tokens.colors.text.primary,
                    fontSize: 13,
                    cursor: adding === col.id ? 'wait' : 'pointer',
                    textAlign: 'left',
                    transition: `background ${tokens.transition.base}`,
                    opacity: adding === col.id ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary || 'var(--overlay-hover)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <span style={{ flexShrink: 0 }}>📁</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {col.name}
                  </span>
                  <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                    {col.item_count}
                  </span>
                </button>
              ))}
            </Box>
          )}
        </Box>
      )}
    </div>
  )
}
