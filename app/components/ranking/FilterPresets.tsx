'use client'

import { localizedLabel } from '@/lib/utils/format'
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
  label: { zh: string; en: string }
  filter: (trader: FilterableTrader) => boolean
}

// Helper to check source type
const getSourceType = (source: string | undefined): SourceType | undefined => {
  if (!source) return undefined
  return SOURCE_TYPE_MAP[source]
}

const ALL_PRESET_IDS: PresetId[] = [
  'all', 'cex_futures', 'cex_spot', 'onchain_dex',
  'low_risk', 'high_pnl', 'consistent', 'top_scorers',
]

// Validation helper for preset IDs
export function isValidPresetId(id: string | null | undefined): id is PresetId {
  if (!id) return false
  return ALL_PRESET_IDS.includes(id as PresetId)
}

export const PRESETS: PresetConfig[] = [
  {
    id: 'all',
    label: { zh: '全部', en: 'All' },
    filter: () => true,
  },
  {
    id: 'cex_futures',
    label: { zh: 'CEX合约', en: 'CEX Futures' },
    filter: (t) => getSourceType(t.source) === 'futures',
  },
  {
    id: 'cex_spot',
    label: { zh: 'CEX现货', en: 'CEX Spot' },
    filter: (t) => getSourceType(t.source) === 'spot',
  },
  {
    id: 'onchain_dex',
    label: { zh: '链上DEX', en: 'On-chain DEX' },
    filter: (t) => getSourceType(t.source) === 'web3',
  },
  {
    id: 'low_risk',
    label: { zh: '低风险', en: 'Low Risk' },
    filter: (t) =>
      (t.max_drawdown != null && Math.abs(t.max_drawdown) <= 20) &&
      (t.win_rate != null && t.win_rate >= 55),
  },
  {
    id: 'high_pnl',
    label: { zh: '高收益', en: 'High PnL' },
    filter: (t) => t.pnl != null && t.pnl >= 10000,
  },
  {
    id: 'consistent',
    label: { zh: '稳定盈利', en: 'Consistent' },
    filter: (t) =>
      (t.win_rate != null && t.win_rate >= 60) &&
      (t.arena_score != null && t.arena_score >= 50),
  },
  {
    id: 'top_scorers',
    label: { zh: '顶级评分', en: 'Top Scorers' },
    filter: (t) => t.arena_score != null && t.arena_score >= 75,
  },
]

interface FilterPresetsProps {
  activePreset: PresetId | null
  onPresetChange: (preset: PresetId | null) => void
}

export default function FilterPresets({ activePreset, onPresetChange }: FilterPresetsProps) {
  const { language } = useLanguage()

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap' }}>
      {PRESETS.map((preset) => {
        // 'all' is active when nothing selected or explicitly selected
        const isActive = preset.id === 'all'
          ? (activePreset === null || activePreset === 'all')
          : activePreset === preset.id

        return (
          <button
            key={preset.id}
            onClick={() => onPresetChange(preset.id === 'all' ? null : (isActive ? null : preset.id))}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
              color: isActive ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              background: isActive ? tokens.colors.accent.primary : tokens.glass.bg.light,
              border: `1px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap',
            }}
          >
            {localizedLabel(preset.label.zh, preset.label.en, language)}
          </button>
        )
      })}
    </Box>
  )
}
