'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export interface FilterChipGroupProps {
  label: string
  items: { value: string; label: string }[]
  /** Currently selected values (multi-select) */
  selected?: string[]
  onToggle: (value: string) => void
  /** Compact chip style (smaller padding) */
  compact?: boolean
}

/**
 * A labeled group of toggle-able filter chips.
 * Used for category, exchange, and grade filter sections.
 */
export const FilterChipGroup = memo(function FilterChipGroup({
  label,
  items,
  selected = [],
  onToggle,
  compact = false,
}: FilterChipGroupProps) {
  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
        {items.map(item => {
          const isSelected = selected.includes(item.value)
          return (
            <button
              key={item.value}
              onClick={() => onToggle(item.value)}
              style={{
                padding: compact
                  ? `${tokens.spacing[1]} ${tokens.spacing[2]}`
                  : `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: compact ? tokens.radius.sm : tokens.radius.md,
                border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: isSelected ? `${tokens.colors.accent.primary}${compact ? '15' : '20'}` : 'transparent',
                color: isSelected ? tokens.colors.accent.primary : compact ? tokens.colors.text.tertiary : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: compact ? tokens.typography.fontSize.xs : tokens.typography.fontSize.sm,
                fontWeight: isSelected ? (compact ? undefined : tokens.typography.fontWeight.bold) : (compact ? undefined : tokens.typography.fontWeight.normal),
                transition: 'all 0.2s',
                ...(compact ? {} : { minWidth: 36 }),
              }}
            >
              {item.label}
            </button>
          )
        })}
      </Box>
    </Box>
  )
})

// ── Grade Chip Group (single-select variant) ───────────────────────────────

export interface GradeChipGroupProps {
  label: string
  selectedGrade?: string
  onSelectGrade: (grade: string | undefined) => void
}

/**
 * Single-select grade chip group (S, A, B, C, D).
 */
export const GradeChipGroup = memo(function GradeChipGroup({
  label,
  selectedGrade,
  onSelectGrade,
}: GradeChipGroupProps) {
  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
        {['S', 'A', 'B', 'C', 'D'].map(g => {
          const isSelected = selectedGrade === g
          return (
            <button
              key={g}
              onClick={() => onSelectGrade(isSelected ? undefined : g)}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${isSelected ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: isSelected ? `${tokens.colors.accent.primary}20` : 'transparent',
                color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isSelected ? 700 : 500,
                transition: 'all 0.2s',
                minWidth: 36,
              }}
            >
              {g}
            </button>
          )
        })}
      </Box>
    </Box>
  )
})
