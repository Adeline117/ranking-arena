'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

// ─── Types ───────────────────────────────────────────────────────────

type BookInfo = {
  id: string
  title: string
  author: string | null
  pdf_url: string | null
  source_url: string | null
  category: string
}

type ContentMode = 'pdf' | 'web' | 'none'

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'

type TocItem = {
  title: string
  pageIndex: number
  level: number
  children?: TocItem[]
}

// ─── Constants ───────────────────────────────────────────────────────

const THEME_PRESETS: Record<ReadingTheme, { bg: string; text: string; label: string; labelZh: string; dot: string }> = {
  white:  { bg: '#FFFFFF', text: '#1a1a1a', label: 'White',  labelZh: '白色',   dot: '#FFFFFF' },
  sepia:  { bg: '#F4ECD8', text: '#5b4636', label: 'Sepia',  labelZh: '暖黄',   dot: '#F4ECD8' },
  dark:   { bg: '#1a1a2e', text: '#d4d4d8', label: 'Dark',   labelZh: '暗黑',   dot: '#1a1a2e' },
  green:  { bg: '#C7EDCC', text: '#2d4a32', label: 'Green',  labelZh: '护眼绿', dot: '#C7EDCC' },
}

const FONT_SIZES = [14, 16, 18, 20, 24]
const LINE_HEIGHTS: { value: number; label: string; labelZh: string }[] = [
  { value: 1.4, label: 'Compact', labelZh: '紧凑' },
  { value: 1.6, label: 'Normal',  labelZh: '正常' },
  { value: 2.0, label: 'Relaxed', labelZh: '宽松' },
]

const LS_PREFIX = 'reader_'

// ─── Helpers ─────────────────────────────────────────────────────────

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

function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const v = localStorage.getItem(LS_PREFIX + key)
    return v ? JSON.parse(v) : fallback
  } catch { return fallback }
}

function lsSet(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)) } catch {}
}

// ─── SVG Icons (geometric, no emoji) ─────────────────────────────────

function IconBack() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
}
function IconToc() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
}
function IconFont() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 20h16"/><path d="M7 4h10l-5 16"/></svg>
}
function IconFullscreen() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
}
function IconClose() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
}

// ─── Main Component ──────────────────────────────────────────────────

