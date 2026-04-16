'use client'

import React from 'react'
import { Box, Text } from '../base'
import { tokens } from '@/lib/design-tokens'

// ── AlertRow ───────────────────────────────────────────────────────────────

export interface AlertRowProps {
  label: string
  desc: string
  checked: boolean
  onToggle: () => void
  threshold: number
  onThresholdChange: (v: number) => void
  unit: string
}

/**
 * A single alert configuration row with checkbox toggle and threshold input.
 */
export function AlertRow({
  label, desc, checked, onToggle, threshold, onThresholdChange, unit,
}: AlertRowProps) {
  return (
    <Box style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={label} />
        <Box>
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{label}</Text>
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{desc}</Text>
        </Box>
      </Box>
      {checked && (
        <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            value={threshold}
            onChange={(e) => onThresholdChange(Number(e.target.value))}
            aria-label={`${label} threshold`}
            style={{
              width: 60, padding: '4px 6px', borderRadius: tokens.radius.sm, fontSize: 13,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              textAlign: 'right',
            }}
          />
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{unit}</Text>
        </Box>
      )}
    </Box>
  )
}

// ── AlertPriceRow ──────────────────────────────────────────────────────────

export interface AlertPriceRowProps {
  label: string
  desc: string
  checked: boolean
  onToggle: () => void
  value: number | null
  onValueChange: (v: number | null) => void
  symbol: string | null
  onSymbolChange: (v: string | null) => void
}

/**
 * Price alert row with symbol and value inputs.
 */
export function AlertPriceRow({
  label, desc, checked, onToggle, value, onValueChange, symbol, onSymbolChange,
}: AlertPriceRowProps) {
  return (
    <Box style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={label} />
        <Box>
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{label}</Text>
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>{desc}</Text>
        </Box>
      </Box>
      {checked && (
        <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="text"
            placeholder="BTC"
            value={symbol || ''}
            onChange={(e) => onSymbolChange(e.target.value || null)}
            aria-label={`${label} symbol`}
            style={{
              width: 50, padding: '4px 6px', borderRadius: tokens.radius.sm, fontSize: 13,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
            }}
          />
          <input
            type="number"
            placeholder="0"
            value={value ?? ''}
            onChange={(e) => onValueChange(e.target.value ? Number(e.target.value) : null)}
            aria-label={`${label} value`}
            style={{
              width: 80, padding: '4px 6px', borderRadius: tokens.radius.sm, fontSize: 13,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              textAlign: 'right',
            }}
          />
          <Text style={{ fontSize: 12, color: tokens.colors.text.secondary }}>USD</Text>
        </Box>
      )}
    </Box>
  )
}
