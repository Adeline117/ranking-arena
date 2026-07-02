'use client'

import type { TranslationKey } from '@/lib/i18n'
import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { SOURCE_TYPE_MAP, type SourceType } from '@/lib/constants/exchanges'

export type PresetId =
  | 'all'
  | 'cex_futures'
  | 'cex_spot'
  | 'onchain_dex'
  | 'low_risk'
  | 'high_pnl'
  | 'consistent'
  | 'top_scorers'

/** Trader shape used by preset filters */
interface FilterableTrader {
  source?: string
  max_drawdown?: number | null
  win_rate?: number | null
  pnl?: number | null
  arena_score?: number | null
}

export interface PresetConfig {
  id: PresetId
  labelKey: string
  filter: (trader: FilterableTrader) => boolean
}

// Helper to check source type
const getSourceType = (source: string | undefined): SourceType | undefined => {
  if (!source) return undefined
  return SOURCE_TYPE_MAP[source]
}

const ALL_PRESET_IDS: PresetId[] = [
  'all',
  'cex_futures',
  'cex_spot',
  'onchain_dex',
  'low_risk',
  'high_pnl',
  'consistent',
  'top_scorers',
]

// Validation helper for preset IDs
export function isValidPresetId(id: string | null | undefined): id is PresetId {
  if (!id) return false
  return ALL_PRESET_IDS.includes(id as PresetId)
}

export const PRESETS: PresetConfig[] = [
  {
    id: 'all',
    labelKey: 'presetAll',
    filter: () => true,
  },
  {
    id: 'cex_futures',
    labelKey: 'presetCexFutures',
    filter: (t) => getSourceType(t.source) === 'futures',
  },
  {
    id: 'cex_spot',
    labelKey: 'presetCexSpot',
    filter: (t) => getSourceType(t.source) === 'spot',
  },
  {
    id: 'onchain_dex',
    labelKey: 'presetOnchainDex',
    filter: (t) => getSourceType(t.source) === 'web3',
  },
  {
    id: 'low_risk',
    labelKey: 'presetLowRisk',
    filter: (t) =>
      t.max_drawdown != null &&
      Math.abs(t.max_drawdown) <= 20 &&
      t.win_rate != null &&
      t.win_rate >= 55,
  },
  {
    id: 'high_pnl',
    labelKey: 'presetHighPnl',
    filter: (t) => t.pnl != null && t.pnl >= 10000,
  },
  {
    id: 'consistent',
    labelKey: 'presetConsistent',
    filter: (t) =>
      t.win_rate != null && t.win_rate >= 60 && t.arena_score != null && t.arena_score >= 50,
  },
  {
    id: 'top_scorers',
    labelKey: 'presetTopScorers',
    filter: (t) => t.arena_score != null && t.arena_score >= 75,
  },
]

interface FilterPresetsProps {
  activePreset: PresetId | null
  onPresetChange: (preset: PresetId | null) => void
}

export default function FilterPresets({ activePreset, onPresetChange }: FilterPresetsProps) {
  const { t } = useLanguage()

  return (
    <Box
      style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap' }}
    >
      {PRESETS.map((preset) => {
        // 'all' is active when nothing selected or explicitly selected
        const isActive =
          preset.id === 'all'
            ? activePreset === null || activePreset === 'all'
            : activePreset === preset.id

        return (
          <button
            key={preset.id}
            onClick={() => onPresetChange(preset.id === 'all' ? null : isActive ? null : preset.id)}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: isActive
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
              color: isActive ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              background: isActive ? tokens.colors.accent.primary : tokens.glass.bg.light,
              border: `1px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap',
            }}
          >
            {t(preset.labelKey as TranslationKey)}
          </button>
        )
      })}
    </Box>
  )
}
