'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { usePremium } from '@/lib/premium/hooks'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'

// ─── Types ───────────────────────────────────────────────────────────

type BookInfo = {
  id: string
  title: string
  author: string | null
  pdf_url: string | null
  source_url: string | null
  category: string
  is_free: boolean
}

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'

type TocItem = {
  title: string
  pageIndex: number
  level: number
  children?: TocItem[]
}

// ─── Constants ───────────────────────────────────────────────────────

const THEME_PRESETS: Record<ReadingTheme, { bg: string; pageBg: string; text: string; label: string; labelZh: string; dot: string }> = {
  white:  { bg: '#e8e4df', pageBg: '#FFFFFF', text: '#1a1a1a', label: 'White',  labelZh: '白色',   dot: '#FFFFFF' },
  sepia:  { bg: '#d4cbb8', pageBg: '#F4ECD8', text: '#5b4636', label: 'Sepia',  labelZh: '暖黄',   dot: '#F4ECD8' },
  dark:   { bg: '#0f0f1a', pageBg: '#1a1a2e', text: '#d4d4d8', label: 'Dark',   labelZh: '暗黑',   dot: '#1a1a2e' },
  green:  { bg: '#a8d4ad', pageBg: '#C7EDCC', text: '#2d4a32', label: 'Green',  labelZh: '护眼绿', dot: '#C7EDCC' },
}

const LS_PREFIX = 'reader_'

// ─── Helpers ─────────────────────────────────────────────────────────

function getContentUrl(book: BookInfo): string | null {
  return book.pdf_url || book.source_url || null
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
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)) } catch { /* intentionally empty */ }
}

// UF20: Server-side reading progress sync
async function syncProgressToServer(bookId: string, page: number, totalPages: number) {
  try {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    await supabase.from('reading_progress').upsert({
      user_id: session.user.id,
      book_id: bookId,
      current_page: page,
      total_pages: totalPages,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,book_id' })
  } catch { /* intentionally empty */ }
}

async function loadProgressFromServer(bookId: string): Promise<{ page: number; total: number } | null> {
  try {
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return null
    const { data } = await supabase
      .from('reading_progress')
      .select('current_page, total_pages')
      .eq('user_id', session.user.id)
      .eq('book_id', bookId)
      .maybeSingle()
    if (data) return { page: data.current_page, total: data.total_pages }
  } catch { /* intentionally empty */ }
  return null
}

// ─── SVG Icons ───────────────────────────────────────────────────────

function IconBack() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
}
function IconToc() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
}
function IconSettings() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
}
function IconFullscreen() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
}
function IconClose() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
}
function IconChevronLeft() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
}
function IconChevronRight() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
}

// ─── Main Component ──────────────────────────────────────────────────

