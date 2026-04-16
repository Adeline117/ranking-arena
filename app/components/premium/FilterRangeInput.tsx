'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

const inputStyle: React.CSSProperties = {
  width: 80,
  padding: tokens.spacing[2],
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.colors.border.primary}`,
  background: tokens.colors.bg.primary,
  color: tokens.colors.text.primary,
  fontSize: tokens.typography.fontSize.sm,
  outline: 'none',
}

export interface FilterRangeInputProps {
  label: string
  minValue?: number
  maxValue?: number
  onMinChange: (v: number | undefined) => void
  onMaxChange: (v: number | undefined) => void
  minPlaceholder: string
  maxPlaceholder: string
  min?: number
  max?: number
  step?: string
}

/**
 * A labeled min-max range input pair for numeric filters (ROI, drawdown, etc.).
 */
export const FilterRangeInput = memo(function FilterRangeInput({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  minPlaceholder,
  maxPlaceholder,
  min,
  max,
  step = 'any',
}: FilterRangeInputProps) {
  return (
    <Box style={{ marginBottom: tokens.spacing[4] }}>
      <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <input
          type="number"
          placeholder={minPlaceholder}
          aria-label={`${label} ${minPlaceholder}`}
          min={min}
          max={max}
          step={step}
          value={minValue ?? ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            onMinChange(e.target.value && !isNaN(v) ? v : undefined)
          }}
          style={inputStyle}
        />
        <Text size="sm" color="tertiary">~</Text>
        <input
          type="number"
          placeholder={maxPlaceholder}
          aria-label={`${label} ${maxPlaceholder}`}
          min={min}
          max={max}
          step={step}
          value={maxValue ?? ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            onMaxChange(e.target.value && !isNaN(v) ? v : undefined)
          }}
          style={inputStyle}
        />
      </Box>
    </Box>
  )
})

// ── Single number input with label ─────────────────────────────────────────

const fullWidthInputStyle: React.CSSProperties = {
  width: '100%',
  padding: tokens.spacing[2],
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.colors.border.primary}`,
  background: tokens.colors.bg.primary,
  color: tokens.colors.text.primary,
  fontSize: tokens.typography.fontSize.sm,
  outline: 'none',
}

export interface FilterNumberInputProps {
  label: string
  placeholder: string
  value?: number
  onChange: (v: number | undefined) => void
}

/**
 * Single labeled number input for filters (min PnL, min score, min win rate).
 */
export const FilterNumberInput = memo(function FilterNumberInput({
  label,
  placeholder,
  value,
  onChange,
}: FilterNumberInputProps) {
  return (
    <Box>
      <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
        {label}
      </Text>
      <input
        type="number"
        placeholder={placeholder}
        aria-label={label}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        style={fullWidthInputStyle}
      />
    </Box>
  )
})
