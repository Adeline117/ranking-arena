'use client'

import React, { memo, useMemo, useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'

// Beautiful gradient palettes for different categories
const COVER_GRADIENTS: Record<string, string[]> = {
  whitepaper: [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  ],
  research: [
    'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
    'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
    'linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)',
    'linear-gradient(135deg, #c3cfe2 0%, #f5f7fa 100%)',
    'linear-gradient(135deg, #fdcbf1 0%, #e6dee9 100%)',
  ],
  academic_paper: [
    'linear-gradient(135deg, #2c3e50 0%, #3498db 100%)',
    'linear-gradient(135deg, #1a2a6c 0%, #b21f1f 50%, #fdbb2d 100%)',
    'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)',
    'linear-gradient(135deg, #4b6cb7 0%, #182848 100%)',
    'linear-gradient(135deg, #1e3c72 0%, #2a5298 100%)',
  ],
  finance: [
    'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
    'linear-gradient(135deg, #0f3443 0%, #34e89e 100%)',
    'linear-gradient(135deg, #1d4350 0%, #a43931 100%)',
    'linear-gradient(135deg, #003973 0%, #e5e5be 100%)',
    'linear-gradient(135deg, #1f4037 0%, #99f2c8 100%)',
  ],
  regulatory: [
    'linear-gradient(135deg, #2c3e50 0%, #bdc3c7 100%)',
    'linear-gradient(135deg, #485563 0%, #29323c 100%)',
    'linear-gradient(135deg, #414345 0%, #232526 100%)',
    'linear-gradient(135deg, #536976 0%, #292e49 100%)',
    'linear-gradient(135deg, #3a6186 0%, #89253e 100%)',
  ],
  book: [
    'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    'linear-gradient(135deg, #2d1b69 0%, #11998e 100%)',
    'linear-gradient(135deg, #360033 0%, #0b8793 100%)',
    'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
    'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
    'linear-gradient(135deg, #2C3E50 0%, #4CA1AF 100%)',
    'linear-gradient(135deg, #834d9b 0%, #d04ed6 100%)',
    'linear-gradient(135deg, #373B44 0%, #4286f4 100%)',
  ],
  paper: [
    'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
    'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #48c6ef 0%, #6f86d6 100%)',
    'linear-gradient(135deg, #d299c2 0%, #fef9d7 100%)',
  ],
  event: [
    'linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%)',
    'linear-gradient(135deg, #fbc2eb 0%, #a6c1ee 100%)',
    'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)',
    'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',
    'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)',
  ],
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

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
  sm: { title: 11, author: 9, category: 8 },
  md: { title: 14, author: 11, category: 9 },
  lg: { title: 18, author: 13, category: 10 },
}

const BookCover = memo(function BookCover({
  title,
  author,
  category = 'book',
  coverUrl,
  width = '100%',
  height = '100%',
  fontSize = 'md',
  showCategory = true,
  priority = false,
  style,
}: BookCoverProps) {
  const [imgError, setImgError] = useState(false)

  const gradient = useMemo(() => {
    const gradients = COVER_GRADIENTS[category] || COVER_GRADIENTS.book
    return gradients[hashString(title) % gradients.length]
  }, [title, category])

  const sizes = FONT_SIZES[fontSize]

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
          unoptimized
          onError={() => setImgError(true)}
        />
      </div>
    )
  }

  // Determine text color based on category (dark gradients need light text, light gradients need dark)
  const needsDarkText = ['research', 'paper'].includes(category)
  const textColor = needsDarkText ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)'
  const subtextColor = needsDarkText ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)'
  const badgeBg = needsDarkText ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.15)'

  return (
    <div style={{
      width, height, background: gradient, position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      padding: '12%',
      borderRadius: 'inherit',
      ...style,
    }}>
      {/* Subtle pattern overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'repeating-linear-gradient(45deg, transparent, transparent 35px, rgba(255,255,255,0.03) 35px, rgba(255,255,255,0.03) 36px)',
        pointerEvents: 'none',
      }} />

      {/* Top decorative line */}
      <div style={{
        position: 'absolute', top: '10%', left: '12%', right: '12%',
        height: 1, background: needsDarkText ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.2)',
      }} />

      {/* Category badge */}
      {showCategory && (
        <div style={{
          position: 'absolute', top: '8%', right: '8%',
          fontSize: sizes.category, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: subtextColor,
          background: badgeBg,
          padding: '2px 8px', borderRadius: 4,
          backdropFilter: 'blur(4px)',
        }}>
          {category}
        </div>
      )}

      {/* Title */}
      <div style={{
        fontSize: sizes.title, fontWeight: 700, color: textColor,
        lineHeight: 1.25, marginBottom: author ? 6 : 0,
        display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' as any,
        overflow: 'hidden', textOverflow: 'ellipsis',
        wordBreak: 'break-word',
        position: 'relative', zIndex: 1,
      }}>
        {title}
      </div>

      {/* Author */}
      {author && (
        <div style={{
          fontSize: sizes.author, color: subtextColor,
          fontWeight: 500,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          position: 'relative', zIndex: 1,
        }}>
          {author}
        </div>
      )}

      {/* Bottom decorative line */}
      <div style={{
        position: 'absolute', bottom: '10%', left: '12%', width: '30%',
        height: 2, background: needsDarkText ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.25)',
        borderRadius: 1,
      }} />
    </div>
  )
})

export default BookCover
