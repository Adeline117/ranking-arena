'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

type BookInfo = {
  id: string
  title: string
  author: string | null
  pdf_url: string | null
  source_url: string | null
  category: string
}

export default function ReadPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const [book, setBook] = useState<BookInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [darkReader, setDarkReader] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    fetch(`/api/library/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data.item) {
          setError(isZh ? '未找到该书籍' : 'Book not found')
          return
        }
        const item = data.item
        if (!item.pdf_url && !item.source_url) {
          setError(isZh ? '该书籍暂无在线阅读资源' : 'No online reading resource available for this book')
          return
        }
        setBook(item)
      })
      .catch(() => setError(isZh ? '加载失败' : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [id, isZh])

  // Build viewer URL
  const getViewerUrl = useCallback(() => {
    if (!book) return null
    if (book.pdf_url) {
      // Use Google Docs viewer for PDF - works universally, no extra deps
      return `https://docs.google.com/gview?url=${encodeURIComponent(book.pdf_url)}&embedded=true`
    }
    if (book.source_url) {
      return book.source_url
    }
    return null
  }, [book])

  const viewerUrl = getViewerUrl()

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: tokens.colors.bg.primary,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: 40, height: 40, border: `3px solid ${tokens.colors.border.primary}`,
          borderTopColor: tokens.colors.accent.brand,
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
      </div>
    )
  }

  if (error || !viewerUrl) {
    return (
      <div style={{
        minHeight: '100vh', background: tokens.colors.bg.primary,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ marginBottom: 16, opacity: 0.5 }}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <p style={{ color: tokens.colors.text.secondary, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>
          {error || (isZh ? '无法加载阅读器' : 'Unable to load reader')}
        </p>
        <Link href={`/library/${id}`} style={{
          padding: '10px 24px', borderRadius: tokens.radius.lg,
          background: tokens.colors.accent.brand, color: '#fff',
          textDecoration: 'none', fontSize: 14, fontWeight: 600,
        }}>
          {isZh ? '返回书籍详情' : 'Back to Book'}
        </Link>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      background: darkReader ? '#1a1a1a' : tokens.colors.bg.primary,
    }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 16px',
        background: tokens.colors.bg.secondary,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        zIndex: 10, flexShrink: 0,
      }}>
        {/* Back button */}
        <Link href={`/library/${id}`} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          color: tokens.colors.text.secondary, textDecoration: 'none', fontSize: 13,
          padding: '6px 10px', borderRadius: tokens.radius.md,
          transition: `background ${tokens.transition.fast}`,
        }}
          onMouseEnter={e => (e.currentTarget.style.background = tokens.colors.bg.hover)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {isZh ? '返回' : 'Back'}
        </Link>

        {/* Title */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <p style={{
            fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary,
            margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {book?.title}
          </p>
          {book?.author && (
            <p style={{ fontSize: 11, color: tokens.colors.text.tertiary, margin: 0 }}>
              {book.author}
            </p>
          )}
        </div>

        {/* Dark mode toggle for reader */}
        <button
          onClick={() => setDarkReader(!darkReader)}
          style={{
            padding: '6px 12px', borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: darkReader ? tokens.colors.accent.brand : 'transparent',
            color: darkReader ? '#fff' : tokens.colors.text.secondary,
            cursor: 'pointer', fontSize: 12, fontWeight: 500,
            transition: `all ${tokens.transition.fast}`,
          }}
        >
          {darkReader ? (isZh ? '亮色' : 'Light') : (isZh ? '暗色' : 'Dark')}
        </button>

        {/* Open in new tab */}
        {book?.pdf_url && (
          <a href={book.pdf_url} target="_blank" rel="noopener noreferrer" style={{
            padding: '6px 12px', borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: 'transparent', color: tokens.colors.text.secondary,
            textDecoration: 'none', fontSize: 12, fontWeight: 500,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            {isZh ? '新窗口' : 'New Tab'}
          </a>
        )}
      </div>

      {/* Reader iframe */}
      <div style={{
        flex: 1, position: 'relative',
        filter: darkReader ? 'invert(0.88) hue-rotate(180deg)' : 'none',
      }}>
        <iframe
          src={viewerUrl}
          style={{
            width: '100%', height: '100%', border: 'none',
            position: 'absolute', inset: 0,
          }}
          title={book?.title || 'Reader'}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          loading="lazy"
        />
      </div>
    </div>
  )
}
