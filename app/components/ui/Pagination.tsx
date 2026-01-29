'use client'

import React from 'react'
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
export default function Pagination({ currentPage, totalPages, onPageChange }: PaginationProps) {
  const { t } = useLanguage()

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
    <Box
      className="pagination-container"
      style={{
        padding: `${tokens.spacing[5]} ${tokens.spacing[4]}`,
        borderTop: `2px solid ${tokens.colors.border.primary}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[3],
        background: tokens.colors.bg.primary,
        borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`,
      }}
    >
      <button
        className={`pagination-btn pagination-nav ${currentPage === 1 ? 'pagination-disabled' : ''}`}
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          background: currentPage === 1 ? tokens.colors.bg.secondary : `${tokens.colors.accent.primary}20`,
          border: `1px solid ${currentPage === 1 ? tokens.colors.border.primary : tokens.colors.accent.primary}40`,
          borderRadius: tokens.radius.md,
          color: currentPage === 1 ? tokens.colors.text.tertiary : tokens.colors.text.primary,
          cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
          transition: `all ${tokens.transition.base}`,
          opacity: currentPage === 1 ? 0.5 : 1,
        }}
      >
        {t('prevPage')}
      </button>

      {/* Page number buttons */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap', justifyContent: 'center', minWidth: 200 }}>
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
              className={`pagination-btn pagination-page ${isActive ? 'pagination-active' : ''}`}
              onClick={() => onPageChange(pageNum)}
              style={{
                minWidth: '40px',
                height: '40px',
                padding: `0 ${tokens.spacing[2]}`,
                background: isActive ? `${tokens.colors.accent.primary}30` : `${tokens.colors.accent.primary}10`,
                border: `1.5px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                color: isActive ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.semibold,
                transition: `all ${tokens.transition.base}`,
                boxShadow: isActive ? tokens.shadow.sm : tokens.shadow.none,
              }}
            >
              {pageNum}
            </button>
          )
        })}
      </Box>

      <button
        className={`pagination-btn pagination-nav ${currentPage === totalPages ? 'pagination-disabled' : ''}`}
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          background: currentPage === totalPages ? tokens.colors.bg.secondary : `${tokens.colors.accent.primary}20`,
          border: `1px solid ${currentPage === totalPages ? tokens.colors.border.primary : tokens.colors.accent.primary}40`,
          borderRadius: tokens.radius.md,
          color: currentPage === totalPages ? tokens.colors.text.tertiary : tokens.colors.text.primary,
          cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
          transition: `all ${tokens.transition.base}`,
          opacity: currentPage === totalPages ? 0.5 : 1,
        }}
      >
        {t('nextPage')}
      </button>
    </Box>
  )
}
