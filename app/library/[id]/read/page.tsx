'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
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

type ContentMode = 'pdf' | 'web' | 'none'

function isPdfUrl(url: string | null): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  return lower.endsWith('.pdf') || lower.includes('.pdf?') || lower.includes('/pdf/') || lower.includes('type=pdf')
}

function getContentMode(book: BookInfo): ContentMode {
  if (book.pdf_url) return 'pdf'
  if (book.source_url && isPdfUrl(book.source_url)) return 'pdf'
  if (book.source_url) return 'web'
  return 'none'
}

function getContentUrl(book: BookInfo): string | null {
  if (book.pdf_url) return book.pdf_url
  if (book.source_url) return book.source_url
  return null
}

export default function ReadPage() {
  const { id } = useParams<{ id: string }>()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  const [book, setBook] = useState<BookInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [darkReader, setDarkReader] = useState(false)

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [scale, setScale] = useState(1.5)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<any>(null)

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
          setError(isZh ? '该书籍暂无阅读资源' : 'No reading resource available')
          return
        }
        setBook(item)
      })
      .catch(() => setError(isZh ? '加载失败' : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [id, isZh])

  // Load PDF document
  useEffect(() => {
    if (!book) return
    const mode = getContentMode(book)
    if (mode !== 'pdf') return

    const url = getContentUrl(book)
    if (!url) return

    setPdfLoading(true)
    let cancelled = false

    async function loadPdf() {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

        const doc = await pdfjsLib.getDocument({
          url,
          // Some PDF hosts require CORS - use range requests when possible
          disableAutoFetch: false,
          disableStream: false,
        }).promise

        if (cancelled) return
        setPdfDoc(doc)
        setTotalPages(doc.numPages)
        setCurrentPage(1)
      } catch (err: any) {
        if (cancelled) return
        console.error('PDF load error:', err)
        setError(isZh
          ? '无法加载 PDF，可能是跨域限制'
          : 'Unable to load PDF, possibly due to CORS restrictions')
      } finally {
        if (!cancelled) setPdfLoading(false)
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [book, isZh])

  // Render current PDF page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return

    let cancelled = false

    async function renderPage() {
      // Cancel any ongoing render
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel() } catch {}
      }

      try {
        const page = await pdfDoc.getPage(currentPage)
        if (cancelled) return

        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current!
        const ctx = canvas.getContext('2d')!

        canvas.height = viewport.height
        canvas.width = viewport.width

        const task = page.render({ canvasContext: ctx, viewport })
        renderTaskRef.current = task
        await task.promise
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException' && !cancelled) {
          console.error('Render error:', err)
        }
      }
    }

    renderPage()
    return () => { cancelled = true }
  }, [pdfDoc, currentPage, scale])

  // Fit width on load
  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return

    async function fitWidth() {
      const page = await pdfDoc.getPage(1)
      const baseViewport = page.getViewport({ scale: 1 })
      const containerWidth = containerRef.current!.clientWidth - 48 // padding
      const fitScale = Math.min(containerWidth / baseViewport.width, 3)
      setScale(Math.max(fitScale, 0.5))
    }

    fitWidth()
  }, [pdfDoc])

  const goPage = useCallback((delta: number) => {
    setCurrentPage(p => Math.max(1, Math.min(totalPages, p + delta)))
  }, [totalPages])

  const handleZoom = useCallback((delta: number) => {
    setScale(s => Math.max(0.5, Math.min(4, s + delta)))
  }, [])

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goPage(-1) }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); goPage(1) }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); handleZoom(0.2) }
      if (e.key === '-') { e.preventDefault(); handleZoom(-0.2) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goPage, handleZoom])

  // --- Render ---

  if (loading || pdfLoading) {
    return (
      <div style={{
        minHeight: '100vh', background: tokens.colors.bg.primary,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16,
      }}>
        <div style={{
          width: 40, height: 40, border: `3px solid ${tokens.colors.border.primary}`,
          borderTopColor: tokens.colors.accent.brand,
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
        {pdfLoading && (
          <p style={{ color: tokens.colors.text.secondary, fontSize: 14 }}>
            {isZh ? '正在加载文档...' : 'Loading document...'}
          </p>
        )}
      </div>
    )
  }

  if (error || !book) {
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

  const mode = getContentMode(book)
  const contentUrl = getContentUrl(book)

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
        {/* Back */}
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
            {book.title}
          </p>
          {book.author && (
            <p style={{ fontSize: 11, color: tokens.colors.text.tertiary, margin: 0 }}>
              {book.author}
            </p>
          )}
        </div>

        {/* PDF page controls */}
        {mode === 'pdf' && totalPages > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ToolbarBtn onClick={() => goPage(-1)} disabled={currentPage <= 1} label={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
            } />
            <span style={{ fontSize: 12, color: tokens.colors.text.secondary, minWidth: 60, textAlign: 'center' }}>
              {currentPage} / {totalPages}
            </span>
            <ToolbarBtn onClick={() => goPage(1)} disabled={currentPage >= totalPages} label={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
            } />
          </div>
        )}

        {/* Zoom controls for PDF */}
        {mode === 'pdf' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ToolbarBtn onClick={() => handleZoom(-0.2)} label={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            } />
            <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, minWidth: 38, textAlign: 'center' }}>
              {Math.round(scale * 100)}%
            </span>
            <ToolbarBtn onClick={() => handleZoom(0.2)} label={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            } />
          </div>
        )}

        {/* Dark mode toggle */}
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
      </div>

      {/* Content area */}
      {mode === 'pdf' ? (
        <div
          ref={containerRef}
          style={{
            flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center',
            padding: '24px 0',
            background: darkReader ? '#1a1a1a' : tokens.colors.bg.tertiary,
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: '100%',
              filter: darkReader ? 'invert(0.88) hue-rotate(180deg)' : 'none',
              boxShadow: tokens.shadow.lg,
              borderRadius: 2,
            }}
          />
        </div>
      ) : mode === 'web' && contentUrl ? (
        <div style={{
          flex: 1, position: 'relative',
          filter: darkReader ? 'invert(0.88) hue-rotate(180deg)' : 'none',
        }}>
          <iframe
            src={contentUrl}
            style={{
              width: '100%', height: '100%', border: 'none',
              position: 'absolute', inset: 0,
            }}
            title={book.title || 'Reader'}
            sandbox="allow-scripts allow-same-origin allow-forms"
            loading="lazy"
          />
        </div>
      ) : null}
    </div>
  )
}

function ToolbarBtn({ onClick, disabled, label }: {
  onClick: () => void
  disabled?: boolean
  label: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 8px', borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: 'transparent',
        color: disabled ? tokens.colors.text.tertiary : tokens.colors.text.secondary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: `all ${tokens.transition.fast}`,
      }}
    >
      {label}
    </button>
  )
}
