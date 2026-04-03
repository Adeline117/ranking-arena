'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export interface PaginationProps {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
}

/**
 * Pagination component with prev/next buttons and numbered page buttons with ellipsis.
 * Uses CSS classes for hover effects instead of JS onMouseEnter/Leave.
 */
export default memo(function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  const { t, language: _language } = useLanguage()

  if (totalPages <= 1) return null

  // Build page numbers array with ellipsis
  const pages: (number | string)[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    if (currentPage <= 3) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    } else if (currentPage >= totalPages - 2) {
      pages.push(1)
      pages.push('...')
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
    } else {
      pages.push(1)
      pages.push('...')
      for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    }
  }

  return (
    <nav
      aria-label={t('paginationNav')}
      className="pagination-container"
      style={{
        padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
        borderTop: `1px solid var(--glass-border-light)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[2],
        background: tokens.glass.bg.light,
        borderRadius: `0 0 ${tokens.radius.xl} ${tokens.radius.xl}`,
      }}
    >
      <button
        aria-label={t('prevPage')}
        className={`pagination-btn pagination-nav ${currentPage === 1 ? 'pagination-disabled' : ''}`}
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
        style={{
          padding: `6px ${tokens.spacing[3]}`,
          minHeight: 44,
          background: currentPage === 1 ? 'transparent' : `${tokens.colors.accent.primary}10`,
          border: `1px solid ${currentPage === 1 ? tokens.colors.border.primary : `${tokens.colors.accent.primary}30`}`,
          borderRadius: tokens.radius.md,
          color: currentPage === 1 ? tokens.colors.text.disabled : tokens.colors.accent.primary,
          cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
          transition: `all ${tokens.transition.fast}`,
        }}
      >
        {t('prevPage')}
      </button>

      {/* Page number buttons */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap', justifyContent: 'center', minWidth: 0 }}>
        {pages.map((page, idx) => {
          if (page === '...') {
            return (
              <Text key={`ellipsis-${idx}`} size="sm" color="tertiary" style={{ padding: `0 ${tokens.spacing[1]}` }}>
                ...
              </Text>
            )
          }

          const pageNum = page as number
          const isActive = pageNum === currentPage

          return (
            <button
              key={pageNum}
              aria-label={t('goToPage').replace('{page}', String(pageNum))}
              aria-current={isActive ? 'page' : undefined}
              className={`pagination-btn pagination-page ${isActive ? 'pagination-active' : ''}`}
              onClick={() => onPageChange(pageNum)}
              style={{
                minWidth: 44,
                height: 44,
                padding: `0 ${tokens.spacing[1]}`,
                background: isActive ? `${tokens.colors.accent.primary}20` : 'transparent',
                border: `1px solid ${isActive ? `${tokens.colors.accent.primary}60` : 'transparent'}`,
                borderRadius: tokens.radius.sm,
                color: isActive ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                transition: `all ${tokens.transition.fast}`,
              }}
            >
              {pageNum}
            </button>
          )
        })}
      </Box>

      <button
        aria-label={t('nextPage')}
        className={`pagination-btn pagination-nav ${currentPage === totalPages ? 'pagination-disabled' : ''}`}
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
        style={{
          padding: `6px ${tokens.spacing[3]}`,
          minHeight: 44,
          background: currentPage === totalPages ? 'transparent' : `${tokens.colors.accent.primary}10`,
          border: `1px solid ${currentPage === totalPages ? tokens.colors.border.primary : `${tokens.colors.accent.primary}30`}`,
          borderRadius: tokens.radius.md,
          color: currentPage === totalPages ? tokens.colors.text.disabled : tokens.colors.accent.primary,
          cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
          transition: `all ${tokens.transition.fast}`,
        }}
      >
        {t('nextPage')}
      </button>
    </nav>
  )
})
