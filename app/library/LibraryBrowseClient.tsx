'use client'

import { useState } from 'react'
import Link from 'next/link'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import { tokens } from '@/lib/design-tokens'

interface LibraryItem {
  id: string
  title: string
  author: string | null
  description: string | null
  category: string
  subcategory: string | null
  cover_url: string | null
  language: string | null
  rating: number | null
  rating_count: number
  view_count: number
  is_free: boolean
  publish_date: string | null
}

interface CategoryCount {
  category: string
  count: number
}

const CATEGORY_ICONS: Record<string, string> = {
  book: '\uD83D\uDCD6',
  paper: '\uD83D\uDCDD',
  guide: '\uD83D\uDCD8',
  report: '\uD83D\uDCCA',
  course: '\uD83C\uDF93',
  video: '\uD83C\uDFA5',
}

function ItemCard({ item }: { item: LibraryItem }) {
  return (
    <Link
      href={`/library/${item.id}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <div
        style={{
          padding: '16px',
          background: tokens.glass.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: tokens.glass.border.light,
          transition: 'border-color 0.15s, transform 0.15s',
          cursor: 'pointer',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--color-accent-primary)'
          e.currentTarget.style.transform = 'translateY(-2px)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = ''
          e.currentTarget.style.transform = ''
        }}
      >
        {/* Cover image */}
        {item.cover_url && (
          <div style={{
            width: '100%',
            height: 120,
            borderRadius: tokens.radius.md,
            overflow: 'hidden',
            marginBottom: 12,
            background: tokens.colors.bg.tertiary,
          }}>
            <img
              src={item.cover_url}
              alt={item.title}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              loading="lazy"
            />
          </div>
        )}

        {/* Category badge */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-accent-primary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 6,
        }}>
          {item.category}
          {item.is_free && (
            <span style={{
              marginLeft: 6,
              padding: '1px 6px',
              background: 'var(--color-accent-primary-08)',
              borderRadius: 4,
              fontSize: 10,
            }}>
              FREE
            </span>
          )}
        </div>

        {/* Title */}
        <h3 style={{
          fontSize: 15,
          fontWeight: 600,
          margin: '0 0 4px',
          lineHeight: 1.3,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {item.title}
        </h3>

        {/* Author */}
        {item.author && (
          <div style={{
            fontSize: 12,
            color: tokens.colors.text.tertiary,
            marginBottom: 8,
          }}>
            by {item.author}
          </div>
        )}

        {/* Description */}
        {item.description && (
          <p style={{
            fontSize: 13,
            color: tokens.colors.text.secondary,
            margin: '0 0 8px',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            flex: 1,
          }}>
            {item.description}
          </p>
        )}

        {/* Stats row */}
        <div style={{
          display: 'flex',
          gap: 12,
          fontSize: 12,
          color: tokens.colors.text.tertiary,
          marginTop: 'auto',
        }}>
          {item.rating != null && item.rating > 0 && (
            <span>{item.rating.toFixed(1)} ({item.rating_count})</span>
          )}
          {item.view_count > 0 && (
            <span>{item.view_count.toLocaleString()} views</span>
          )}
        </div>
      </div>
    </Link>
  )
}

export default function LibraryBrowseClient({
  recent,
  popular,
  categories,
  totalCount,
}: {
  recent: LibraryItem[]
  popular: LibraryItem[]
  categories: CategoryCount[]
  totalCount: number
}) {
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px 60px' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: '-0.5px' }}>
            Library
          </h1>
          <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginTop: 6 }}>
            {totalCount.toLocaleString()} resources for crypto traders &mdash; books, research papers, guides, and more.
          </p>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 24 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            background: tokens.glass.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: tokens.glass.border.light,
            maxWidth: 480,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              placeholder="Search resources..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && searchQuery.trim()) {
                  window.location.href = `/library/search?q=${encodeURIComponent(searchQuery.trim())}`
                }
              }}
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                color: tokens.colors.text.primary,
                fontSize: 14,
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Categories */}
        {categories.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>
              Categories
            </h2>
            <div style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
            }}>
              {categories.map(cat => (
                <Link
                  key={cat.category}
                  href={`/library/search?category=${encodeURIComponent(cat.category)}`}
                  style={{
                    padding: '8px 16px',
                    background: tokens.glass.bg.secondary,
                    borderRadius: tokens.radius.md,
                    border: tokens.glass.border.light,
                    fontSize: 13,
                    fontWeight: 500,
                    color: tokens.colors.text.secondary,
                    textDecoration: 'none',
                    transition: 'border-color 0.15s',
                    display: 'inline-flex',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <span>{CATEGORY_ICONS[cat.category.toLowerCase()] || '\uD83D\uDCC1'}</span>
                  <span>{cat.category}</span>
                  <span style={{ color: tokens.colors.text.tertiary }}>({cat.count})</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Popular items */}
        {popular.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>
              Most Popular
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 12,
            }}>
              {popular.slice(0, 8).map(item => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>
          </section>
        )}

        {/* Recent additions */}
        {recent.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>
              Recently Added
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 12,
            }}>
              {recent.slice(0, 8).map(item => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {recent.length === 0 && popular.length === 0 && (
          <div style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: 14,
          }}>
            Library is empty. Resources will be added soon.
          </div>
        )}
      </div>

      <FloatingActionButton />
    </div>
  )
}
