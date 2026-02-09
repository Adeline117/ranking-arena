'use client'

import React, { memo, useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'

interface BookCoverProps {
  title: string
  author?: string | null
  category?: string
  coverUrl?: string | null
  width?: number | string
  height?: number | string
  fontSize?: 'sm' | 'md' | 'lg'
  showCategory?: boolean
  priority?: boolean
  style?: React.CSSProperties
}

const FONT_SIZES = {
  sm: { title: 11, author: 9 },
  md: { title: 14, author: 11 },
  lg: { title: 18, author: 13 },
}

const BookCover = memo(function BookCover({
  title,
  author,
  coverUrl,
  width = '100%',
  height = '100%',
  fontSize = 'md',
  priority = false,
  style,
}: BookCoverProps) {
  const [imgError, setImgError] = useState(false)

  const sizes = FONT_SIZES[fontSize]

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

  // No real cover — show minimal text-only placeholder (no gradient, no generated art)
  return (
    <div style={{
      width, height,
      background: tokens.colors.bg.tertiary,
      position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      alignItems: 'center',
      padding: '12%',
      borderRadius: 'inherit',
      border: `1px solid ${tokens.colors.border.primary}`,
      ...style,
    }}>
      {/* Book icon */}
      <svg width={sizes.title + 8} height={sizes.title + 8} viewBox="0 0 24 24" fill="none"
        stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ marginBottom: 8, opacity: 0.5 }}>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>

      {/* Title */}
      <div style={{
        fontSize: sizes.title, fontWeight: 600, color: tokens.colors.text.secondary,
        lineHeight: 1.3, textAlign: 'center',
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as any,
        overflow: 'hidden', textOverflow: 'ellipsis',
        wordBreak: 'break-word',
      }}>
        {title}
      </div>

      {/* Author */}
      {author && (
        <div style={{
          fontSize: sizes.author, color: tokens.colors.text.tertiary,
          fontWeight: 500, marginTop: 4, textAlign: 'center',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: '100%',
        }}>
          {author}
        </div>
      )}
    </div>
  )
})

export default BookCover
