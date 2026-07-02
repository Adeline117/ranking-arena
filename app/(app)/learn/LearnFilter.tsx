'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'

// Metadata-only shape — article content stays on the server (bundle size).
export interface LearnCardMeta {
  slug: string
  title: string
  excerpt: string
  topic: string
  mins: number
}

interface LearnFilterProps {
  articles: LearnCardMeta[]
  /** Topics present in the article set, pre-translated: [{ id, label }] */
  topics: { id: string; label: string }[]
  labels: {
    all: string
    searchPlaceholder: string
    searchAria: string
    noResults: string
    minRead: string
  }
}

const chipBase: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 999,
  border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
  background: 'transparent',
  color: 'var(--color-text-secondary, #aaa)',
  fontSize: 13,
  cursor: 'pointer',
  transition: 'all .15s ease',
}

const chipActive: React.CSSProperties = {
  ...chipBase,
  background: 'var(--color-accent-primary, #8B6FA8)',
  border: '1px solid var(--color-accent-primary, #8B6FA8)',
  color: '#fff',
}

export default function LearnFilter({ articles, topics, labels }: LearnFilterProps) {
  const [query, setQuery] = useState('')
  const [activeTopic, setActiveTopic] = useState('all')

  const visible = useMemo(() => {
    const q = query.toLowerCase().trim()
    return articles.filter((a) => {
      const topicOk = activeTopic === 'all' || a.topic === activeTopic
      const searchOk = q === '' || `${a.title} ${a.excerpt}`.toLowerCase().includes(q)
      return topicOk && searchOk
    })
  }, [articles, query, activeTopic])

  return (
    <>
      {/* Search */}
      <input
        id="learn-search"
        type="search"
        placeholder={labels.searchPlaceholder}
        aria-label={labels.searchAria}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: '100%',
          padding: '12px 16px',
          borderRadius: 12,
          border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
          background: 'var(--color-bg-secondary, #1a1a2e)',
          color: 'var(--color-text-primary, #fff)',
          fontSize: 15,
          marginBottom: 16,
          outline: 'none',
        }}
      />

      {/* Topic chips */}
      {topics.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
          {[{ id: 'all', label: labels.all }, ...topics].map((topic) => (
            <button
              key={topic.id}
              type="button"
              aria-pressed={activeTopic === topic.id}
              onClick={() => setActiveTopic(topic.id)}
              style={activeTopic === topic.id ? chipActive : chipBase}
            >
              {topic.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {visible.map((article) => (
          <Link
            key={article.slug}
            href={`/learn/${article.slug}`}
            style={{
              display: 'block',
              padding: '20px 24px',
              borderRadius: 12,
              border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
              background: 'var(--color-bg-secondary, #1a1a2e)',
              textDecoration: 'none',
              transition: 'border-color 0.2s ease, transform 0.2s ease',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 6,
              }}
            >
              <h2
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: 'var(--color-text-primary, #fff)',
                  margin: 0,
                }}
              >
                {article.title}
              </h2>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 12,
                  color: 'var(--color-text-tertiary, #888)',
                  whiteSpace: 'nowrap',
                }}
              >
                {article.mins} {labels.minRead}
              </span>
            </div>
            <p
              style={{
                fontSize: 14,
                color: 'var(--color-text-secondary, #aaa)',
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {article.excerpt}
            </p>
          </Link>
        ))}
      </div>

      {/* Empty state */}
      {visible.length === 0 && (
        <p
          style={{
            textAlign: 'center',
            color: 'var(--color-text-tertiary, #888)',
            fontSize: 14,
            padding: '32px 0',
          }}
        >
          {labels.noResults}
        </p>
      )}
    </>
  )
}
