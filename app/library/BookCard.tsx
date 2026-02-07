'use client'

import React, { memo } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import type { LibraryItem } from '@/lib/types/library'

interface BookCardProps {
  item: LibraryItem
  isZh: boolean
}

const BookCard = memo(function BookCard({ item, isZh }: BookCardProps) {
  return (
    <a
      href={`/library/${item.id}`}
      style={{
        borderRadius: 12, overflow: 'hidden', textDecoration: 'none',
        background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
        transition: 'transform 0.2s, box-shadow 0.2s', cursor: 'pointer',
        display: 'flex', flexDirection: 'column',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}
    >
      {/* Cover */}
      <div style={{
        height: 140, background: `linear-gradient(135deg, ${tokens.colors.accent.brand}22, ${tokens.colors.accent.brand}44)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' as const,
      }}>
        {item.cover_url ? (
          <Image src={item.cover_url} alt={item.title || ''} fill style={{ objectFit: 'cover' }} unoptimized />
        ) : item.category === 'event' ? (
          <div style={{ textAlign: 'center' }}>
            <span style={{ fontSize: 36 }}>
              {item.subcategory === 'hack' ? 'H' : item.subcategory === 'regulation' ? 'R' : item.subcategory === 'quote' ? 'Q' : item.subcategory === 'milestone' ? 'M' : 'E'}
            </span>
            {item.publish_date && (
              <div style={{ marginTop: 4, fontSize: 11, fontWeight: 700, color: tokens.colors.accent.brand }}>
                {item.publish_date}
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 40 }}>
            {item.category === 'whitepaper' ? 'WP' : item.category === 'book' ? 'BK' : item.category === 'paper' ? 'PP' : 'RS'}
          </span>
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 10,
            background: tokens.colors.accent.brand + '22', color: tokens.colors.accent.brand,
            fontWeight: 600, textTransform: 'uppercase',
          }}>
            {item.category}
          </span>
          {item.category === 'event' && item.subcategory && (
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 600,
              background: item.subcategory === 'hack' ? '#ef444422' : item.subcategory === 'regulation' ? '#8b5cf622' : item.subcategory === 'quote' ? '#06b6d422' : '#10b98122',
              color: item.subcategory === 'hack' ? '#ef4444' : item.subcategory === 'regulation' ? '#8b5cf6' : item.subcategory === 'quote' ? '#06b6d4' : '#10b981',
            }}>
              {item.subcategory === 'hack' ? (isZh ? '安全事件' : 'Hack') : item.subcategory === 'regulation' ? (isZh ? '监管' : 'Regulation') : item.subcategory === 'quote' ? (isZh ? '人物发言' : 'Quote') : item.subcategory === 'milestone' ? (isZh ? '里程碑' : 'Milestone') : item.subcategory}
            </span>
          )}
          {!item.is_free && (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: '#f59e0b22', color: '#f59e0b', fontWeight: 600 }}>
              $ Paid
            </span>
          )}
        </div>
        <h3 style={{
          fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary,
          lineHeight: 1.3, marginBottom: 4,
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
        }}>
          {item.title}
        </h3>
        {item.author && (
          <p style={{ fontSize: 12, color: tokens.colors.text.secondary, marginBottom: 4 }}>
            {item.author.length > 50 ? item.author.slice(0, 50) + '...' : item.author}
          </p>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {item.crypto_symbols?.slice(0, 3).map(s => (
            <span key={s} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, background: tokens.colors.border.primary, color: tokens.colors.text.secondary }}>
              {s}
            </span>
          ))}
          {item.pdf_url && (
            <span style={{ fontSize: 10, color: tokens.colors.accent.brand, marginLeft: 'auto' }}>PDF ↗</span>
          )}
        </div>
      </div>
    </a>
  )
})

export default BookCard
