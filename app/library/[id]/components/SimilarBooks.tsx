'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import StarRating from '@/app/components/ui/StarRating'
import BookCover from '../../BookCover'

export type SimilarItem = {
  id: string
  title: string
  author: string | null
  cover_url: string | null
  category: string
  rating: number | null
  rating_count: number | null
}

interface SimilarBooksProps {
  items: SimilarItem[]
}

export default function SimilarBooks({ items }: SimilarBooksProps) {
  if (items.length === 0) return null

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
      gap: 16,
    }}>
      {items.map(item => (
        <Link key={item.id} href={`/library/${item.id}`} style={{ textDecoration: 'none' }}>
          <div
            style={{ transition: `transform ${tokens.transition.base}` }}
            onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-4px)')}
            onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
          >
            <div style={{
              width: '100%', aspectRatio: '2/3', borderRadius: tokens.radius.lg,
              overflow: 'hidden', boxShadow: tokens.shadow.md, marginBottom: 8,
            }}>
              <BookCover
                title={item.title}
                author={item.author}
                category={item.category || 'book'}
                coverUrl={item.cover_url}
                fontSize="sm"
              />
            </div>
            <p style={{
              fontSize: 12, fontWeight: 600, color: tokens.colors.text.primary,
              lineHeight: 1.3, margin: 0,
              overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
            }}>
              {item.title}
            </p>
            {item.rating != null && item.rating > 0 && (
              <div style={{ marginTop: 4 }}>
                <StarRating rating={item.rating} ratingCount={item.rating_count || 0} size={12} readonly />
              </div>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}
