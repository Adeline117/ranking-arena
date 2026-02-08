'use client'

import React, { useState, useRef, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'

interface ExchangeFilterProps {
  availableSources: string[]
  selectedExchange: string | null
  onExchangeChange: (exchange: string | null) => void
  isPro?: boolean
  onProRequired?: () => void
}

export default function ExchangeFilter({ availableSources, selectedExchange, onExchangeChange, isPro = true, onProRequired }: ExchangeFilterProps) {
  const { _t, language } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!availableSources.length) return null

  // Group sources by type
  const groupedSources = availableSources.reduce((acc, source) => {
    const type = SOURCE_TYPE_MAP[source] || 'other'
    if (!acc[type]) acc[type] = []
    acc[type].push(source)
    return acc
  }, {} as Record<string, string[]>)

  const typeLabels: Record<string, { zh: string; en: string }> = {
    futures: { zh: 'CEX合约', en: 'CEX Futures' },
    spot: { zh: 'CEX现货', en: 'CEX Spot' },
    web3: { zh: '链上DEX', en: 'On-chain DEX' },
    other: { zh: '其他', en: 'Other' },
  }

  const selectedLabel = selectedExchange 
    ? (EXCHANGE_NAMES[selectedExchange] || selectedExchange)
    : (language === 'zh' ? '选择平台' : 'Select Platform')

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => {
          if (!isPro && onProRequired) {
            onProRequired()
            return
          }
          setIsOpen(!isOpen)
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.md,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.medium,
          color: selectedExchange ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          background: tokens.glass.bg.light,
          border: `1px solid ${selectedExchange ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.fast}`,
          whiteSpace: 'nowrap',
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 12h6M12 9v6" />
        </svg>
        {selectedLabel}
        <svg 
          width={10} height={10} 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2"
          style={{ 
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: `transform ${tokens.transition.fast}`,
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <Box
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: tokens.spacing[1],
            minWidth: 180,
            maxHeight: 320,
            overflowY: 'auto',
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            boxShadow: tokens.shadow.lg,
            zIndex: 100,
          }}
        >
          {/* All option */}
          <button
            onClick={() => {
              onExchangeChange(null)
              setIsOpen(false)
            }}
            style={{
              width: '100%',
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              textAlign: 'left',
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: !selectedExchange ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
              color: !selectedExchange ? tokens.colors.accent.primary : tokens.colors.text.primary,
              background: !selectedExchange ? `${tokens.colors.accent.primary}10` : 'transparent',
              border: 'none',
              cursor: 'pointer',
              transition: `background ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => { if (selectedExchange) e.currentTarget.style.background = tokens.colors.bg.tertiary }}
            onMouseLeave={(e) => { if (selectedExchange) e.currentTarget.style.background = 'transparent' }}
          >
            {language === 'zh' ? '全部平台' : 'All Platforms'}
          </button>

          {/* Grouped sources */}
          {['futures', 'spot', 'web3', 'other'].map(type => {
            const sources = groupedSources[type]
            if (!sources?.length) return null
            
            return (
              <Box key={type}>
                <Box
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: tokens.typography.fontWeight.bold,
                    color: tokens.colors.text.tertiary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderTop: `1px solid ${tokens.colors.border.secondary}`,
                    background: tokens.colors.bg.tertiary,
                  }}
                >
                  {language === 'zh' ? typeLabels[type].zh : typeLabels[type].en}
                </Box>
                {sources.map(source => {
                  const isSelected = selectedExchange === source
                  const label = EXCHANGE_NAMES[source] || source.replace(/_/g, ' ')
                  return (
                    <button
                      key={source}
                      onClick={() => {
                        onExchangeChange(isSelected ? null : source)
                        setIsOpen(false)
                      }}
                      style={{
                        width: '100%',
                        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                        paddingLeft: tokens.spacing[4],
                        textAlign: 'left',
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: isSelected ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                        color: isSelected ? tokens.colors.accent.primary : tokens.colors.text.primary,
                        background: isSelected ? `${tokens.colors.accent.primary}10` : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        transition: `background ${tokens.transition.fast}`,
                      }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = tokens.colors.bg.tertiary }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                    >
                      {label}
                    </button>
                  )
                })}
              </Box>
            )
          })}
        </Box>
      )}
    </div>
  )
}
