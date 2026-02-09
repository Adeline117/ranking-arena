'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { CloseIcon } from '../ui/icons'
import SearchDropdown from './SearchDropdown'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface MobileSearchOverlayProps {
  open: boolean
  onClose: () => void
}

/**
 * Full-screen mobile search overlay
 * Triggered from mobile nav search icon
 * Optimized for touch with larger tap targets
 */
export default function MobileSearchOverlay({ open, onClose }: MobileSearchOverlayProps) {
  const { t } = useLanguage()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
    if (!open) {
      setQuery('')
    }
  }, [open])

  // Prevent body scrolling when overlay is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  return (
    <Box
      role="dialog"
      aria-modal="true"
      aria-label={t('search') || 'Search'}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: tokens.colors.bg.primary,
        zIndex: tokens.zIndex.modal,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header with search input */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box style={{ flex: 1, position: 'relative' }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault()
                router.push(`/search?q=${encodeURIComponent(query.trim())}`)
                onClose()
              }
            }}
            placeholder={t('searchPlaceholder')}
            style={{
              width: '100%',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              outline: 'none',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                padding: tokens.spacing[1],
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon size={16} />
            </button>
          )}
        </Box>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            padding: tokens.spacing[2],
            fontSize: tokens.typography.fontSize.sm,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text size="sm">{t('cancel')}</Text>
        </button>
      </Box>

      {/* Search results area - full height scroll */}
      <Box
        style={{
          flex: 1,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          position: 'relative',
        }}
      >
        <SearchDropdown
          open={true}
          query={query}
          onClose={onClose}
        />
      </Box>
    </Box>
  )
}
