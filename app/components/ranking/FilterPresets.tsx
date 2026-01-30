'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export type PresetId = 'low_risk' | 'high_roi' | 'web3' | 'consistent' | 'top_performer'

const WEB3_SOURCES = [
  'gmx', 'dydx', 'hyperliquid', 'kwenta', 'gains', 'mux',
  'binance_web3', 'okx_web3', 'okx_wallet',
  'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi',
]

export interface PresetConfig {
  id: PresetId
  label: { zh: string; en: string }
  filter: (trader: { roi: number; max_drawdown?: number | null; arena_score?: number; win_rate?: number | null; source?: string }) => boolean
}

export const PRESETS: PresetConfig[] = [
  {
    id: 'low_risk',
    label: { zh: '低风险', en: 'Low Risk' },
    filter: (t) => {
      const mdd = Math.abs(t.max_drawdown ?? 100)
      return mdd < 20 && (t.arena_score ?? 0) > 70
    },
  },
  {
    id: 'high_roi',
    label: { zh: '高收益', en: 'High ROI' },
    filter: (t) => t.roi > 100,
  },
  {
    id: 'web3',
    label: { zh: 'Web3/DEX', en: 'Web3/DEX' },
    filter: (t) => WEB3_SOURCES.includes(t.source ?? ''),
  },
  {
    id: 'consistent',
    label: { zh: '稳健型', en: 'Consistent' },
    filter: (t) => {
      const mdd = Math.abs(t.max_drawdown ?? 100)
      return mdd < 30 && (t.win_rate ?? 0) > 55 && (t.arena_score ?? 0) > 50
    },
  },
  {
    id: 'top_performer',
    label: { zh: '顶尖选手', en: 'Top Performer' },
    filter: (t) => (t.arena_score ?? 0) > 80,
  },
]

interface FilterPresetsProps {
  activePreset: PresetId | null
  onPresetChange: (preset: PresetId | null) => void
}

export default function FilterPresets({ activePreset, onPresetChange }: FilterPresetsProps) {
  const { language } = useLanguage()

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
      {PRESETS.map((preset) => {
        const isActive = activePreset === preset.id
        return (
          <button
            key={preset.id}
            onClick={() => onPresetChange(isActive ? null : preset.id)}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.semibold,
              color: isActive ? '#fff' : tokens.colors.text.secondary,
              background: isActive ? tokens.colors.accent.primary : tokens.glass.bg.light,
              border: `1px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap',
            }}
          >
            {language === 'zh' ? preset.label.zh : preset.label.en}
          </button>
        )
      })}
    </Box>
  )
}
