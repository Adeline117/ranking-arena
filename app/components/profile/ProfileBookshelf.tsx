'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import StarRating from '@/app/components/ui/StarRating'
import { logger } from '@/lib/logger'

type ShelfItem = {
  id: string
  title: string
  author: string | null
  cover_url: string | null
  category: string
  status: 'want_to_read' | 'reading' | 'read'
  user_rating: number | null
}

const STATUS_LABELS = {
  zh: { want_to_read: '想读', reading: '在读', read: '读过' },
  en: { want_to_read: 'Want to Read', reading: 'Reading', read: 'Read' },
}

const STATUS_COLORS: Record<string, string> = {
  want_to_read: tokens.colors.accent.warning,
  reading: tokens.colors.accent.primary,
  read: tokens.colors.accent.success,
}

export default function ProfileBookshelf({ handle, expanded }: { handle: string; expanded?: boolean }) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [items, setItems] = useState<ShelfItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'want_to_read' | 'reading' | 'read'>('all')

  useEffect(() => {
    fetch(`/api/users/${encodeURIComponent(handle)}/shelf`)
      .then(r => r.json())
      .then(d => setItems(d.items || []))
      .catch(e => logger.error('[ProfileBookshelf]', e))
      .finally(() => setLoading(false))
  }, [handle])

  const filtered = filter === 'all' ? items : items.filter(i => i.status === filter)
  const counts = {
    want_to_read: items.filter(i => i.status === 'want_to_read').length,
    reading: items.filter(i => i.status === 'reading').length,
    read: items.filter(i => i.status === 'read').length,
  }

  if (loading) {
    return (
      <Box bg="secondary" p={4} radius="lg" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
          {isZh ? '书架' : 'Bookshelf'}
        </Text>
        <Box style={{ display: 'grid', gridTemplateColumns: expanded ? 'repeat(auto-fill, minmax(110px, 1fr))' : 'repeat(3, 1fr)', gap: tokens.spacing[3] }}>
          {[1, 2, 3].map(i => (
            <Box key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
              <Box className="skeleton" style={{ width: '100%', aspectRatio: '3/4', borderRadius: tokens.radius.md }} />
              <Box className="skeleton" style={{ height: 12, borderRadius: 4, width: '80%' }} />
            </Box>
          ))}
        </Box>
      </Box>
    )
  }

  if (items.length === 0) {
    return (
      <Box bg="secondary" p={4} radius="lg" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          {isZh ? '书架' : 'Bookshelf'}
        </Text>
        <Text size="sm" color="tertiary">{isZh ? '还没有添加书籍' : 'No books yet'}</Text>
      </Box>
    )
  }

  const displayItems = expanded ? filtered : filtered.slice(0, 6)

  return (
    <Box bg="secondary" p={4} radius="lg" border="primary">
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[3] }}>
        <Text size="lg" weight="black">{isZh ? '书架' : 'Bookshelf'}</Text>
        <Text size="xs" color="tertiary">{items.length} {isZh ? '本' : 'books'}</Text>
      </Box>

      {/* Status filter tabs */}
      <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3], flexWrap: 'wrap' }}>
        {(['all', 'want_to_read', 'reading', 'read'] as const).map(status => {
          const label = status === 'all'
            ? (isZh ? '全部' : 'All')
            : (STATUS_LABELS[isZh ? 'zh' : 'en'] as Record<string, string>)[status]
          const count = status === 'all' ? items.length : counts[status]
          return (
            <button
              key={status}
              onClick={() => setFilter(status)}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.full,
                border: filter === status ? `1px solid ${tokens.colors.accent.primary}40` : `1px solid ${tokens.colors.border.primary}`,
                background: filter === status ? `${tokens.colors.accent.primary}15` : 'transparent',
                color: filter === status ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {label} ({count})
            </button>
          )
        })}
      </Box>

      {/* Book grid */}
      <Box style={{ display: 'grid', gridTemplateColumns: expanded ? 'repeat(auto-fill, minmax(110px, 1fr))' : 'repeat(3, 1fr)', gap: tokens.spacing[3] }}>
        {displayItems.map(book => (
          <Link key={book.id} href={`/library/${book.id}`} style={{ textDecoration: 'none' }}>
            <Box style={{
              display: 'flex', flexDirection: 'column', gap: tokens.spacing[1],
              transition: 'transform 0.15s',
            }}>
              {/* Cover */}
              <Box style={{
                width: '100%', aspectRatio: '3/4',
                borderRadius: tokens.radius.md,
                overflow: 'hidden',
                background: tokens.colors.bg.tertiary,
                position: 'relative',
              }}>
                {book.cover_url ? (
                  <img
                    src={book.cover_url}
                    alt={book.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <Box style={{
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: tokens.spacing[2],
                    background: `linear-gradient(135deg, ${tokens.colors.accent.primary}20, ${tokens.colors.accent.brand}20)`,
                  }}>
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.text.secondary, textAlign: 'center', lineHeight: 1.2 }}>
                      {book.title.slice(0, 20)}
                    </Text>
                  </Box>
                )}
                {/* Status badge */}
                <Box style={{
                  position: 'absolute', top: 6, right: 6,
                  padding: '2px 8px', borderRadius: tokens.radius.full,
                  background: `${STATUS_COLORS[book.status]}CC`,
                  backdropFilter: 'blur(4px)',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
                }}>
                  <Text style={{ fontSize: 9, fontWeight: 700, color: 'var(--color-on-accent)', letterSpacing: '0.02em' }}>
                    {(STATUS_LABELS[isZh ? 'zh' : 'en'] as Record<string, string>)[book.status]}
                  </Text>
                </Box>
              </Box>
              {/* Title */}
              <Text size="xs" weight="semibold" style={{
                color: tokens.colors.text.primary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {book.title}
              </Text>
              {/* Rating */}
              {book.user_rating && book.user_rating > 0 && (
                <StarRating rating={book.user_rating} size={10} readonly />
              )}
            </Box>
          </Link>
        ))}
      </Box>

      {/* View all link */}
      {!expanded && filtered.length > 6 && (
        <Box style={{ textAlign: 'center', marginTop: tokens.spacing[3] }}>
          <Link href={`/u/${handle}?tab=bookshelf`} style={{
            color: tokens.colors.accent.primary,
            fontSize: tokens.typography.fontSize.xs,
            textDecoration: 'none',
            fontWeight: 600,
          }}>
            {isZh ? '查看全部' : 'View all'} →
          </Link>
        </Box>
      )}
    </Box>
  )
}
