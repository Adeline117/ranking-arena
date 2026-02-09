'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { LibraryItem } from '@/lib/types/library'
import BookCover from './BookCover'
import StarRating from '@/app/components/ui/StarRating'

const CATEGORY_LABELS_ZH: Record<string, string> = {
  book: '书籍',
  paper: '论文',
  whitepaper: '白皮书',
  event: '事件',
  research: '研报',
  academic_paper: '学术论文',
  finance: '金融',
  regulatory: '监管',
}

interface BookCardProps {
  item: LibraryItem
  isZh: boolean
  priority?: boolean
}

const BookCard = memo(function BookCard({ item, isZh, priority = false }: BookCardProps) {
  return (
    <a
      href={`/library/${item.id}`}
      className="card-hover book-card-hover"
      style={{
        borderRadius: tokens.radius.xl,
        overflow: 'hidden',
        textDecoration: 'none',
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        transition: 'transform 0.25s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-4px) scale(1.02)'
        e.currentTarget.style.boxShadow = '0 12px 28px var(--color-overlay-medium), 0 4px 12px var(--color-overlay-light)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0) scale(1)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {/* Cover - 2:3 aspect ratio */}
      <div style={{
        aspectRatio: '2/3',
        width: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
      }}>
        <BookCover
          title={item.title}
          author={item.author}
          category={item.category}
          coverUrl={item.cover_url}
          fontSize="md"
          priority={priority}
        />
        {/* Permission badge */}
        <span style={{
          position: 'absolute',
          top: 8,
          left: 8,
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: tokens.radius.full,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          ...(item.is_free
            ? { background: 'var(--color-accent-success)', color: 'var(--foreground)' }
            : { background: 'var(--color-accent-primary)', color: 'var(--foreground)' }),
          zIndex: 1,
        }}>
          {item.is_free ? (isZh ? '免费' : 'Free') : 'Pro'}
        </span>
      </div>

      {/* Info */}
      <div style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Category + tags row */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: tokens.radius.full,
            background: tokens.colors.accent.brandMuted, color: tokens.colors.accent.brand,
            fontWeight: 600, letterSpacing: '0.03em',
          }}>
            {isZh ? CATEGORY_LABELS_ZH[item.category] || item.category : item.category}
          </span>
          {item.category === 'event' && item.subcategory && (
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: tokens.radius.full, fontWeight: 600,
              background: item.subcategory === 'hack' ? `${tokens.colors.accent.error}18` : item.subcategory === 'regulation' ? `${tokens.colors.accent.brand}18` : `${tokens.colors.accent.success}18`,
              color: item.subcategory === 'hack' ? tokens.colors.accent.error : item.subcategory === 'regulation' ? tokens.colors.accent.brand : tokens.colors.accent.success,
            }}>
              {item.subcategory === 'hack' ? (isZh ? '安全事件' : 'Hack')
                : item.subcategory === 'regulation' ? (isZh ? '监管' : 'Regulation')
                : item.subcategory === 'quote' ? (isZh ? '人物发言' : 'Quote')
                : item.subcategory === 'milestone' ? (isZh ? '里程碑' : 'Milestone')
                : item.subcategory}
            </span>
          )}
          {/* Permission label moved to cover badge */}
        </div>

        {/* Title */}
        <h3 style={{
          fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary,
          lineHeight: 1.35, margin: 0,
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
        }}>
          {item.title}
        </h3>

        {/* Author */}
        {item.author && (
          <p style={{ fontSize: 12, color: tokens.colors.text.secondary, margin: 0 }}>
            {item.author.length > 40 ? item.author.slice(0, 40) + '...' : item.author}
          </p>
        )}

        {/* Bottom row: rating + indicators */}
        <div style={{ marginTop: 'auto', paddingTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          {(item.rating != null && item.rating > 0) && (
            <StarRating rating={item.rating} ratingCount={item.rating_count || 0} size={13} readonly />
          )}
          {(item.pdf_url || item.file_key) && (
            <span style={{
              fontSize: 10, color: tokens.colors.accent.brand,
              marginLeft: 'auto', fontWeight: 600,
              padding: '1px 6px', borderRadius: tokens.radius.sm,
              background: tokens.colors.accent.brandMuted,
            }}>
              PDF
            </span>
          )}
        </div>
      </div>
    </a>
  )
})

export default BookCard
