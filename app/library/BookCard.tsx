'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { LibraryItem } from '@/lib/types/library'
import BookCover from './BookCover'
import StarRating from '@/app/components/ui/StarRating'

interface BookCardProps {
  item: LibraryItem
  isZh: boolean
}

const BookCard = memo(function BookCard({ item, isZh }: BookCardProps) {
  return (
    <a
      href={`/library/${item.id}`}
      style={{
        borderRadius: tokens.radius.lg,
        overflow: 'hidden',
        textDecoration: 'none',
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        transition: `transform ${tokens.transition.base}, box-shadow ${tokens.transition.base}`,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.transform = 'translateY(-4px)'
        el.style.boxShadow = tokens.shadow.cardHover
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.transform = 'translateY(0)'
        el.style.boxShadow = 'none'
      }}
    >
      {/* Cover - 2:3 aspect ratio */}
      <div style={{
        aspectRatio: '2/3',
        width: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
      }}>
        <BookCover
          title={item.title}
          author={item.author}
          category={item.category}
          coverUrl={item.cover_url}
          fontSize="md"
        />
      </div>

      {/* Info */}
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* Category + tags row */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: tokens.radius.full,
            background: tokens.colors.accent.brandMuted, color: tokens.colors.accent.brand,
            fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em',
          }}>
            {item.category}
          </span>
          {item.category === 'event' && item.subcategory && (
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: tokens.radius.full, fontWeight: 600,
              background: item.subcategory === 'hack' ? '#ef444418' : item.subcategory === 'regulation' ? '#8b5cf618' : '#10b98118',
              color: item.subcategory === 'hack' ? '#ef4444' : item.subcategory === 'regulation' ? '#8b5cf6' : '#10b981',
            }}>
              {item.subcategory === 'hack' ? (isZh ? '安全事件' : 'Hack')
                : item.subcategory === 'regulation' ? (isZh ? '监管' : 'Regulation')
                : item.subcategory === 'quote' ? (isZh ? '人物发言' : 'Quote')
                : item.subcategory === 'milestone' ? (isZh ? '里程碑' : 'Milestone')
                : item.subcategory}
            </span>
          )}
          {!item.is_free && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: tokens.radius.full, background: '#f59e0b18', color: '#f59e0b', fontWeight: 600 }}>
              Paid
            </span>
          )}
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
          {(item.rating != null && item.rating > 0) ? (
            <StarRating rating={item.rating} ratingCount={item.rating_count || 0} size={13} readonly />
          ) : (
            <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
              {item.view_count > 0 ? `${item.view_count.toLocaleString()} views` : ''}
            </span>
          )}
          {item.pdf_url && (
            <span style={{
              fontSize: 10, color: tokens.colors.accent.brand,
              marginLeft: 'auto', fontWeight: 600,
              padding: '1px 6px', borderRadius: 4,
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