export default function ReadPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  // Book data
  const [book, setBook] = useState<BookInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set())
  const [currentVisiblePage, setCurrentVisiblePage] = useState(1)
  const [toc, setToc] = useState<TocItem[]>([])

  // Reading preferences
  const [theme, setTheme] = useState<ReadingTheme>(() => lsGet('theme', 'white'))
  const [fontSize, setFontSize] = useState(() => lsGet('fontSize', 2)) // index into FONT_SIZES
  const [lineHeight, setLineHeight] = useState(() => lsGet('lineHeight', 1)) // index into LINE_HEIGHTS

  // UI state
  const [showToolbar, setShowToolbar] = useState(true)
  const [showToc, setShowToc] = useState(false)
  const [showFontPanel, setShowFontPanel] = useState(false)
  const [showResumePrompt, setShowResumePrompt] = useState(false)
  const [savedScrollRatio, setSavedScrollRatio] = useState<number | null>(null)
  const [progressPercent, setProgressPercent] = useState(0)
  const [isDraggingProgress, setIsDraggingProgress] = useState(false)

  // Refs
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const lastScrollY = useRef(0)
  const toolbarTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pdfDocRef = useRef<any>(null)

  const themeColors = THEME_PRESETS[theme]

  // Persist preferences
  useEffect(() => { lsSet('theme', theme) }, [theme])
  useEffect(() => { lsSet('fontSize', fontSize) }, [fontSize])
  useEffect(() => { lsSet('lineHeight', lineHeight) }, [lineHeight])

  // ─── Fetch book ────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return
    setLoading(true)
    fetch(`/api/library/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data.item) { setError(isZh ? '未找到该书籍' : 'Book not found'); return }
        const item = data.item
        if (!item.pdf_url && !item.source_url) { setError(isZh ? '该书籍暂无阅读资源' : 'No reading resource available'); return }
        setBook(item)
      })
      .catch(() => setError(isZh ? '加载失败' : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [id, isZh])

  // ─── Load PDF ──────────────────────────────────────────────────────
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
        const doc = await pdfjsLib.getDocument({ url: url || '', disableAutoFetch: false, disableStream: false }).promise
        if (cancelled) return
        setPdfDoc(doc)
        pdfDocRef.current = doc
        setTotalPages(doc.numPages)

        // Extract TOC
        try {
          const outline = await doc.getOutline()
          if (outline && outline.length > 0) {
            const tocItems = await extractToc(doc, outline, 0)
            setToc(tocItems)
          }
        } catch {}

        // Check saved progress
        const saved = lsGet(`progress_${id}`, null) as number | null
        if (saved !== null && saved > 0.02) {
          setSavedScrollRatio(saved)
          setShowResumePrompt(true)
        }
      } catch (err: any) {
        if (cancelled) return
        setError(isZh ? '无法加载 PDF，可能是跨域限制' : 'Unable to load PDF, possibly due to CORS restrictions')
      } finally {
        if (!cancelled) setPdfLoading(false)
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [book, isZh, id])

  async function extractToc(doc: any, outline: any[], level: number): Promise<TocItem[]> {
    const items: TocItem[] = []
    for (const entry of outline) {
      let pageIndex = 0
      try {
        if (entry.dest) {
          const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest
          if (dest) {
            const ref = dest[0]
            pageIndex = await doc.getPageIndex(ref)
          }
        }
      } catch {}
      const children = entry.items?.length ? await extractToc(doc, entry.items, level + 1) : undefined
      items.push({ title: entry.title, pageIndex, level, children })
    }
    return items
  }

  // ─── Render a single PDF page ──────────────────────────────────────
  const renderPage = useCallback(async (pageNum: number, container: HTMLDivElement) => {
    if (!pdfDocRef.current || renderedPages.has(pageNum)) return
    setRenderedPages(prev => new Set(prev).add(pageNum))

    try {
      const page = await pdfDocRef.current.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })
      const containerWidth = Math.min(container.parentElement?.clientWidth || 800, 900) - 48
      const scale = containerWidth / baseViewport.width
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement('canvas')
      canvas.width = viewport.width * (window.devicePixelRatio || 1)
      canvas.height = viewport.height * (window.devicePixelRatio || 1)
      canvas.style.width = viewport.width + 'px'
      canvas.style.height = viewport.height + 'px'
      canvas.style.display = 'block'

      const ctx = canvas.getContext('2d')!
      ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1)

      container.innerHTML = ''
      container.appendChild(canvas)

      await page.render({ canvasContext: ctx, viewport }).promise
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('Render error page', pageNum, err)
      }
    }
  }, [renderedPages])

  // ─── IntersectionObserver for lazy rendering ───────────────────────
  useEffect(() => {
    if (!pdfDoc || totalPages === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          const pageNum = Number(entry.target.getAttribute('data-page'))
          if (entry.isIntersecting && pageNum) {
            const container = entry.target as HTMLDivElement
            renderPage(pageNum, container)
          }
        })
      },
      { root: scrollContainerRef.current, rootMargin: '200px 0px', threshold: 0 }
    )

    pageRefs.current.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [pdfDoc, totalPages, renderPage])

  // ─── Re-render all pages on resize ─────────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return
    const handleResize = () => {
      setRenderedPages(new Set())
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [pdfDoc])

  // ─── Scroll tracking: progress, current page, toolbar auto-hide ───
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        const { scrollTop, scrollHeight, clientHeight } = container
        const maxScroll = scrollHeight - clientHeight
        const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0
        setProgressPercent(Math.round(ratio * 100))

        // Save progress
        if (id) lsSet(`progress_${id}`, ratio)

        // Determine current visible page
        if (totalPages > 0) {
          const pageEst = Math.max(1, Math.min(totalPages, Math.ceil(ratio * totalPages) || 1))
          setCurrentVisiblePage(pageEst)
        }

        // Toolbar auto-hide
        const delta = scrollTop - lastScrollY.current
        if (delta > 30) {
          setShowToolbar(false)
          setShowFontPanel(false)
        } else if (delta < -10) {
          setShowToolbar(true)
        }
        lastScrollY.current = scrollTop
      })
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [totalPages, id])

  // ─── Resume reading ────────────────────────────────────────────────
  const resumeReading = useCallback(() => {
    if (savedScrollRatio === null) return
    const container = scrollContainerRef.current
    if (!container) return
    // Delay to let pages render
    setTimeout(() => {
      const maxScroll = container.scrollHeight - container.clientHeight
      container.scrollTo({ top: maxScroll * savedScrollRatio, behavior: 'smooth' })
    }, 500)
    setShowResumePrompt(false)
  }, [savedScrollRatio])

  // ─── Jump to page ──────────────────────────────────────────────────
  const jumpToPage = useCallback((pageIndex: number) => {
    const el = pageRefs.current.get(pageIndex + 1)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    setShowToc(false)
  }, [])

  // ─── Progress bar click/drag ───────────────────────────────────────
  const handleProgressInteraction = useCallback((clientX: number, barElement: HTMLDivElement) => {
    const rect = barElement.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const container = scrollContainerRef.current
    if (container) {
      const maxScroll = container.scrollHeight - container.clientHeight
      container.scrollTo({ top: maxScroll * ratio })
    }
  }, [])

  // ─── Fullscreen ────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      document.documentElement.requestFullscreen()
    }
  }, [])

  // ─── Keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setShowToc(false); setShowFontPanel(false) }
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey) toggleFullscreen()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [toggleFullscreen])

  // ─── Render ────────────────────────────────────────────────────────

  if (loading || pdfLoading) {
    return (
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ width: 40, height: 40, border: `3px solid ${tokens.colors.border.primary}`, borderTopColor: tokens.colors.accent.brand, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <p style={{ color: tokens.colors.text.secondary, fontSize: 14 }}>
          {pdfLoading ? (isZh ? '正在加载文档...' : 'Loading document...') : (isZh ? '加载中...' : 'Loading...')}
        </p>
      </div>
    )
  }

  if (error || !book) {
    return (
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" style={{ marginBottom: 16, opacity: 0.5 }}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <p style={{ color: tokens.colors.text.secondary, fontSize: 16, marginBottom: 16, textAlign: 'center' }}>{error || (isZh ? '无法加载阅读器' : 'Unable to load reader')}</p>
        <Link href={`/library/${id}`} style={{ padding: '10px 24px', borderRadius: tokens.radius.lg, background: tokens.colors.accent.brand, color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
          {isZh ? '返回书籍详情' : 'Back to Book'}
        </Link>
      </div>
    )
  }

  const mode = getContentMode(book)
  const contentUrl = getContentUrl(book)
  const currentTheme = THEME_PRESETS[theme]

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: currentTheme.bg, color: currentTheme.text, transition: 'background 0.4s ease, color 0.4s ease' }}>

      {/* ─── Toolbar ─────────────────────────────────────── */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        transform: showToolbar ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 0.3s ease',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px',
          background: theme === 'dark' ? 'rgba(26,26,46,0.95)' : 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          borderBottom: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
        }}>
          {/* Back */}
          <button onClick={() => router.push(`/library/${id}`)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            color: currentTheme.text, background: 'none', border: 'none', cursor: 'pointer',
            padding: '6px 8px', borderRadius: tokens.radius.md, fontSize: 13, opacity: 0.7,
          }}>
            <IconBack /> {isZh ? '返回' : 'Back'}
          </button>

          {/* Title */}
          <div style={{ flex: 1, overflow: 'hidden', textAlign: 'center' }}>
            <p style={{ fontSize: 14, fontWeight: 600, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{book.title}</p>
            {book.author && <p style={{ fontSize: 11, margin: 0, opacity: 0.5 }}>{book.author}</p>}
          </div>

          {/* Theme picker */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {(Object.keys(THEME_PRESETS) as ReadingTheme[]).map(t => (
              <button key={t} onClick={() => setTheme(t)} title={isZh ? THEME_PRESETS[t].labelZh : THEME_PRESETS[t].label} style={{
                width: 22, height: 22, borderRadius: '50%', border: theme === t ? `2px solid ${tokens.colors.accent.brand}` : `1px solid rgba(128,128,128,0.3)`,
                background: THEME_PRESETS[t].dot, cursor: 'pointer', padding: 0, transition: 'border 0.2s',
              }} />
            ))}
          </div>

          {/* Font controls toggle */}
          <button onClick={() => setShowFontPanel(p => !p)} style={{
            display: 'inline-flex', alignItems: 'center', color: currentTheme.text,
            background: showFontPanel ? (theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)') : 'none',
            border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: tokens.radius.md, opacity: 0.7,
          }}>
            <IconFont />
          </button>

          {/* TOC toggle */}
          {mode === 'pdf' && toc.length > 0 && (
            <button onClick={() => setShowToc(p => !p)} style={{
              display: 'inline-flex', alignItems: 'center', color: currentTheme.text,
              background: showToc ? (theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)') : 'none',
              border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: tokens.radius.md, opacity: 0.7,
            }}>
              <IconToc />
            </button>
          )}

          {/* Fullscreen */}
          <button onClick={toggleFullscreen} style={{
            display: 'inline-flex', alignItems: 'center', color: currentTheme.text,
            background: 'none', border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: tokens.radius.md, opacity: 0.7,
          }}>
            <IconFullscreen />
          </button>
        </div>

        {/* Font control panel */}
        {showFontPanel && (
          <div style={{
            padding: '12px 20px',
            background: theme === 'dark' ? 'rgba(26,26,46,0.95)' : 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            borderBottom: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
            display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'center',
          }}>
            {/* Font size */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, opacity: 0.6 }}>{isZh ? '字号' : 'Size'}</span>
              <div style={{ display: 'flex', gap: 2 }}>
                {FONT_SIZES.map((s, i) => (
                  <button key={s} onClick={() => setFontSize(i)} style={{
                    width: 32, height: 32, borderRadius: tokens.radius.sm,
                    border: fontSize === i ? `2px solid ${tokens.colors.accent.brand}` : `1px solid rgba(128,128,128,0.2)`,
                    background: fontSize === i ? (theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.04)') : 'transparent',
                    color: currentTheme.text, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                  }}>{s}</button>
                ))}
              </div>
            </div>

            {/* Line height */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, opacity: 0.6 }}>{isZh ? '行距' : 'Spacing'}</span>
              <div style={{ display: 'flex', gap: 2 }}>
                {LINE_HEIGHTS.map((lh, i) => (
                  <button key={lh.value} onClick={() => setLineHeight(i)} style={{
                    padding: '4px 10px', borderRadius: tokens.radius.sm,
                    border: lineHeight === i ? `2px solid ${tokens.colors.accent.brand}` : `1px solid rgba(128,128,128,0.2)`,
                    background: lineHeight === i ? (theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.04)') : 'transparent',
                    color: currentTheme.text, cursor: 'pointer', fontSize: 11,
                  }}>{isZh ? lh.labelZh : lh.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── TOC Slide-out ───────────────────────────────── */}
      {showToc && (
        <>
          <div onClick={() => setShowToc(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200 }} />
          <div style={{
            position: 'fixed', top: 0, left: 0, bottom: 0, width: 300, maxWidth: '80vw', zIndex: 201,
            background: theme === 'dark' ? '#1e1e3a' : '#fff',
            boxShadow: tokens.shadow.xl, overflow: 'auto', padding: '16px 0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px 12px', borderBottom: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}` }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: currentTheme.text }}>{isZh ? '目录' : 'Table of Contents'}</span>
              <button onClick={() => setShowToc(false)} style={{ background: 'none', border: 'none', color: currentTheme.text, cursor: 'pointer', padding: 4, opacity: 0.6 }}><IconClose /></button>
            </div>
            <div style={{ padding: '8px 0' }}>
              {renderTocItems(toc)}
            </div>
          </div>
        </>
      )}

      {/* ─── Resume prompt ────────────────────────────────── */}
      {showResumePrompt && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 300,
          background: theme === 'dark' ? '#2a2a4a' : '#fff',
          boxShadow: tokens.shadow.lg, borderRadius: tokens.radius.lg,
          padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12,
          border: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`,
        }}>
          <span style={{ fontSize: 13, color: currentTheme.text }}>{isZh ? '继续上次阅读?' : 'Continue where you left off?'}</span>
          <button onClick={resumeReading} style={{
            padding: '6px 14px', borderRadius: tokens.radius.md,
            background: tokens.colors.accent.brand, color: '#fff', border: 'none',
            cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>{isZh ? '继续' : 'Resume'}</button>
          <button onClick={() => setShowResumePrompt(false)} style={{
            padding: '6px 14px', borderRadius: tokens.radius.md,
            background: 'transparent', color: currentTheme.text, border: `1px solid rgba(128,128,128,0.3)`,
            cursor: 'pointer', fontSize: 12, opacity: 0.7,
          }}>{isZh ? '从头开始' : 'Start over'}</button>
        </div>
      )}

      {/* ─── Content area ─────────────────────────────────── */}
      {mode === 'pdf' ? (
        <div
          ref={scrollContainerRef}
          onClick={() => setShowToolbar(p => !p)}
          style={{
            flex: 1, overflow: 'auto', paddingTop: 56, paddingBottom: 48,
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 0' }}>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
              <div
                key={pageNum}
                data-page={pageNum}
                ref={el => { if (el) pageRefs.current.set(pageNum, el) }}
                style={{
                  minHeight: 400, marginBottom: 8, display: 'flex',
                  justifyContent: 'center', alignItems: 'flex-start',
                  background: theme === 'white' ? '#fff' : 'transparent',
                  boxShadow: theme !== 'dark' ? tokens.shadow.sm : 'none',
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
        </div>
      ) : mode === 'web' && contentUrl ? (
        <div ref={scrollContainerRef} style={{ flex: 1, position: 'relative', paddingTop: 56, paddingBottom: 48 }}>
          <iframe
            src={contentUrl}
            style={{ width: '100%', height: 'calc(100vh - 104px)', border: 'none' }}
            title={book.title || 'Reader'}
            sandbox="allow-scripts allow-same-origin allow-forms"
            loading="lazy"
          />
        </div>
      ) : null}

      {/* ─── Bottom progress bar ──────────────────────────── */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        background: theme === 'dark' ? 'rgba(26,26,46,0.95)' : 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        borderTop: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
        padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        {/* Page indicator */}
        {mode === 'pdf' && totalPages > 0 && (
          <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', minWidth: 60 }}>
            {currentVisiblePage} / {totalPages}
          </span>
        )}

        {/* Progress bar */}
        <div
          style={{ flex: 1, height: 4, background: theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', borderRadius: 2, cursor: 'pointer', position: 'relative' }}
          onMouseDown={(e) => {
            setIsDraggingProgress(true)
            handleProgressInteraction(e.clientX, e.currentTarget)
            const bar = e.currentTarget
            const onMove = (ev: MouseEvent) => handleProgressInteraction(ev.clientX, bar)
            const onUp = () => { setIsDraggingProgress(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
          onTouchStart={(e) => {
            const bar = e.currentTarget
            handleProgressInteraction(e.touches[0].clientX, bar)
            const onMove = (ev: TouchEvent) => handleProgressInteraction(ev.touches[0].clientX, bar)
            const onEnd = () => { bar.removeEventListener('touchmove', onMove); bar.removeEventListener('touchend', onEnd) }
            bar.addEventListener('touchmove', onMove, { passive: true })
            bar.addEventListener('touchend', onEnd)
          }}
        >
          <div style={{
            height: '100%', borderRadius: 2, width: `${progressPercent}%`,
            background: tokens.colors.accent.brand, transition: isDraggingProgress ? 'none' : 'width 0.2s ease',
          }} />
          {/* Drag handle */}
          <div style={{
            position: 'absolute', top: '50%', left: `${progressPercent}%`, transform: 'translate(-50%, -50%)',
            width: 12, height: 12, borderRadius: '50%', background: tokens.colors.accent.brand,
            boxShadow: tokens.shadow.sm, opacity: isDraggingProgress ? 1 : 0,
            transition: 'opacity 0.2s',
          }} />
        </div>

        {/* Percentage */}
        <span style={{ fontSize: 11, opacity: 0.6, minWidth: 32, textAlign: 'right' }}>{progressPercent}%</span>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        * { -webkit-tap-highlight-color: transparent; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.2); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.4); }
      `}</style>
    </div>
  )

  function renderTocItems(items: TocItem[]): React.ReactNode {
    return items.map((item, i) => (
      <div key={i}>
        <button
          onClick={() => jumpToPage(item.pageIndex)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '8px 16px',
            paddingLeft: 16 + item.level * 16,
            background: 'none', border: 'none', color: currentTheme.text,
            cursor: 'pointer', fontSize: 13, opacity: 0.8,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {item.title}
          <span style={{ float: 'right', opacity: 0.4, fontSize: 11 }}>{item.pageIndex + 1}</span>
        </button>
        {item.children && renderTocItems(item.children)}
      </div>
    ))
  }
}
