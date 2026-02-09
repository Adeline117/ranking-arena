'use client'

import React, { memo, useState, useMemo } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'

interface BookCoverProps {
  title: string
  author?: string | null
  category?: string
  coverUrl?: string | null
  showCategory?: boolean
  width?: number | string
  height?: number | string
  fontSize?: 'sm' | 'md' | 'lg'
  priority?: boolean
  style?: React.CSSProperties
}

const FONT_SIZES = {
  sm: { title: 11, author: 9 },
  md: { title: 14, author: 11 },
  lg: { title: 18, author: 13 },
}

// Color palettes based on category
const CATEGORY_PALETTES: Record<string, { primary: string; secondary: string; accent: string }> = {
  book:       { primary: '#6B4F88', secondary: '#8B6FA8', accent: '#C9B8DB' },
  paper:      { primary: '#2D5F8A', secondary: '#4A8AC2', accent: '#A8D4F5' },
  whitepaper: { primary: '#1A6B5A', secondary: '#2D9B7A', accent: '#8FD5C0' },
  event:      { primary: '#8A4F2D', secondary: '#C27A4A', accent: '#F5C8A8' },
  finance:    { primary: '#5A1A6B', secondary: '#8A3D9B', accent: '#C88FD5' },
  research:   { primary: '#2D3F8A', secondary: '#4A5FC2', accent: '#A8B8F5' },
}

// Generate a deterministic hash from a string for consistent colors
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash)
}

const BookCover = memo(function BookCover({
  title,
  author,
  category,
  coverUrl,
  width = '100%',
  height = '100%',
  fontSize = 'md',
  priority = false,
  style,
}: BookCoverProps) {
  const [imgError, setImgError] = useState(false)
  const sizes = FONT_SIZES[fontSize]

  // Generate deterministic design properties from title
  const design = useMemo(() => {
    const hash = hashString(title)
    const palette = CATEGORY_PALETTES[category || 'book'] || CATEGORY_PALETTES.book
    
    // Vary the hue slightly based on title hash for uniqueness
    const hueShift = (hash % 30) - 15
    
    // Pick a pattern type (0-4)
    const patternType = hash % 5
    
    // Decorative element position
    const decoX = 20 + (hash % 60)
    const decoY = 10 + ((hash >> 4) % 30)
    
    return { palette, hueShift, patternType, decoX, decoY }
  }, [title, category])

  // Real cover image
  if (coverUrl && !imgError) {
    return (
      <div style={{
        width, height, position: 'relative', overflow: 'hidden',
        borderRadius: 'inherit',
        ...style,
      }}>
        <Image
          src={coverUrl}
          alt={title}
          fill
          loading={priority ? 'eager' : 'lazy'}
          priority={priority}
          style={{ objectFit: 'cover' }}
          sizes="(max-width: 768px) 50vw, 200px"
          onError={() => setImgError(true)}
        />
      </div>
    )
  }

  const { palette, patternType, decoX, decoY } = design

  // Pattern SVG based on type
  const patterns = [
    // Diagonal lines
    `<pattern id="p" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="12" stroke="${palette.accent}" stroke-width="0.5" opacity="0.15"/></pattern>`,
    // Dots
    `<pattern id="p" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="1.5" fill="${palette.accent}" opacity="0.12"/></pattern>`,
    // Crosses
    `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse"><line x1="10" y1="4" x2="10" y2="16" stroke="${palette.accent}" stroke-width="0.5" opacity="0.1"/><line x1="4" y1="10" x2="16" y2="10" stroke="${palette.accent}" stroke-width="0.5" opacity="0.1"/></pattern>`,
    // Hexagons (simplified)
    `<pattern id="p" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="6" fill="none" stroke="${palette.accent}" stroke-width="0.5" opacity="0.1"/></pattern>`,
    // Waves
    `<pattern id="p" width="20" height="10" patternUnits="userSpaceOnUse"><path d="M0 5 Q5 0 10 5 Q15 10 20 5" fill="none" stroke="${palette.accent}" stroke-width="0.5" opacity="0.12"/></pattern>`,
  ]

  const patternSvg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><defs>${patterns[patternType]}</defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`
  )

  return (
    <div style={{
      width, height,
      background: `linear-gradient(160deg, ${palette.primary} 0%, ${palette.secondary} 60%, ${palette.primary} 100%)`,
      position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      borderRadius: 'inherit',
      ...style,
    }}>
      {/* Pattern overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: `url("data:image/svg+xml,${patternSvg}")`,
        pointerEvents: 'none',
      }} />

      {/* Decorative circle */}
      <div style={{
        position: 'absolute',
        right: `${decoX - 40}%`, top: `${decoY - 20}%`,
        width: '60%', height: '40%',
        borderRadius: '50%',
        background: `radial-gradient(circle, ${palette.accent}22 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* Spine line */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: `linear-gradient(180deg, ${palette.accent}44, ${palette.accent}11)`,
      }} />

      {/* Content area */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: fontSize === 'sm' ? '10% 12%' : fontSize === 'lg' ? '12% 14%' : '10% 12%',
        position: 'relative', zIndex: 1,
      }}>
        {/* Category badge */}
        {category && (
          <div style={{
            position: 'absolute',
            top: fontSize === 'sm' ? 8 : 12,
            right: fontSize === 'sm' ? 8 : 12,
            fontSize: fontSize === 'sm' ? 7 : 9,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: palette.accent,
            opacity: 0.7,
          }}>
            {category}
          </div>
        )}

        {/* Divider line */}
        <div style={{
          width: fontSize === 'sm' ? 20 : 32,
          height: 2,
          background: palette.accent,
          opacity: 0.5,
          marginBottom: fontSize === 'sm' ? 6 : 10,
          borderRadius: 1,
        }} />

        {/* Title */}
        <div style={{
          fontSize: sizes.title,
          fontWeight: 700,
          color: tokens.colors.white,
          lineHeight: 1.3,
          textAlign: 'left',
          display: '-webkit-box',
          WebkitLineClamp: fontSize === 'sm' ? 3 : 4,
          WebkitBoxOrient: 'vertical' as const,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          wordBreak: 'break-word',
          textShadow: '0 1px 3px rgba(0,0,0,0.3)',
          letterSpacing: '-0.01em',
        }}>
          {title}
        </div>

        {/* Author */}
        {author && (
          <div style={{
            fontSize: sizes.author,
            color: palette.accent,
            fontWeight: 500,
            marginTop: fontSize === 'sm' ? 3 : 6,
            textAlign: 'left',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '100%',
            opacity: 0.85,
          }}>
            {author}
          </div>
        )}
      </div>

      {/* Bottom decorative bar */}
      <div style={{
        height: fontSize === 'sm' ? 3 : 4,
        background: `linear-gradient(90deg, ${palette.accent}66, transparent)`,
      }} />
    </div>
  )
})

export default BookCover