export default function ReadPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const { isPremium, isLoading: premiumLoading } = usePremium()

  // Book data
  const [book, setBook] = useState<BookInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [needsUpgrade, setNeedsUpgrade] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pageRendering, setPageRendering] = useState(false)
  const [toc, setToc] = useState<TocItem[]>([])

  // Reading preferences
  const [theme, setTheme] = useState<ReadingTheme>(() => lsGet('theme', 'dark'))

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
  const pdfDocRef = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const toolbarTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pageInputRef = useRef<HTMLInputElement>(null)

  const themeColors = THEME_PRESETS[theme]

  // Persist preferences
  useEffect(() => { lsSet('theme', theme) }, [theme])

  // ─── Fetch book ────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return
    setLoading(true)
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => setIsLoggedIn(!!data.user))

    fetch(`/api/library/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data.item) { setError(isZh ? '未找到该书籍' : 'Book not found'); return }
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

  // Check membership - free books are accessible to everyone
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
      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
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

  // ─── Load PDF ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!book) return
    const url = getContentUrl(book)
    if (!url) return

    setPdfLoading(true)
    let cancelled = false

    async function loadPdf() {
      try {
        const pdfjsLib = await import('pdfjs-dist')
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
        const doc = await pdfjsLib.getDocument({ url: url!, disableAutoFetch: false, disableStream: false }).promise
        if (cancelled) return
        setPdfDoc(doc)
        pdfDocRef.current = doc
        setTotalPages(doc.numPages)

        // Extract TOC
        try {
          const outline = await doc.getOutline()
          if (outline?.length > 0) {
            const tocItems = await extractToc(doc, outline, 0)
            setToc(tocItems)
          }
        } catch { /* intentionally empty */ }

        // UF20: Restore reading progress - server first, fallback to localStorage
        const serverProgress = await loadProgressFromServer(id)
        if (serverProgress && serverProgress.page > 1 && serverProgress.page <= doc.numPages) {
          setCurrentPage(serverProgress.page)
          lsSet(`progress_${id}`, { page: serverProgress.page, total: serverProgress.total, lastRead: Date.now() })
        } else {
          const saved = lsGet<{ page: number; total: number; lastRead: number } | null>(`progress_${id}`, null)
          if (saved && saved.page > 1 && saved.page <= doc.numPages) {
            setCurrentPage(saved.page)
          }
        }
      } catch {
        if (!cancelled) setError(isZh ? '无法加载 PDF' : 'Unable to load PDF')
      } finally {
        if (!cancelled) setPdfLoading(false)
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [book, isZh, id, extractToc])

  async function extractToc(doc: any, outline: any[], level: number): Promise<TocItem[]> {
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
  }

  // ─── Render current page ──────────────────────────────────────────
  const renderCurrentPage = useCallback(async () => {
    const doc = pdfDocRef.current
    const canvas = canvasRef.current
    if (!doc || !canvas) return

    // Cancel previous render
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel() } catch { /* intentionally empty */ }
    }

    setPageRendering(true)
    try {
      const page = await doc.getPage(currentPage)
      const baseViewport = page.getViewport({ scale: 1 })

      // Calculate scale to fit the canvas container
      const container = canvas.parentElement
      if (!container) return
      const maxW = container.clientWidth - 16
      const maxH = container.clientHeight - 16
      const scaleW = maxW / baseViewport.width
      const scaleH = maxH / baseViewport.height
      const scale = Math.min(scaleW, scaleH)
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

      // Save progress (localStorage + server sync UF20)
      if (id) {
        const progressData = { page: currentPage, total: totalPages, lastRead: Date.now() }
        lsSet(`progress_${id}`, progressData)
        // Async server sync - fire and forget
        syncProgressToServer(id, currentPage, totalPages)
      }
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('Render error', err)
      }
    } finally {
      setPageRendering(false)
    }
  }, [currentPage, totalPages, id])

  useEffect(() => {
    if (pdfDoc && totalPages > 0) renderCurrentPage()
  }, [pdfDoc, currentPage, totalPages, renderCurrentPage])

  // UF20: Sync progress on page close
  useEffect(() => {
    if (!id) return
    const handleUnload = () => {
      if (totalPages > 0) {
        syncProgressToServer(id, currentPage, totalPages)
      }
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [id, currentPage, totalPages])

  // Re-render on resize
  useEffect(() => {
    if (!pdfDoc) return
    let timeout: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(timeout)
      timeout = setTimeout(renderCurrentPage, 200)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); clearTimeout(timeout) }
  }, [pdfDoc, renderCurrentPage])

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

  // Click zones: left 25% = prev, right 25% = next, center = toggle toolbar
  const handlePageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore if clicking buttons/inputs
    if ((e.target as HTMLElement).closest('button, input, a')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    if (x < 0.25) goPrev()
    else if (x > 0.75) goNext()
    else setShowToolbar(p => !p)
  }, [goNext, goPrev])

  // ─── Fullscreen ────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen()
  }, [])

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev() }
      if (e.key === 'Home') { e.preventDefault(); goToPage(1) }
      if (e.key === 'End') { e.preventDefault(); goToPage(totalPages) }
      if (e.key === 'Escape') { setShowToc(false); setShowSettings(false) }
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey) toggleFullscreen()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goNext, goPrev, goToPage, totalPages, toggleFullscreen])

  // Auto-hide toolbar
  useEffect(() => {
    if (showToolbar) {
      clearTimeout(toolbarTimeoutRef.current)
      toolbarTimeoutRef.current = setTimeout(() => setShowToolbar(false), 4000)
    }
    return () => clearTimeout(toolbarTimeoutRef.current)
  }, [showToolbar, currentPage])

  // ─── Progress bar interaction ──────────────────────────────────────
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const page = Math.max(1, Math.round(ratio * totalPages))
    goToPage(page)
  }, [totalPages, goToPage])

  // ─── Render ────────────────────────────────────────────────────────

  if (loading || pdfLoading || premiumLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ width: 40, height: 40, border: '3px solid rgba(255,255,255,0.1)', borderTopColor: tokens.colors.accent.brand, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14 }}>
          {pdfLoading ? (isZh ? '正在加载文档...' : 'Loading document...') : (isZh ? '加载中...' : 'Loading...')}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  if (error || !book) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" style={{ marginBottom: 16 }}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
        <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 16, marginBottom: 16, textAlign: 'center' }}>{error}</p>
        <Link href={`/library/${id}`} style={{ padding: '10px 24px', borderRadius: 12, background: tokens.colors.accent.brand, color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
          {isZh ? '返回书籍详情' : 'Back to Book'}
        </Link>
      </div>
    )
  }

  if (needsUpgrade) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f1a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="1.5" style={{ marginBottom: 16 }}>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <h2 style={{ color: '#fff', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          {isZh ? '升级会员解锁阅读' : 'Upgrade to unlock reading'}
        </h2>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, marginBottom: 24, textAlign: 'center', maxWidth: 400 }}>
          {isZh ? '该书籍仅对会员开放，升级会员即可畅读所有付费内容。' : 'This book is available to members only.'}
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link href="/membership" style={{ padding: '10px 24px', borderRadius: 12, background: tokens.gradient.primary, color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
            {isZh ? '升级会员' : 'Upgrade'}
          </Link>
          <Link href={`/library/${id}`} style={{ padding: '10px 24px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', color: '#fff', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
            {isZh ? '返回' : 'Back'}
          </Link>
        </div>
      </div>
    )
  }

  const progressPercent = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      background: themeColors.bg, color: themeColors.text,
      transition: 'background 0.4s ease, color 0.4s ease',
      userSelect: 'none', overflow: 'hidden',
    }}>

      {/* ─── Top Toolbar ─────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
        transform: showToolbar ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '10px 12px',
          paddingTop: 'max(10px, env(safe-area-inset-top))',
          background: theme === 'dark' ? 'rgba(15,15,26,0.96)' : 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        }}>
          <ToolbarBtn onClick={() => router.push(`/library/${id}`)} title={isZh ? '返回' : 'Back'}>
            <IconBack />
          </ToolbarBtn>

          <div style={{ flex: 1, overflow: 'hidden', textAlign: 'center', padding: '0 8px' }}>
            <p style={{ fontSize: 14, fontWeight: 600, margin: 0, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {book.title}
            </p>
            {book.author && <p style={{ fontSize: 11, margin: 0, color: 'rgba(255,255,255,0.45)' }}>{book.author}</p>}
          </div>

          {toc.length > 0 && (
            <ToolbarBtn onClick={() => { setShowToc(p => !p); setShowSettings(false) }} active={showToc} title={isZh ? '目录' : 'Contents'}>
              <IconToc />
            </ToolbarBtn>
          )}
          <ToolbarBtn onClick={() => { setShowSettings(p => !p); setShowToc(false) }} active={showSettings} title={isZh ? '设置' : 'Settings'}>
            <IconSettings />
          </ToolbarBtn>
          <ToolbarBtn onClick={toggleFullscreen} title={isZh ? '全屏' : 'Fullscreen'}>
            <IconFullscreen />
          </ToolbarBtn>
        </div>
      </div>

      {/* ─── Bottom Bar ──────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 100,
        transform: showToolbar ? 'translateY(0)' : 'translateY(100%)',
        transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{
          padding: '10px 16px',
          paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
          background: theme === 'dark' ? 'rgba(15,15,26,0.96)' : 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* Progress bar */}
          <div
            onClick={handleProgressClick}
            style={{
              height: 6, borderRadius: 3, cursor: 'pointer', position: 'relative',
              background: 'rgba(255,255,255,0.12)',
            }}
          >
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${progressPercent}%`,
              background: tokens.colors.accent.brand,
              transition: 'width 0.3s ease',
            }} />
          </div>

          {/* Page controls */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              onClick={goPrev}
              disabled={currentPage <= 1}
              style={{
                background: 'none', border: 'none', color: currentPage <= 1 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.7)',
                cursor: currentPage <= 1 ? 'default' : 'pointer',
                padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 13, fontWeight: 500,
              }}
            >
              <IconChevronLeft />
              <span className="hide-mobile">{isZh ? '上一页' : 'Prev'}</span>
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
              <input
                ref={pageInputRef}
                type="number"
                value={currentPage}
                onChange={e => {
                  const val = parseInt(e.target.value)
                  if (!isNaN(val)) goToPage(val)
                }}
                style={{
                  width: 48, textAlign: 'center', background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6,
                  color: '#fff', fontSize: 13, fontWeight: 600, padding: '3px 4px',
                  outline: 'none',
                }}
                min={1}
                max={totalPages}
              />
              <span>/ {totalPages}</span>
              <span style={{ marginLeft: 8, opacity: 0.5 }}>{progressPercent}%</span>
            </div>

            <button
              onClick={goNext}
              disabled={currentPage >= totalPages}
              style={{
                background: 'none', border: 'none', color: currentPage >= totalPages ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.7)',
                cursor: currentPage >= totalPages ? 'default' : 'pointer',
                padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 13, fontWeight: 500,
              }}
            >
              <span className="hide-mobile">{isZh ? '下一页' : 'Next'}</span>
              <IconChevronRight />
            </button>
          </div>
        </div>
      </div>

      {/* ─── TOC Drawer ──────────────────────────────────── */}
      {showToc && (
        <>
          <div onClick={() => setShowToc(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200 }} />
          <div style={{
            position: 'fixed', top: 0, left: 0, bottom: 0, width: 320, maxWidth: '85vw', zIndex: 201,
            background: theme === 'dark' ? '#16162a' : '#fff',
            boxShadow: '4px 0 24px rgba(0,0,0,0.3)', overflow: 'auto',
          }}>
            <div style={{
              position: 'sticky', top: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 16px', borderBottom: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)'}`,
              background: theme === 'dark' ? '#16162a' : '#fff',
            }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme === 'dark' ? '#fff' : '#1a1a1a' }}>
                {isZh ? '目录' : 'Contents'}
              </span>
              <button onClick={() => setShowToc(false)} style={{ background: 'none', border: 'none', color: theme === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)', cursor: 'pointer', padding: 4 }}>
                <IconClose />
              </button>
            </div>
            <div style={{ padding: '8px 0' }}>
              {renderTocItems(toc)}
            </div>
          </div>
        </>
      )}

      {/* ─── Settings Panel ──────────────────────────────── */}
      {showSettings && (
        <>
          <div onClick={() => setShowSettings(false)} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
          <div style={{
            position: 'fixed', top: 56, right: 12, zIndex: 201,
            background: theme === 'dark' ? '#1e1e36' : '#fff',
            borderRadius: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
            padding: '20px 24px', width: 260,
            border: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)'}`,
          }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, opacity: 0.6 }}>
              {isZh ? '阅读主题' : 'Reading Theme'}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              {(Object.keys(THEME_PRESETS) as ReadingTheme[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                  }}
                >
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: THEME_PRESETS[t].dot,
                    border: theme === t ? `3px solid ${tokens.colors.accent.brand}` : `2px solid ${theme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'}`,
                    transition: 'border 0.2s',
                    boxShadow: theme === t ? `0 0 0 2px ${tokens.colors.accent.brand}40` : 'none',
                  }} />
                  <span style={{
                    fontSize: 11, color: theme === t ? tokens.colors.accent.brand : (theme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'),
                    fontWeight: theme === t ? 600 : 400,
                  }}>
                    {isZh ? THEME_PRESETS[t].labelZh : THEME_PRESETS[t].label}
                  </span>
                </button>
              ))}
            </div>

            <div style={{
              marginTop: 18, paddingTop: 14,
              borderTop: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
            }}>
              <p style={{ fontSize: 11, opacity: 0.4, textAlign: 'center' }}>
                {isZh ? '快捷键: 左右方向键翻页, F 全屏' : 'Keys: Arrow keys to flip, F fullscreen'}
              </p>
            </div>
          </div>
        </>
      )}

      {/* ─── Page Content ─────────────────────────────────── */}
      <div
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', overflow: 'hidden',
        }}
        onClick={handlePageClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Left zone hint */}
        {currentPage > 1 && (
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: '25%', zIndex: 10,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            paddingLeft: 8,
          }}>
            <div className="nav-hint nav-hint-left" style={{ opacity: 0, transition: 'opacity 0.2s', color: themeColors.text }}>
              <IconChevronLeft />
            </div>
          </div>
        )}

        {/* Right zone hint */}
        {currentPage < totalPages && (
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '25%', zIndex: 10,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            paddingRight: 8,
          }}>
            <div className="nav-hint nav-hint-right" style={{ opacity: 0, transition: 'opacity 0.2s', color: themeColors.text }}>
              <IconChevronRight />
            </div>
          </div>
        )}

        {/* Canvas container */}
        <div style={{
          width: '100%', height: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 8,
        }}>
          <canvas
            ref={canvasRef}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              boxShadow: theme !== 'dark' ? '0 2px 20px rgba(0,0,0,0.15)' : '0 2px 20px rgba(0,0,0,0.4)',
              borderRadius: 2,
              background: themeColors.pageBg,
              transform: flipDirection === 'left' ? 'translateX(0)' : flipDirection === 'right' ? 'translateX(0)' : 'none',
              animation: flipDirection ? `page-flip-${flipDirection} 0.3s ease` : 'none',
            }}
          />
        </div>

        {/* Page loading indicator */}
        {pageRendering && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 24, height: 24, border: '2px solid rgba(128,128,128,0.2)',
            borderTopColor: tokens.colors.accent.brand, borderRadius: '50%',
            animation: 'spin 0.6s linear infinite', zIndex: 5,
          }} />
        )}
      </div>

      {/* Bookshelf prompt */}
      {showBookshelfPrompt && !addedToShelf && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 150,
          background: theme === 'dark' ? '#2a2a4a' : '#fff',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)', borderRadius: 16,
          padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12,
          border: `1px solid ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
          animation: 'slideUp 0.3s ease',
        }}>
          <span style={{ fontSize: 13 }}>{isZh ? '加入书架?' : 'Add to shelf?'}</span>
          <button onClick={handleAddToShelf} style={{
            padding: '5px 14px', borderRadius: 8, background: tokens.colors.accent.brand,
            color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>{isZh ? '加入' : 'Add'}</button>
          <button onClick={() => setShowBookshelfPrompt(false)} style={{
            padding: '5px 10px', borderRadius: 8, background: 'transparent',
            color: themeColors.text, border: `1px solid rgba(128,128,128,0.2)`,
            cursor: 'pointer', fontSize: 12, opacity: 0.6,
          }}>{isZh ? '稍后' : 'Later'}</button>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes slideUp { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }
        @keyframes page-flip-left {
          0% { opacity: 1; transform: translateX(0); }
          30% { opacity: 0.3; transform: translateX(-30px); }
          60% { opacity: 0.3; transform: translateX(15px); }
          100% { opacity: 1; transform: translateX(0); }
        }
        @keyframes page-flip-right {
          0% { opacity: 1; transform: translateX(0); }
          30% { opacity: 0.3; transform: translateX(30px); }
          60% { opacity: 0.3; transform: translateX(-15px); }
          100% { opacity: 1; transform: translateX(0); }
        }
        * { -webkit-tap-highlight-color: transparent; }
        .nav-hint { pointer-events: none; }
        div:hover > .nav-hint-left,
        div:hover > .nav-hint-right { opacity: 0.3 !important; }
        .hide-mobile { display: inline; }
        @media (max-width: 640px) {
          .hide-mobile { display: none; }
        }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
    </div>
  )

  function renderTocItems(items: TocItem[]): React.ReactNode {
    return items.map((item, i) => (
      <div key={i}>
        <button
          onClick={() => goToPage(item.pageIndex + 1)}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            width: '100%', textAlign: 'left', padding: '10px 16px',
            paddingLeft: 16 + item.level * 20,
            background: currentPage === item.pageIndex + 1
              ? (theme === 'dark' ? 'rgba(139,111,168,0.15)' : 'rgba(139,111,168,0.08)')
              : 'none',
            border: 'none', color: theme === 'dark' ? '#fff' : '#1a1a1a',
            cursor: 'pointer', fontSize: 13, lineHeight: 1.4,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'}
          onMouseLeave={e => e.currentTarget.style.background = currentPage === item.pageIndex + 1
            ? (theme === 'dark' ? 'rgba(139,111,168,0.15)' : 'rgba(139,111,168,0.08)')
            : 'transparent'}
        >
          <span style={{ flex: 1, marginRight: 12 }}>{item.title}</span>
          <span style={{ opacity: 0.35, fontSize: 11, flexShrink: 0 }}>{item.pageIndex + 1}</span>
        </button>
        {item.children && renderTocItems(item.children)}
      </div>
    ))
  }
}

// ─── Toolbar Button ──────────────────────────────────────────────────

function ToolbarBtn({ children, onClick, active, title }: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 36, height: 36, borderRadius: 10,
        background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
        border: 'none', color: 'rgba(255,255,255,0.75)',
        cursor: 'pointer', transition: 'background 0.15s',
        flexShrink: 0,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}
