'use client'

import { useEffect, useRef, type CSSProperties } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { STICKERS, type Sticker } from '@/lib/stickers'
import { useLanguage } from '../Providers/LanguageProvider'

interface StickerPickerProps {
  onSelect: (sticker: Sticker) => void
  isOpen: boolean
  onClose: () => void
}

export default function StickerPicker({ onSelect, isOpen, onClose }: StickerPickerProps) {
  const { language } = useLanguage()
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler) }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const containerStyle: CSSProperties = {
    position: 'fixed',
    bottom: 80,
    left: '50%',
    transform: 'translateX(-50%)',
    background: tokens.colors.bg.secondary,
    border: `1px solid ${tokens.colors.border.primary}`,
    borderRadius: 12,
    padding: 8,
    zIndex: 9999,
    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
    width: 'min(300px, calc(100vw - 32px))',
    maxHeight: 320,
    overflowY: 'auto',
  }

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 4,
  }

  const itemStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    borderRadius: 8,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    transition: 'background 0.15s',
    gap: 2,
  }

  return (
    <div ref={panelRef} style={containerStyle}>
      <div style={gridStyle}>
        {STICKERS.map((sticker) => {
          const label = language === 'zh' ? sticker.label_zh : sticker.label_en
          return (
            <button
              key={sticker.id}
              onClick={() => { onSelect(sticker); onClose() }}
              title={label}
              style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <Image
                src={sticker.path}
                alt={label}
                width={48}
                height={48}
                sizes="48px"
                loading="lazy"
                style={{ objectFit: 'contain' }}
              />
              <span style={{
                fontSize: 10,
                color: tokens.colors.text.tertiary,
                lineHeight: 1.2,
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}>
                {language === 'zh' ? sticker.name_zh : sticker.name_en}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
