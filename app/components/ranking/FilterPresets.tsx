'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export type PresetId = 'low_risk' | 'high_roi' | 'web3'

export interface PresetConfig {
  id: PresetId
  label: { zh: string; en: string }
  filter: (trader: { roi: number; max_drawdown?: number | null; arena_score?: number; source?: string }) => boolean
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
    label: { zh: '链上', en: 'Web3' },
    filter: (t) => {
      const src = (t.source || '').toLowerCase()
      return src.includes('web3') || src === 'gmx'
    },
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
