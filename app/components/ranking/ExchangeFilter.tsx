'use client'

import React, { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

// Number of exchanges visible before requiring "more" toggle
const VISIBLE_THRESHOLD = 10

interface ExchangeFilterProps {
  availableSources: string[]
  selectedExchange: string | null
  onExchangeChange: (exchange: string | null) => void
}

export default function ExchangeFilter({ availableSources, selectedExchange, onExchangeChange }: ExchangeFilterProps) {
  const { language } = useLanguage()
  const [expanded, setExpanded] = useState(false)

  if (!availableSources.length) return null

  // Show all sources, or collapse to VISIBLE_THRESHOLD with expand toggle
  const needsExpand = availableSources.length > VISIBLE_THRESHOLD
  const visibleSources = needsExpand && !expanded
    ? availableSources.slice(0, VISIBLE_THRESHOLD)
    : availableSources

  const btnStyle = (isActive: boolean): React.CSSProperties => ({
    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
    borderRadius: tokens.radius.full,
    fontSize: tokens.typography.fontSize.xs,
    fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
    color: isActive ? '#fff' : tokens.colors.text.tertiary,
    background: isActive ? tokens.colors.accent.primary : 'transparent',
    border: `1px solid ${isActive ? tokens.colors.accent.primary : tokens.colors.border.secondary}`,
    cursor: 'pointer',
    transition: `all ${tokens.transition.fast}`,
    whiteSpace: 'nowrap',
  })

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap' }}>
      <button
        onClick={() => onExchangeChange(null)}
        style={btnStyle(!selectedExchange)}
      >
        {language === 'zh' ? '全部' : 'All'}
      </button>
      {visibleSources.map((source) => {
        const isActive = selectedExchange === source
        const label = EXCHANGE_NAMES[source] || source.replace(/_/g, ' ')
        return (
          <button
            key={source}
            onClick={() => onExchangeChange(isActive ? null : source)}
            style={btnStyle(isActive)}
          >
            {label}
          </button>
        )
      })}
      {needsExpand && (
        <button
          onClick={() => setExpanded(prev => !prev)}
          style={{
            ...btnStyle(false),
            color: tokens.colors.accent.primary,
            borderColor: `${tokens.colors.accent.primary}40`,
          }}
        >
          {expanded
            ? (language === 'zh' ? '收起' : 'Less')
            : (language === 'zh' ? `+${availableSources.length - VISIBLE_THRESHOLD} 更多` : `+${availableSources.length - VISIBLE_THRESHOLD} More`)}
        </button>
      )}
    </Box>
  )
}
