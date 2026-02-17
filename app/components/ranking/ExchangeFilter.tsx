'use client'

import React, { useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

interface ExchangeFilterProps {
  availableSources: string[]
  selectedExchange: string | null
  onExchangeChange: (exchange: string | null) => void
  isPro?: boolean
  onProRequired?: () => void
}

export default function ExchangeFilter({ availableSources, selectedExchange, onExchangeChange, isPro = true, onProRequired }: ExchangeFilterProps) {
  const { language } = useLanguage()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showLeftFade, setShowLeftFade] = React.useState(false)
  const [showRightFade, setShowRightFade] = React.useState(false)

  // Check scroll position for fade indicators
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const checkScroll = () => {
      setShowLeftFade(el.scrollLeft > 8)
      setShowRightFade(el.scrollLeft < el.scrollWidth - el.clientWidth - 8)
    }
    checkScroll()
    el.addEventListener('scroll', checkScroll, { passive: true })
    const ro = new ResizeObserver(checkScroll)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', checkScroll); ro.disconnect() }
  }, [availableSources])

  if (!availableSources.length) return null

  const handleClick = (source: string | null) => {
    if (!isPro && onProRequired && source !== null) {
      onProRequired()
      return
    }
    onExchangeChange(source === selectedExchange ? null : source)
  }

  return (
    <div
      ref={scrollRef}
      style={{
        display: 'flex',
        gap: 6,
        overflowX: 'auto',
        paddingBottom: 4,
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
        maskImage: showLeftFade && showRightFade
          ? 'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)'
          : showRightFade
          ? 'linear-gradient(to right, black 92%, transparent 100%)'
          : showLeftFade
          ? 'linear-gradient(to right, transparent 0%, black 8%)'
          : 'none',
        WebkitMaskImage: showLeftFade && showRightFade
          ? 'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)'
          : showRightFade
          ? 'linear-gradient(to right, black 92%, transparent 100%)'
          : showLeftFade
          ? 'linear-gradient(to right, transparent 0%, black 8%)'
          : 'none',
      }}
    >
      {/* All button */}
      <button
        onClick={() => handleClick(null)}
        style={{
          flexShrink: 0,
          padding: '10px 14px',
          minHeight: 44,
          borderRadius: tokens.radius.full,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: !selectedExchange ? 700 : 500,
          color: !selectedExchange ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
          background: !selectedExchange ? 'var(--color-accent-primary)' : 'var(--color-bg-secondary)',
          border: `1px solid ${!selectedExchange ? 'transparent' : 'var(--color-border-primary)'}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.fast}`,
          whiteSpace: 'nowrap',
        }}
      >
        {language === 'zh' ? '全部' : 'All'}
      </button>

      {/* Exchange buttons */}
      {availableSources.map(source => {
        const isSelected = selectedExchange === source
        const label = EXCHANGE_NAMES[source] || source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        
        return (
          <button
            key={source}
            onClick={() => handleClick(source)}
            style={{
              flexShrink: 0,
              padding: '10px 14px',
              minHeight: 44,
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: isSelected ? 700 : 500,
              color: isSelected ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
              background: isSelected ? 'var(--color-accent-primary)' : 'var(--color-bg-secondary)',
              border: `1px solid ${isSelected ? 'transparent' : 'var(--color-border-primary)'}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
