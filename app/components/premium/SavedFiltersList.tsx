'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { SavedFilter } from './AdvancedFilter'

export interface SavedFiltersListProps {
  label: string
  savedFilters: SavedFilter[]
  onLoadFilter: (filter: SavedFilter) => void
  onDeleteFilter: (filterId: string) => Promise<void>
}

/**
 * Horizontal chip list of saved filter presets with load/delete actions.
 */
export const SavedFiltersList = memo(function SavedFiltersList({
  label,
  savedFilters,
  onLoadFilter,
  onDeleteFilter,
}: SavedFiltersListProps) {
  if (savedFilters.length === 0) return null

  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
        {savedFilters.map(filter => (
          <Box
            key={filter.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <button
              onClick={() => onLoadFilter(filter)}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.primary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.semibold,
              }}
            >
              {filter.name}
            </button>
            <button
              aria-label="Close"
              onClick={() => onDeleteFilter(filter.id)}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: 12,
                padding: 0,
                lineHeight: 1.2,
              }}
            >
              ×
            </button>
          </Box>
        ))}
      </Box>
    </Box>
  )
})
