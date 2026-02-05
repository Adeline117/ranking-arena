'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { SOURCE_TYPE_MAP, type SourceType } from '@/lib/constants/exchanges'

export type PresetId = 'all' | 'cex_futures' | 'cex_spot' | 'onchain_dex'

export interface PresetConfig {
  id: PresetId
  label: { zh: string; en: string }
  filter: (trader: { source?: string }) => boolean
}

// Helper to check source type
const getSourceType = (source: string | undefined): SourceType | undefined => {
  if (!source) return undefined
  return SOURCE_TYPE_MAP[source]
}

// Validation helper for preset IDs
export function isValidPresetId(id: string | null | undefined): id is PresetId {
  if (!id) return false
  return ['all', 'cex_futures', 'cex_spot', 'onchain_dex'].includes(id)
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
