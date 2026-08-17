'use client'

import React, { memo } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export interface PaginationProps {
  currentPage: number
  /** Null when the server can only prove this page, not the cohort total. */
  totalPages: number | null
  /** False prevents numeric page controls even if a legacy totalPages leaks through. */
  totalCountIsExact?: boolean
  /** Limit+1 look-ahead for an otherwise unknown total. */
  hasMore?: boolean
  onPageChange: (page: number) => void
}

function finitePageCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Pagination component with prev/next buttons and numbered page buttons with ellipsis.
 * Uses CSS classes for hover effects instead of JS onMouseEnter/Leave.
 */
export default memo(function Pagination({
  currentPage,
  totalPages,
  totalCountIsExact,
  hasMore,
  onPageChange,
}: PaginationProps) {
  const { t, language: _language } = useLanguage()

  const exactTotalPages =
    totalCountIsExact === true && finitePageCount(totalPages) ? totalPages : null
  const safeInputPage = Number.isSafeInteger(currentPage) && currentPage > 0 ? currentPage : 1

  // With no exact total, the only honest controls are a backwards link and a
  // next link that has a concrete limit+1 witness. Never infer numbered pages,
  // a final page, or an upper bound from the current finite page.
  if (exactTotalPages === null) {
    const safePageChange = (page: number) =>
      onPageChange(Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1)
    if (safeInputPage === 1 && hasMore !== true) return null

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
          className={`pagination-btn pagination-nav ${safeInputPage === 1 ? 'pagination-disabled' : ''}`}
          onClick={() => safePageChange(safeInputPage - 1)}
          disabled={safeInputPage === 1}
          style={{
            padding: `6px ${tokens.spacing[3]}`,
            minHeight: 44,
            background:
              safeInputPage === 1 ? 'transparent' : alpha(tokens.colors.accent.primary, 6),
            border: `1px solid ${safeInputPage === 1 ? tokens.colors.border.primary : alpha(tokens.colors.accent.primary, 19)}`,
            borderRadius: tokens.radius.md,
            color: safeInputPage === 1 ? tokens.colors.text.disabled : tokens.colors.accent.primary,
            cursor: safeInputPage === 1 ? 'not-allowed' : 'pointer',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            transition: `all ${tokens.transition.fast}`,
          }}
        >
          {t('prevPage')}
        </button>
        <button
          aria-label={t('nextPage')}
          className={`pagination-btn pagination-nav ${hasMore === true ? '' : 'pagination-disabled'}`}
          onClick={() => safePageChange(safeInputPage + 1)}
          disabled={hasMore !== true}
          style={{
            padding: `6px ${tokens.spacing[3]}`,
            minHeight: 44,
            background: hasMore === true ? alpha(tokens.colors.accent.primary, 6) : 'transparent',
            border: `1px solid ${hasMore === true ? alpha(tokens.colors.accent.primary, 19) : tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            color: hasMore === true ? tokens.colors.accent.primary : tokens.colors.text.disabled,
            cursor: hasMore === true ? 'pointer' : 'not-allowed',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            transition: `all ${tokens.transition.fast}`,
          }}
        >
          {t('nextPage')}
        </button>
      </nav>
    )
  }

  // Guard: one exact page means no pagination needed.
  if (exactTotalPages <= 1) return null

  // Clamp currentPage to valid range to prevent out-of-bounds rendering
  const safePage = Math.max(1, Math.min(safeInputPage, exactTotalPages))

  // Build page numbers array with ellipsis
  const pages: (number | string)[] = []
  if (exactTotalPages <= 7) {
    for (let i = 1; i <= exactTotalPages; i++) pages.push(i)
  } else {
    if (safePage <= 3) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...')
      pages.push(exactTotalPages)
    } else if (safePage >= exactTotalPages - 2) {
      pages.push(1)
      pages.push('...')
      for (let i = exactTotalPages - 4; i <= exactTotalPages; i++) pages.push(i)
    } else {
      pages.push(1)
      pages.push('...')
      for (let i = safePage - 1; i <= safePage + 1; i++) pages.push(i)
      pages.push('...')
      pages.push(exactTotalPages)
    }
  }

  // Clamp page changes to valid range
  const safePageChange = (page: number) =>
    onPageChange(Math.max(1, Math.min(page, exactTotalPages)))

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
        className={`pagination-btn pagination-nav ${safePage === 1 ? 'pagination-disabled' : ''}`}
        onClick={() => safePageChange(safePage - 1)}
        disabled={safePage === 1}
        style={{
          padding: `6px ${tokens.spacing[3]}`,
          minHeight: 44,
          background: safePage === 1 ? 'transparent' : alpha(tokens.colors.accent.primary, 6),
          border: `1px solid ${safePage === 1 ? tokens.colors.border.primary : alpha(tokens.colors.accent.primary, 19)}`,
          borderRadius: tokens.radius.md,
          color: safePage === 1 ? tokens.colors.text.disabled : tokens.colors.accent.primary,
          cursor: safePage === 1 ? 'not-allowed' : 'pointer',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
          transition: `all ${tokens.transition.fast}`,
        }}
      >
        {t('prevPage')}
      </button>

      {/* Page number buttons */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          flexWrap: 'wrap',
          justifyContent: 'center',
          minWidth: 0,
        }}
      >
        {pages.map((page, idx) => {
          if (page === '...') {
            return (
              <Text
                key={`ellipsis-${idx}`}
                size="sm"
                color="tertiary"
                style={{ padding: `0 ${tokens.spacing[1]}` }}
              >
                ...
              </Text>
            )
          }

          const pageNum = page as number
          const isActive = pageNum === safePage

          return (
            <button
              key={pageNum}
              aria-label={t('goToPage').replace('{page}', String(pageNum))}
              aria-current={isActive ? 'page' : undefined}
              className={`pagination-btn pagination-page ${isActive ? 'pagination-active' : ''}`}
              onClick={() => safePageChange(pageNum)}
              style={{
                minWidth: 44,
                height: 44,
                padding: `0 ${tokens.spacing[1]}`,
                background: isActive ? alpha(tokens.colors.accent.primary, 12) : 'transparent',
                border: `1px solid ${isActive ? alpha(tokens.colors.accent.primary, 38) : 'transparent'}`,
                borderRadius: tokens.radius.sm,
                color: isActive ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isActive
                  ? tokens.typography.fontWeight.bold
                  : tokens.typography.fontWeight.medium,
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
        className={`pagination-btn pagination-nav ${safePage === exactTotalPages ? 'pagination-disabled' : ''}`}
        onClick={() => safePageChange(safePage + 1)}
        disabled={safePage === exactTotalPages}
        style={{
          padding: `6px ${tokens.spacing[3]}`,
          minHeight: 44,
          background:
            safePage === exactTotalPages ? 'transparent' : alpha(tokens.colors.accent.primary, 6),
          border: `1px solid ${safePage === exactTotalPages ? tokens.colors.border.primary : alpha(tokens.colors.accent.primary, 19)}`,
          borderRadius: tokens.radius.md,
          color:
            safePage === exactTotalPages
              ? tokens.colors.text.disabled
              : tokens.colors.accent.primary,
          cursor: safePage === exactTotalPages ? 'not-allowed' : 'pointer',
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
