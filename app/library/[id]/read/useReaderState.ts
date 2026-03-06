'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { usePremium } from '@/lib/premium/hooks'
import { supabase } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import type {
  PDFDocumentProxy, PDFRenderTask, EpubTocEntry,
  BookInfo, ReadingTheme, FontSize, FontFamily, ContentMode, TocItem, HtmlChapter, PDFOutlineItem,
} from './types'
import { THEME_PRESETS, FONT_SIZES, FONT_FAMILIES } from './types'
import {
  lsGet, lsSet, syncProgressToServer, loadProgressFromServer,
  detectContentMode, parseHtmlIntoChapters, paginateText,
} from './helpers'

// ─── Hook ────────────────────────────────────────────────────────────

export function useReaderState() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { language, t } = useLanguage()
  const isZhLocale = language === 'zh'
  const { isFeaturesUnlocked: isPremium, isLoading: premiumLoading } = usePremium()

  // Book data
  const [book, setBook] = useState<BookInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsUpgrade, setNeedsUpgrade] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [contentMode, setContentMode] = useState<ContentMode>('none')

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfLoadProgress, setPdfLoadProgress] = useState(0)
  const [pageRendering, setPageRendering] = useState(false)
  const [toc, setToc] = useState<TocItem[]>([])

  // HTML/text state
  const [htmlContent, setHtmlContent] = useState<string>('')
  const [_htmlChapters, setHtmlChapters] = useState<HtmlChapter[]>([])
  const [htmlPages, setHtmlPages] = useState<string[]>([])
  const [htmlLoading, setHtmlLoading] = useState(false)

  // ePub state
  const [epubToc, setEpubToc] = useState<EpubTocEntry[]>([])
  const [epubGoToHref, setEpubGoToHref] = useState<string | null>(null)
  const [_epubReady, setEpubReady] = useState(false)
  const epubContainerRef = useRef<HTMLDivElement>(null)

  // Reading preferences (persisted)
  const [theme, setTheme] = useState<ReadingTheme>(() => lsGet('theme', 'dark'))
  const [fontSize, setFontSize] = useState<FontSize>(() => lsGet('fontSize', 'medium'))
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => lsGet('fontFamily', 'sans'))
  const [lineHeight, setLineHeight] = useState<'compact' | 'normal' | 'relaxed'>(() => lsGet('lineHeight', 'normal'))

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<number[]>(() => lsGet(`bookmarks_${id}`, []))
  const isCurrentPageBookmarked = bookmarks.includes(currentPage)

  // UI state
  const [showToolbar, setShowToolbar] = useState(true)
  const [showToc, setShowToc] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [flipDirection, setFlipDirection] = useState<'left' | 'right' | null>(null)

  // Bookshelf prompt
  const [showBookshelfPrompt, setShowBookshelfPrompt] = useState(false)
  const [addedToShelf, setAddedToShelf] = useState(false)
  const bookshelfPromptShown = useRef(false)

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<PDFRenderTask | null>(null)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const toolbarTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const contentAreaRef = useRef<HTMLDivElement>(null)
  const readerContainerRef = useRef<HTMLDivElement>(null)

  const themeColors = THEME_PRESETS[theme]
  const fontSizeConfig = FONT_SIZES[fontSize]
  const fontFamilyConfig = FONT_FAMILIES[fontFamily]

  // Persist preferences
  useEffect(() => { lsSet('theme', theme) }, [theme])
  useEffect(() => { lsSet('fontSize', fontSize) }, [fontSize])
  useEffect(() => { lsSet('fontFamily', fontFamily) }, [fontFamily])
  useEffect(() => { lsSet('lineHeight', lineHeight) }, [lineHeight])
  useEffect(() => { lsSet(`bookmarks_${id}`, bookmarks) }, [bookmarks, id])

  // Re-paginate HTML content when font size changes
  useEffect(() => {
    if (contentMode === 'html' && htmlContent) {
      const pages = paginateText(htmlContent, fontSize)
      setHtmlPages(pages)
      setTotalPages(pages.length)
    }
  }, [fontSize, htmlContent, contentMode])

  // ─── Fetch book ────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return
    setLoading(true)
    supabase.auth.getUser().then(({ data }) => setIsLoggedIn(!!data.user)).catch(() => { /* non-critical */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget

    fetch(`/api/library/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data.item) { setError(t('readerBookNotFound')); return }
        const item = data.item as BookInfo
        const mode = detectContentMode(item)
        if (mode === 'none') { setError(t('readerNoResource')); return }
        setBook(item)
        setContentMode(mode)
      })
      .catch(() => setError(t('readerLoadFailed')))
      .finally(() => setLoading(false))
  }, [id, language]) // eslint-disable-line react-hooks/exhaustive-deps

  // Check membership
  useEffect(() => {
    if (premiumLoading) return
    if (!isPremium && book && !book.is_free) {
      setNeedsUpgrade(true)
    } else {
      setNeedsUpgrade(false)
    }
  }, [isPremium, premiumLoading, book])

  // Bookshelf prompt after 2 min
  useEffect(() => {
    if (!book || needsUpgrade || addedToShelf || bookshelfPromptShown.current) return
    const timer = setTimeout(() => {
      if (!bookshelfPromptShown.current) {
        bookshelfPromptShown.current = true
        setShowBookshelfPrompt(true)
      }
    }, 120000)
    return () => clearTimeout(timer)
  }, [book, needsUpgrade, addedToShelf])

  const handleAddToShelf = useCallback(async () => {
    if (!id || !isLoggedIn) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch(`/api/library/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ status: 'want_to_read' }),
      })
      if (res.ok) { setAddedToShelf(true); setShowBookshelfPrompt(false) }
    } catch { /* intentionally empty */ }
  }, [id, isLoggedIn])

  // ─── Extract TOC from PDF ─────────────────────────────────────────

  const extractToc = useCallback(async (doc: PDFDocumentProxy, outline: PDFOutlineItem[], level: number): Promise<TocItem[]> => {
    const items: TocItem[] = []
    for (const entry of outline) {
      let pageIndex = 0
      try {
        if (entry.dest) {
          const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest
          if (dest) { pageIndex = await doc.getPageIndex(dest[0]) }
        }
      } catch { /* intentionally empty */ }
      const children = entry.items?.length ? await extractToc(doc, entry.items, level + 1) : undefined
      items.push({ title: entry.title, pageIndex, level, children })
    }
    return items
  }, [])

  // ─── Load PDF ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!book || contentMode !== 'pdf') return
    const cdnContentUrl = book.content_url?.includes('cdn.arenafi.org/') ? book.content_url : null
    const rawUrl = cdnContentUrl
      || book.pdf_url
      || (book.file_key ? `https://iknktzifjdyujdccyhsv.supabase.co/storage/v1/object/public/library-files/${book.file_key}` : null)
      || (book.content_url?.endsWith('.pdf') ? book.content_url : null)
    const url = rawUrl && (rawUrl.startsWith('https://cdn.arenafi.org/') || rawUrl.startsWith('https://arxiv.org/'))
      ? `/api/cdn-proxy?url=${encodeURIComponent(rawUrl)}`
      : rawUrl
    if (!url) return

    setPdfLoading(true)
    let cancelled = false

    async function loadPdf() {
      try {
        const pdfjsLib = await import(/* webpackIgnore: true */ 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs' as any)
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
        const loadingTask = pdfjsLib.getDocument({ url: url!, disableAutoFetch: false, disableStream: false })
        loadingTask.onProgress = (progress: { loaded: number; total: number }) => {
          if (progress.total > 0) {
            setPdfLoadProgress(Math.round((progress.loaded / progress.total) * 100))
          }
        }
        const doc = await loadingTask.promise
        if (cancelled) return
        setPdfDoc(doc)
        pdfDocRef.current = doc
        setTotalPages(doc.numPages)

        try {
          const outline = await doc.getOutline()
          if (outline?.length > 0) {
            const tocItems = await extractToc(doc, outline, 0)
            setToc(tocItems)
          }
        } catch { /* intentionally empty */ }

        const serverProgress = await loadProgressFromServer(id)
        if (serverProgress && serverProgress.page > 1 && serverProgress.page <= doc.numPages) {
          setCurrentPage(serverProgress.page)
        } else {
          const saved = lsGet<{ page: number } | null>(`progress_${id}`, null)
          if (saved && saved.page > 1 && saved.page <= doc.numPages) {
            setCurrentPage(saved.page)
          }
        }
      } catch {
        if (!cancelled) setError(t('readerPdfLoadFailed'))
      } finally {
        if (!cancelled) setPdfLoading(false)
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [book, contentMode, language, id, extractToc]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Load HTML/text content ────────────────────────────────────────
  useEffect(() => {
    if (!book || contentMode !== 'html') return
    const url = book.content_url || book.source_url
    if (!url) return

    setHtmlLoading(true)
    let cancelled = false

    async function loadHtml() {
      try {
        const res = await fetch(url!)
        if (!res.ok) throw new Error('Failed to fetch')
        const contentType = res.headers.get('content-type') || ''
        let text: string

        if (contentType.includes('html')) {
          text = await res.text()
        } else {
          const raw = await res.text()
          text = raw.split(/\n\n+/).map(p => `<p>${p.trim()}</p>`).join('\n')
        }

        if (cancelled) return
        setHtmlContent(text)

        const chapters = parseHtmlIntoChapters(text)
        setHtmlChapters(chapters)

        if (chapters.length > 1) {
          const tocItems: TocItem[] = chapters.map((ch, i) => ({
            title: ch.title || `${t('readerChapterPrefix')}${i + 1}${t('readerChapterSuffix')}`,
            pageIndex: i,
            level: 0,
          }))
          setToc(tocItems)
        }

        const allText = chapters.map(c => c.content).join('\n\n')
        const pages = paginateText(allText, fontSize)
        setHtmlPages(pages)
        setTotalPages(pages.length)

        const serverProgress = await loadProgressFromServer(id)
        if (serverProgress && serverProgress.page > 1 && serverProgress.page <= pages.length) {
          setCurrentPage(serverProgress.page)
        } else {
          const saved = lsGet<{ page: number } | null>(`progress_${id}`, null)
          if (saved && saved.page > 1 && saved.page <= pages.length) {
            setCurrentPage(saved.page)
          }
        }
      } catch {
        if (!cancelled) setError(t('readerHtmlLoadFailed'))
      } finally {
        if (!cancelled) setHtmlLoading(false)
      }
    }

    loadHtml()
    return () => { cancelled = true }
  }, [book, contentMode, language, id, fontSize]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render PDF page ──────────────────────────────────────────────
  const renderCurrentPage = useCallback(async () => {
    const doc = pdfDocRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas) return

    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel() } catch { /* intentionally empty */ }
    }

    setPageRendering(true)
    try {
      const page = await doc.getPage(currentPage)
      const baseViewport = page.getViewport({ scale: 1 })
      const container = canvas.parentElement
      if (!container) return
      const maxW = container.clientWidth - 16
      const maxH = container.clientHeight - 16
      const scale = Math.min(maxW / baseViewport.width, maxH / baseViewport.height)
      const viewport = page.getViewport({ scale })

      const dpr = window.devicePixelRatio || 1
      canvas.width = viewport.width * dpr
      canvas.height = viewport.height * dpr
      canvas.style.width = viewport.width + 'px'
      canvas.style.height = viewport.height + 'px'

      const ctx = canvas.getContext('2d')!
      ctx.scale(dpr, dpr)

      const task = page.render({ canvasContext: ctx, viewport })
      renderTaskRef.current = task
      await task.promise

      if (id) {
        lsSet(`progress_${id}`, { page: currentPage, total: totalPages, lastRead: Date.now() })
        syncProgressToServer(id, currentPage, totalPages)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'RenderingCancelledException') logger.error('Render error', err)
    } finally {
      setPageRendering(false)
    }
  }, [currentPage, totalPages, id])

  // Render PDF page when ready
  useEffect(() => {
    if (contentMode !== 'pdf' || !pdfDoc || totalPages <= 0) return
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    if (!container) return

    if (container.clientWidth > 0 && container.clientHeight > 0) {
      renderCurrentPage()
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        renderCurrentPage()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [pdfDoc, currentPage, totalPages, renderCurrentPage, contentMode])

  // Save HTML progress on page change
  useEffect(() => {
    if (contentMode === 'html' && id && totalPages > 0) {
      lsSet(`progress_${id}`, { page: currentPage, total: totalPages, lastRead: Date.now() })
      syncProgressToServer(id, currentPage, totalPages)
    }
  }, [contentMode, currentPage, totalPages, id])

  // Sync on unload
  useEffect(() => {
    if (!id) return
    const handleUnload = () => {
      if (totalPages > 0) syncProgressToServer(id, currentPage, totalPages)
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [id, currentPage, totalPages])

  // Re-render PDF on resize
  useEffect(() => {
    if (contentMode !== 'pdf' || !pdfDoc) return
    let timeout: ReturnType<typeof setTimeout>
    const onResize = () => { clearTimeout(timeout); timeout = setTimeout(renderCurrentPage, 200) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); clearTimeout(timeout) }
  }, [pdfDoc, renderCurrentPage, contentMode])

  // ─── Navigation ────────────────────────────────────────────────────
  const goNext = useCallback(() => {
    if (currentPage < totalPages) {
      setFlipDirection('left')
      setCurrentPage(p => p + 1)
      setTimeout(() => setFlipDirection(null), 300)
    }
  }, [currentPage, totalPages])

  const goPrev = useCallback(() => {
    if (currentPage > 1) {
      setFlipDirection('right')
      setCurrentPage(p => p - 1)
      setTimeout(() => setFlipDirection(null), 300)
    }
  }, [currentPage])

  const goToPage = useCallback((page: number) => {
    const p = Math.max(1, Math.min(totalPages, page))
    setCurrentPage(p)
    setShowToc(false)
  }, [totalPages])

  // Touch swipe
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = e.changedTouches[0].clientY - touchStartY.current
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx < 0) goNext()
      else goPrev()
    }
  }, [goNext, goPrev])

  // Click zones
  const handlePageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, a')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    if (x < 0.25) goPrev()
    else if (x > 0.75) goNext()
    else setShowToolbar(p => !p)
  }, [goNext, goPrev])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen()
  }, [])

  const toggleBookmark = useCallback(() => {
    setBookmarks(prev => {
      if (prev.includes(currentPage)) return prev.filter(p => p !== currentPage)
      return [...prev, currentPage].sort((a, b) => a - b)
    })
  }, [currentPage])

  // Keyboard
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev() }
      if (e.key === 'Home') { e.preventDefault(); goToPage(1) }
      if (e.key === 'End') { e.preventDefault(); goToPage(totalPages) }
      if (e.key === 'Escape') { setShowToc(false); setShowSettings(false) }
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey) toggleFullscreen()
      if (e.key === 'b' && !e.metaKey && !e.ctrlKey) toggleBookmark()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goNext, goPrev, goToPage, totalPages, toggleFullscreen, toggleBookmark])

  // Auto-focus reader container
  useEffect(() => {
    if (!loading && !pdfLoading && !htmlLoading && book && !needsUpgrade && !error) {
      const t = setTimeout(() => readerContainerRef.current?.focus(), 100)
      return () => clearTimeout(t)
    }
  }, [loading, pdfLoading, htmlLoading, book, needsUpgrade, error])

  // Auto-hide toolbar
  useEffect(() => {
    if (showToolbar) {
      clearTimeout(toolbarTimeoutRef.current)
      toolbarTimeoutRef.current = setTimeout(() => setShowToolbar(false), 4000)
    }
    return () => clearTimeout(toolbarTimeoutRef.current)
  }, [showToolbar, currentPage])

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    goToPage(Math.max(1, Math.round(ratio * totalPages)))
  }, [totalPages, goToPage])

  // Derived
  const isLoading = loading || pdfLoading || htmlLoading || premiumLoading
  const progressPercent = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0
  const currentHtmlPage = contentMode === 'html' ? (htmlPages[currentPage - 1] || '') : ''

  return {
    // IDs & routing
    id, router, t, isZhLocale,

    // Book data & status
    book, loading: isLoading, error, needsUpgrade, contentMode,
    pdfLoading, pdfLoadProgress, htmlLoading, premiumLoading,

    // PDF
    pdfDoc, canvasRef, pageRendering,

    // Pages
    totalPages, currentPage, progressPercent, currentHtmlPage,

    // TOC
    toc, epubToc, showToc, setShowToc,

    // ePub
    epubContainerRef, epubGoToHref, setEpubGoToHref,
    setEpubReady, setCurrentPage, setTotalPages, setEpubToc,

    // Preferences
    theme, setTheme, fontSize, setFontSize,
    fontFamily, setFontFamily, lineHeight, setLineHeight,
    themeColors, fontSizeConfig, fontFamilyConfig,

    // Bookmarks
    bookmarks, isCurrentPageBookmarked, toggleBookmark,

    // UI state
    showToolbar, setShowToolbar, showSettings, setShowSettings,
    flipDirection,

    // Bookshelf
    showBookshelfPrompt, setShowBookshelfPrompt, addedToShelf, handleAddToShelf,

    // Refs
    contentAreaRef, readerContainerRef,

    // Navigation
    goNext, goPrev, goToPage,
    handleTouchStart, handleTouchEnd, handlePageClick,
    handleProgressClick, toggleFullscreen,
  }
}
