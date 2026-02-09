'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { usePremium } from '@/lib/premium/hooks'
import { tokens } from '@/lib/design-tokens'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import { supabase } from '@/lib/supabase/client'
import dynamic from 'next/dynamic'
import { getEpubControls } from '@/app/components/library/EpubReader'
import { logger } from '@/lib/logger'

const EpubReader = dynamic(() => import('@/app/components/library/EpubReader'), { ssr: false })

// ─── Types ───────────────────────────────────────────────────────────

type BookInfo = {
  id: string
  title: string
  author: string | null
  pdf_url: string | null
  source_url: string | null
  content_url: string | null
  epub_url: string | null
  file_key: string | null
  category: string
  is_free: boolean
}

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
type FontSize = 'small' | 'medium' | 'large'
type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'
type ContentMode = 'pdf' | 'html' | 'epub' | 'none'

type TocItem = {
  title: string
  pageIndex: number
  level: number
  children?: TocItem[]
}

type HtmlChapter = {
  title: string
  content: string
}

// ─── Constants ───────────────────────────────────────────────────────

const THEME_PRESETS: Record<ReadingTheme, {
  bg: string; pageBg: string; text: string; labelZh: string; label: string; dot: string;
  settingsLabel: string; settingsOption: string; settingsOptionInactive: string;
  settingsControlBg: string; settingsHint: string;
}> = {
  white:  { bg: 'var(--color-bg-tertiary)', pageBg: 'var(--color-on-accent)', text: 'var(--color-text-primary)', label: 'White',  labelZh: '白色',   dot: 'var(--color-on-accent)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-secondary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--color-overlay-subtle)', settingsHint: 'var(--color-text-tertiary)' },
  sepia:  { bg: 'var(--color-border-primary)', pageBg: 'var(--color-bg-secondary)', text: 'var(--color-bg-tertiary)', label: 'Sepia',  labelZh: '暖黄',   dot: 'var(--color-bg-secondary)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-tertiary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--glass-bg-light)', settingsHint: 'var(--color-overlay-light)' },
  dark:   { bg: 'var(--color-bg-primary)', pageBg: 'var(--color-bg-secondary)', text: 'var(--color-border-primary)', label: 'Dark',   labelZh: '暗黑',   dot: 'var(--color-bg-secondary)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-tertiary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--glass-bg-light)', settingsHint: 'var(--color-text-quaternary)' },
  green:  { bg: 'var(--color-accent-success-20)', pageBg: 'var(--color-accent-success-20)', text: 'var(--color-accent-success)', label: 'Green',  labelZh: '护眼绿', dot: 'var(--color-accent-success-20)',
    settingsLabel: 'var(--color-text-secondary)', settingsOption: 'var(--color-text-tertiary)', settingsOptionInactive: 'var(--color-text-primary)',
    settingsControlBg: 'var(--glass-bg-light)', settingsHint: 'var(--color-text-quaternary)' },
}

const FONT_SIZES: Record<FontSize, { body: number; heading: number; labelZh: string; label: string }> = {
  small:  { body: 15, heading: 22, labelZh: '小', label: 'S' },
  medium: { body: 18, heading: 26, labelZh: '中', label: 'M' },
  large:  { body: 22, heading: 32, labelZh: '大', label: 'L' },
}

const FONT_FAMILIES: Record<FontFamily, { css: string; labelZh: string; label: string }> = {
  sans:  { css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif', labelZh: '黑体', label: 'Sans' },
  serif: { css: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif', labelZh: '宋体', label: 'Serif' },
  mono:  { css: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace', labelZh: '等宽', label: 'Mono' },
  kai:   { css: '"STKaiti", "KaiTi", "楷体", serif', labelZh: '楷体', label: 'Kai' },
}

const LS_PREFIX = 'reader_'
const CHARS_PER_PAGE_BASE = 1200 // approximate chars per page at medium font

// ─── Helpers ─────────────────────────────────────────────────────────

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

async function syncProgressToServer(bookId: string, page: number, totalPages: number) {
  try {
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

function detectContentMode(book: BookInfo): ContentMode {
  if (book.epub_url) return 'epub'
  if (book.pdf_url) return 'pdf'
  // file_key without pdf_url: construct CDN URL for PDF
  if (book.file_key) return 'pdf'
  return 'none'
}

function parseHtmlIntoChapters(html: string): HtmlChapter[] {
  // Try to split by h1/h2/h3 headings
  const parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null
  if (!parser) return [{ title: '', content: html }]
  
  const doc = parser.parseFromString(html, 'text/html')
  const body = doc.body
  const chapters: HtmlChapter[] = []
  let currentTitle = ''
  let currentContent = ''

  for (const node of Array.from(body.childNodes)) {
    const el = node as HTMLElement
    if (el.tagName && /^H[1-3]$/.test(el.tagName)) {
      if (currentContent.trim()) {
        chapters.push({ title: currentTitle || `${chapters.length + 1}`, content: currentContent })
      }
      currentTitle = el.textContent || ''
      currentContent = ''
    } else {
      currentContent += el.outerHTML || el.textContent || ''
    }
  }
  if (currentContent.trim() || chapters.length === 0) {
    chapters.push({ title: currentTitle || (chapters.length === 0 ? '' : `${chapters.length + 1}`), content: currentContent || html })
  }
  return chapters
}

function paginateText(text: string, fontSize: FontSize): string[] {
  const charsPerPage = fontSize === 'small' ? 1600 : fontSize === 'large' ? 800 : CHARS_PER_PAGE_BASE
  const pages: string[] = []
  
  // Split by paragraphs to avoid breaking mid-paragraph
  const paragraphs = text.split(/\n\n+|\<\/p\>|\<br\s*\/?\>\s*\<br\s*\/?\>/gi)
  let currentPage = ''
  
  for (const para of paragraphs) {
    const cleaned = para.replace(/<[^>]*>/g, '').trim()
    if (!cleaned) continue
    
    if (currentPage.length + cleaned.length > charsPerPage && currentPage.length > 0) {
      pages.push(currentPage)
      currentPage = ''
    }
    
    if (cleaned.length > charsPerPage) {
      // Split long paragraphs by sentences
      const sentences = cleaned.match(/[^.!?。！？]+[.!?。！？]?\s*/g) || [cleaned]
      for (const s of sentences) {
        if (currentPage.length + s.length > charsPerPage && currentPage.length > 0) {
          pages.push(currentPage)
          currentPage = ''
        }
        currentPage += s
      }
    } else {
      currentPage += (currentPage ? '\n\n' : '') + cleaned
    }
  }
  if (currentPage.trim()) pages.push(currentPage)
  return pages.length > 0 ? pages : ['']
}

// ─── SVG Icons ───────────────────────────────────────────────────────

const ICON_SIZE = 18
function IconBack() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
}
function IconToc() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
}
function IconSettings() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
}
function IconFullscreen() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
}
function IconClose() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
}
function IconChevronLeft() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
}
function IconChevronRight() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
}
function IconBookmark({ filled }: { filled?: boolean }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  )
}
function IconSearch() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
}
function IconNotes() {
  return <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
}
function _IconFont() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  )
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
  const [contentMode, setContentMode] = useState<ContentMode>('none')

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [totalPages, setTotalPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pageRendering, setPageRendering] = useState(false)
  const [toc, setToc] = useState<TocItem[]>([])

  // HTML/text state
  const [htmlContent, setHtmlContent] = useState<string>('')
  const [_htmlChapters, setHtmlChapters] = useState<HtmlChapter[]>([])
  const [htmlPages, setHtmlPages] = useState<string[]>([])
  const [htmlLoading, setHtmlLoading] = useState(false)

  // ePub state
  const [epubToc, setEpubToc] = useState<any[]>([])
  const [epubGoToHref, setEpubGoToHref] = useState<string | null>(null)
  const [epubReady, setEpubReady] = useState(false)
  const epubContainerRef = useRef<HTMLDivElement>(null)

  // Reading preferences (persisted)
  const [theme, setTheme] = useState<ReadingTheme>(() => lsGet('theme', 'dark'))
  const [fontSize, setFontSize] = useState<FontSize>(() => lsGet('fontSize', 'medium'))
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => lsGet('fontFamily', 'sans'))

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
  const pdfDocRef = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)
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
    supabase.auth.getUser().then(({ data }) => setIsLoggedIn(!!data.user))

    fetch(`/api/library/${id}`)
      .then(r => r.json())
      .then(data => {
        if (!data.item) { setError(isZh ? '未找到该书籍' : 'Book not found'); return }
        const item = data.item as BookInfo
        const mode = detectContentMode(item)
        if (mode === 'none') {
          setError(isZh ? '该书籍暂无阅读资源' : 'No reading resource available')
          return
        }
        setBook(item)
        setContentMode(mode)
      })
      .catch(() => setError(isZh ? '加载失败' : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [id, isZh])

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
  const extractToc = useCallback(async (doc: any, outline: any[], level: number): Promise<TocItem[]> => {
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
    const url = book.pdf_url || (book.file_key ? `https://cdn.arenafi.org/${book.file_key}` : null)
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

        try {
          const outline = await doc.getOutline()
          if (outline?.length > 0) {
            const tocItems = await extractToc(doc, outline, 0)
            setToc(tocItems)
          }
        } catch { /* intentionally empty */ }

        // Restore progress
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
        if (!cancelled) setError(isZh ? '无法加载 PDF' : 'Unable to load PDF')
      } finally {
        if (!cancelled) setPdfLoading(false)
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [book, contentMode, isZh, id, extractToc])

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
          // Plain text - wrap in paragraphs
          const raw = await res.text()
          text = raw.split(/\n\n+/).map(p => `<p>${p.trim()}</p>`).join('\n')
        }

        if (cancelled) return
        setHtmlContent(text)

        // Parse chapters
        const chapters = parseHtmlIntoChapters(text)
        setHtmlChapters(chapters)

        // Build TOC from chapters
        if (chapters.length > 1) {
          const tocItems: TocItem[] = chapters.map((ch, i) => ({
            title: ch.title || `${isZh ? '第' : 'Chapter '}${i + 1}${isZh ? '章' : ''}`,
            pageIndex: i, // will be mapped to page numbers after pagination
            level: 0,
          }))
          setToc(tocItems)
        }

        // Paginate
        const allText = chapters.map(c => c.content).join('\n\n')
        const pages = paginateText(allText, fontSize)
        setHtmlPages(pages)
        setTotalPages(pages.length)

        // Restore progress
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
        if (!cancelled) setError(isZh ? '无法加载内容' : 'Unable to load content')
      } finally {
        if (!cancelled) setHtmlLoading(false)
      }
    }

    loadHtml()
    return () => { cancelled = true }
  }, [book, contentMode, isZh, id, fontSize])

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

  // Render PDF page when ready, using ResizeObserver for reliable initial sizing
  useEffect(() => {
    if (contentMode !== 'pdf' || !pdfDoc || totalPages <= 0) return
    const canvas = canvasRef.current
    const container = canvas?.parentElement
    if (!container) return

    // If container has valid size, render immediately
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      renderCurrentPage()
    }

    // Also observe for layout changes (handles first mount when container isn't sized yet)
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

  // Auto-focus reader container for immediate keyboard navigation
  useEffect(() => {
    if (!loading && !pdfLoading && !htmlLoading && book && !needsUpgrade && !error) {
      // Small delay to ensure DOM is ready
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

  // ─── Render states ─────────────────────────────────────────────────

  const isLoading = loading || pdfLoading || htmlLoading || premiumLoading || (contentMode === 'epub' && !epubReady && book !== null && !error)

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <div style={{ width: 40, height: 40, border: '3px solid var(--glass-border-light)', borderTopColor: 'var(--color-accent-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14 }}>
          {pdfLoading || htmlLoading ? (isZh ? '正在加载文档...' : 'Loading document...') : (isZh ? '加载中...' : 'Loading...')}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  if (error || !book) {
    const isNoContent = error === (isZh ? '该书籍暂无阅读资源' : 'No reading resource available')
    return (
      <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{
          width: 80, height: 80, borderRadius: '50%',
          background: 'var(--color-bg-secondary, var(--overlay-hover))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
        }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
        </div>
        <h2 style={{ color: 'var(--color-text-primary)', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
          {isNoContent
            ? (isZh ? '暂无内容' : 'No Content Available')
            : (isZh ? '加载失败' : 'Failed to Load')}
        </h2>
        <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, marginBottom: 24, textAlign: 'center', maxWidth: 400, lineHeight: 1.6 }}>
          {isNoContent
            ? (isZh ? '该书籍暂无电子版阅读资源，请稍后再来查看。' : 'No digital reading resource is available for this book yet. Please check back later.')
            : (error || (isZh ? '未找到该书籍' : 'Book not found'))}
        </p>
        <Link href={`/library/${id}`} style={{ padding: '10px 24px', borderRadius: tokens.radius.lg, background: 'var(--color-accent-primary)', color: 'var(--foreground)', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
          {isZh ? '返回书籍详情' : 'Back to Book'}
        </Link>
      </div>
    )
  }

  if (needsUpgrade) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="1.5" style={{ marginBottom: 16 }}>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <h2 style={{ color: 'var(--color-text-primary)', fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          {isZh ? '升级会员解锁阅读' : 'Upgrade to unlock reading'}
        </h2>
        <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, marginBottom: 24, textAlign: 'center', maxWidth: 400 }}>
          {isZh ? '该书籍仅对会员开放，升级会员即可畅读所有付费内容。' : 'This book is available to members only.'}
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link href="/membership" style={{ padding: '10px 24px', borderRadius: tokens.radius.lg, background: tokens.gradient.primary, color: 'var(--foreground)', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
            {isZh ? '升级会员' : 'Upgrade'}
          </Link>
          <Link href={`/library/${id}`} style={{ padding: '10px 24px', borderRadius: tokens.radius.lg, border: '1px solid var(--color-border-primary)', color: 'var(--color-text-primary)', textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
            {isZh ? '返回' : 'Back'}
          </Link>
        </div>
      </div>
    )
  }

  const progressPercent = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0
  const currentHtmlPage = contentMode === 'html' ? (htmlPages[currentPage - 1] || '') : ''

  return (
    <div
      ref={readerContainerRef}
      tabIndex={-1}
      style={{
        position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
        background: themeColors.bg, color: themeColors.text,
        transition: 'background 0.4s ease, color 0.4s ease',
        userSelect: contentMode === 'html' ? 'text' : 'none', overflow: 'hidden',
        outline: 'none',
      }}>

      {/* ─── Breadcrumb (visible when toolbar shown) ──────── */}
      <div style={{
        position: 'absolute', top: 3, left: 0, right: 0, zIndex: 99,
        transform: showToolbar ? 'translateY(52px)' : 'translateY(-100%)',
        transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: showToolbar ? 'auto' : 'none',
      }}>
        <div style={{
          padding: '2px 16px',
          background: theme === 'dark' ? 'var(--color-blur-overlay)' : 'var(--color-backdrop-heavy)',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        }}>
          <Breadcrumb items={[
            { label: isZh ? '书库' : 'Library', href: '/library' },
            { label: book.title, href: `/library/${id}` },
            { label: isZh ? '阅读' : 'Reading' },
          ]} />
        </div>
      </div>

      {/* ─── Progress Bar (top, always visible) ──────────── */}
      <div
        onClick={handleProgressClick}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: showToolbar ? 4 : 3, zIndex: 150,
          background: 'var(--color-overlay-subtle)',
          cursor: 'pointer', transition: 'height 0.2s ease',
        }}
      >
        <div style={{
          height: '100%', width: `${progressPercent}%`,
          background: 'var(--color-accent-primary)',
          transition: 'width 0.3s ease',
          borderRadius: '0 2px 2px 0',
        }} />
      </div>

      {/* ─── Page info (shown when toolbar hidden) ────────── */}
      {!showToolbar && totalPages > 0 && (
        <div style={{
          position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
          zIndex: 90, fontSize: 11, color: 'var(--color-text-quaternary)',
          pointerEvents: 'none', opacity: 0.6,
        }}>
          {currentPage} / {totalPages}
        </div>
      )}

      {/* ─── Top Toolbar ─────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 3, left: 0, right: 0, zIndex: 100,
        transform: showToolbar ? 'translateY(0)' : 'translateY(-100%)',
        transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '10px 12px',
          paddingTop: 'max(10px, env(safe-area-inset-top))',
          background: theme === 'dark' ? 'var(--color-backdrop-heavy)' : 'var(--color-backdrop-heavy)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        }}>
          <ToolbarBtn onClick={() => router.push(`/library/${id}`)} title={isZh ? '返回' : 'Back'}>
            <IconBack />
          </ToolbarBtn>

          <div style={{ flex: 1, overflow: 'hidden', textAlign: 'center', padding: '0 8px' }}>
            <p style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {book.title}
            </p>
            {book.author && <p style={{ fontSize: 11, margin: 0, color: 'var(--color-text-tertiary)' }}>{book.author}</p>}
          </div>

          {(toc.length > 0 || epubToc.length > 0) && (
            <ToolbarBtn onClick={() => { setShowToc(p => !p); setShowSettings(false) }} active={showToc} title={isZh ? '目录' : 'Contents'}>
              <IconToc />
            </ToolbarBtn>
          )}
          {contentMode !== 'epub' && (
            <ToolbarBtn onClick={toggleBookmark} active={isCurrentPageBookmarked} title={isZh ? '书签' : 'Bookmark'}>
              <IconBookmark filled={isCurrentPageBookmarked} />
            </ToolbarBtn>
          )}
          {contentMode === 'epub' && (
            <>
              <ToolbarBtn onClick={() => {
                const ctrl = getEpubControls(epubContainerRef.current)
                ctrl?.toggleSearch()
              }} title={isZh ? '搜索' : 'Search'}>
                <IconSearch />
              </ToolbarBtn>
              <ToolbarBtn onClick={() => {
                const ctrl = getEpubControls(epubContainerRef.current)
                ctrl?.toggleNotes()
              }} title={isZh ? '笔记' : 'Notes'}>
                <IconNotes />
              </ToolbarBtn>
              <ToolbarBtn onClick={() => {
                const ctrl = getEpubControls(epubContainerRef.current)
                ctrl?.toggleStats()
              }} title={isZh ? '统计' : 'Stats'}>
                <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="8" width="4" height="13"/><rect x="17" y="3" width="4" height="18"/></svg>
              </ToolbarBtn>
              <ToolbarBtn onClick={() => {
                const ctrl = getEpubControls(epubContainerRef.current)
                ctrl?.toggleTypography()
              }} title={isZh ? '排版' : 'Typography'}>
                <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
              </ToolbarBtn>
            </>
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
          background: theme === 'dark' ? 'var(--color-backdrop-heavy)' : 'var(--color-backdrop-heavy)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* Clickable progress bar */}
          <div onClick={handleProgressClick} style={{
            height: 6, borderRadius: 3, cursor: 'pointer', position: 'relative',
            background: 'var(--glass-bg-medium)',
          }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${progressPercent}%`,
              background: 'var(--color-accent-primary)',
              transition: 'width 0.3s ease',
            }} />
          </div>

          {/* Page controls */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button onClick={goPrev} disabled={currentPage <= 1} style={{
              background: 'none', border: 'none',
              color: currentPage <= 1 ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
              cursor: currentPage <= 1 ? 'default' : 'pointer',
              padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 13, fontWeight: 500,
            }}>
              <IconChevronLeft />
              <span className="reader-hide-mobile">{isZh ? '上一页' : 'Prev'}</span>
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
              <input
                type="number"
                value={currentPage}
                onChange={e => { const val = parseInt(e.target.value); if (!isNaN(val)) goToPage(val) }}
                style={{
                  width: 48, textAlign: 'center', background: 'var(--glass-bg-light)',
                  border: '1px solid var(--glass-border-medium)', borderRadius: tokens.radius.sm,
                  color: 'var(--foreground)', fontSize: 13, fontWeight: 600, padding: '3px 4px', outline: 'none',
                }}
                min={1} max={totalPages}
              />
              <span>/ {totalPages}</span>
              <span style={{ marginLeft: 8, opacity: 0.5 }}>{progressPercent}%</span>
            </div>

            <button onClick={goNext} disabled={currentPage >= totalPages} style={{
              background: 'none', border: 'none',
              color: currentPage >= totalPages ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
              cursor: currentPage >= totalPages ? 'default' : 'pointer',
              padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 13, fontWeight: 500,
            }}>
              <span className="reader-hide-mobile">{isZh ? '下一页' : 'Next'}</span>
              <IconChevronRight />
            </button>
          </div>
        </div>
      </div>

      {/* ─── TOC Drawer ──────────────────────────────────── */}
      {showToc && (
        <>
          <div onClick={() => setShowToc(false)} style={{ position: 'fixed', inset: 0, background: 'var(--color-overlay-dark)', zIndex: 200 }} />
          <div style={{
            position: 'fixed', top: 0, left: 0, bottom: 0, width: 320, maxWidth: '85vw', zIndex: 201,
            background: themeColors.pageBg,
            boxShadow: '4px 0 24px var(--color-overlay-medium)', overflow: 'auto',
          }}>
            <div style={{
              position: 'sticky', top: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 16px', borderBottom: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`,
              background: themeColors.pageBg,
            }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme === 'dark' ? 'var(--color-on-accent)' : 'var(--color-text-primary)' }}>
                {isZh ? '目录' : 'Contents'}
              </span>
              <button onClick={() => setShowToc(false)} style={{ background: 'none', border: 'none', color: theme === 'dark' ? 'var(--glass-border-heavy)' : 'var(--color-backdrop-light)', cursor: 'pointer', padding: 4 }}>
                <IconClose />
              </button>
            </div>

            {/* Bookmarks section */}
            {bookmarks.length > 0 && (
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}` }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: theme === 'dark' ? 'var(--glass-bg-medium)' : 'var(--color-backdrop-light)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  {isZh ? '书签' : 'Bookmarks'}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {bookmarks.map(page => (
                    <button key={page} onClick={() => goToPage(page)} style={{
                      padding: '4px 10px', borderRadius: tokens.radius.sm, fontSize: 12, fontWeight: 500,
                      background: currentPage === page ? 'var(--color-accent-primary)' : (theme === 'dark' ? 'var(--glass-bg-light)' : 'var(--color-overlay-subtle)'),
                      color: currentPage === page ? 'var(--color-on-accent)' : (theme === 'dark' ? 'var(--color-text-secondary)' : 'var(--color-backdrop)'),
                      border: 'none', cursor: 'pointer',
                    }}>
                      {isZh ? '第' : 'p.'}{page}{isZh ? '页' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ padding: '8px 0' }}>
              {contentMode === 'epub' ? renderEpubTocItems(epubToc) : renderTocItems(toc)}
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
            background: themeColors.pageBg,
            borderRadius: tokens.radius.xl, boxShadow: '0 8px 32px var(--color-overlay-medium)',
            padding: '20px 24px', width: 280,
            border: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`,
          }}>
            {/* Theme */}
            <p style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, marginBottom: 12, color: themeColors.settingsLabel }}>
              {isZh ? '阅读主题' : 'Reading Theme'}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 18 }}>
              {(Object.keys(THEME_PRESETS) as ReadingTheme[]).map(t => (
                <button key={t} onClick={() => setTheme(t)} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    background: THEME_PRESETS[t].dot,
                    border: theme === t ? '3px solid var(--color-accent-primary)' : `2px solid ${theme === 'dark' ? 'var(--glass-border-medium)' : 'var(--color-overlay-light)'}`,
                    transition: 'border 0.2s',
                  }} />
                  <span style={{
                    fontSize: 11,
                    color: theme === t ? 'var(--color-accent-primary)' : themeColors.settingsOption,
                    fontWeight: theme === t ? 600 : 400,
                  }}>
                    {isZh ? THEME_PRESETS[t].labelZh : THEME_PRESETS[t].label}
                  </span>
                </button>
              ))}
            </div>

            {/* Font Size */}
            <div style={{ borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`, paddingTop: 14, marginBottom: 14 }}>
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: themeColors.settingsLabel }}>
                {isZh ? '字号' : 'Font Size'}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {(Object.keys(FONT_SIZES) as FontSize[]).map(s => (
                  <button key={s} onClick={() => setFontSize(s)} style={{
                    flex: 1, padding: '8px 4px', borderRadius: 10,
                    background: fontSize === s ? 'var(--color-accent-primary)' : themeColors.settingsControlBg,
                    color: fontSize === s ? 'var(--color-on-accent)' : themeColors.settingsOptionInactive,
                    border: 'none', cursor: 'pointer', fontSize: s === 'small' ? 13 : s === 'large' ? 18 : 15,
                    fontWeight: 600, transition: 'all 0.15s',
                  }}>
                    {isZh ? FONT_SIZES[s].labelZh : FONT_SIZES[s].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Font Family (HTML/ePub mode) */}
            {(contentMode === 'html' || contentMode === 'epub') && (
              <div style={{ borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`, paddingTop: 14, marginBottom: 14 }}>
                <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: themeColors.settingsLabel }}>
                  {isZh ? '字体' : 'Font'}
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  {(Object.keys(FONT_FAMILIES) as FontFamily[]).map(f => (
                    <button key={f} onClick={() => setFontFamily(f)} style={{
                      flex: 1, padding: '8px 4px', borderRadius: 10,
                      background: fontFamily === f ? 'var(--color-accent-primary)' : themeColors.settingsControlBg,
                      color: fontFamily === f ? 'var(--color-on-accent)' : themeColors.settingsOptionInactive,
                      border: 'none', cursor: 'pointer', fontSize: 14,
                      fontFamily: FONT_FAMILIES[f].css,
                      fontWeight: 600, transition: 'all 0.15s',
                    }}>
                      {isZh ? FONT_FAMILIES[f].labelZh : FONT_FAMILIES[f].label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{
              paddingTop: 14,
              borderTop: `1px solid ${theme === 'dark' ? 'var(--glass-border-light)' : 'var(--color-overlay-subtle)'}`,
            }}>
              <p style={{ fontSize: 11, color: themeColors.settingsHint, textAlign: 'center', lineHeight: 1.6 }}>
                {isZh
                  ? '快捷键: 左右方向键/空格翻页, B 书签, F 全屏'
                  : 'Keys: Arrows/Space flip, B bookmark, F fullscreen'}
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
        {/* Navigation zone hints */}
        {currentPage > 1 && (
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: '25%', zIndex: 10,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-start', paddingLeft: 8,
          }}>
            <div className="reader-nav-hint" style={{ opacity: 0, transition: 'opacity 0.2s', color: themeColors.text }}>
              <IconChevronLeft />
            </div>
          </div>
        )}
        {currentPage < totalPages && (
          <div style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: '25%', zIndex: 10,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8,
          }}>
            <div className="reader-nav-hint" style={{ opacity: 0, transition: 'opacity 0.2s', color: themeColors.text }}>
              <IconChevronRight />
            </div>
          </div>
        )}

        {/* PDF Canvas */}
        {contentMode === 'pdf' && (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
            <canvas
              ref={canvasRef}
              style={{
                maxWidth: '100%', maxHeight: '100%',
                boxShadow: theme !== 'dark' ? '0 2px 20px var(--color-overlay-light)' : '0 2px 20px var(--color-backdrop-light)',
                borderRadius: 2, background: themeColors.pageBg,
                animation: flipDirection ? `page-flip-${flipDirection} 0.3s ease` : 'none',
              }}
            />
          </div>
        )}

        {/* HTML/Text Content */}
        {contentMode === 'html' && (
          <div
            ref={contentAreaRef}
            style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
              overflow: 'auto', padding: '60px 20px 80px',
            }}
          >
            <div style={{
              maxWidth: 680, width: '100%',
              background: themeColors.pageBg,
              color: themeColors.text,
              borderRadius: tokens.radius.sm,
              padding: '40px 36px',
              minHeight: 'calc(100vh - 160px)',
              boxShadow: theme !== 'dark' ? '0 2px 20px var(--color-overlay-subtle)' : '0 2px 20px var(--color-overlay-medium)',
              fontFamily: fontFamilyConfig.css,
              fontSize: fontSizeConfig.body,
              lineHeight: 1.85,
              letterSpacing: '0.01em',
              wordBreak: 'break-word',
              animation: flipDirection ? `page-flip-${flipDirection} 0.3s ease` : 'none',
              transition: 'font-size 0.2s ease, font-family 0.2s ease',
            }}>
              {/* Render plain text with proper paragraphs */}
              {currentHtmlPage.split('\n\n').map((para, i) => (
                <p key={i} style={{
                  margin: 0,
                  marginBottom: fontSizeConfig.body * 1.2,
                  textIndent: isZh ? '2em' : undefined,
                }}>
                  {para}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* ePub Content */}
        {contentMode === 'epub' && book?.epub_url && (
          <div ref={epubContainerRef} style={{ width: '100%', height: '100%', background: themeColors.pageBg }}>
            <EpubReader
              url={book.epub_url}
              bookId={id}
              isZh={isZh}
              theme={theme}
              fontSize={fontSize}
              fontFamily={fontFamily}
              onTocLoaded={(tocItems) => setEpubToc(tocItems)}
              onProgressChange={(percent, page, total) => {
                setCurrentPage(page)
                setTotalPages(total)
              }}
              onReady={() => setEpubReady(true)}
              goToHref={epubGoToHref}
            />
          </div>
        )}

        {/* Page loading indicator */}
        {pageRendering && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 24, height: 24, border: '2px solid var(--color-overlay-medium)',
            borderTopColor: 'var(--color-accent-primary)', borderRadius: '50%',
            animation: 'spin 0.6s linear infinite', zIndex: 5,
          }} />
        )}
      </div>

      {/* Bookshelf prompt */}
      {showBookshelfPrompt && !addedToShelf && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 150,
          background: theme === 'dark' ? 'var(--color-bg-tertiary)' : 'var(--color-on-accent)',
          boxShadow: '0 8px 32px var(--color-overlay-medium)', borderRadius: tokens.radius.xl,
          padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12,
          border: `1px solid ${theme === 'dark' ? 'var(--glass-bg-light)' : 'var(--color-overlay-subtle)'}`,
          animation: 'slideUp 0.3s ease',
        }}>
          <span style={{ fontSize: 13 }}>{isZh ? '加入书架?' : 'Add to shelf?'}</span>
          <button onClick={handleAddToShelf} style={{
            padding: '5px 14px', borderRadius: tokens.radius.md, background: 'var(--color-accent-primary)',
            color: 'var(--foreground)', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>{isZh ? '加入' : 'Add'}</button>
          <button onClick={() => setShowBookshelfPrompt(false)} style={{
            padding: '5px 10px', borderRadius: tokens.radius.md, background: 'transparent',
            color: themeColors.text, border: '1px solid var(--color-overlay-medium)',
            cursor: 'pointer', fontSize: 12, opacity: 0.6,
          }}>{isZh ? '稍后' : 'Later'}</button>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes slideUp { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }
        @keyframes page-flip-left {
          0% { opacity: 1; transform: translateX(0) scale(1); }
          40% { opacity: 0.4; transform: translateX(-20px) scale(0.98); }
          100% { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes page-flip-right {
          0% { opacity: 1; transform: translateX(0) scale(1); }
          40% { opacity: 0.4; transform: translateX(20px) scale(0.98); }
          100% { opacity: 1; transform: translateX(0) scale(1); }
        }
        * { -webkit-tap-highlight-color: transparent; }
        .reader-nav-hint { pointer-events: none; }
        div:hover > .reader-nav-hint { opacity: 0.3 !important; }
        .reader-hide-mobile { display: inline; }
        @media (max-width: 640px) {
          .reader-hide-mobile { display: none; }
        }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
    </div>
  )

  function renderEpubTocItems(items: any[], level = 0): React.ReactNode {
    return items.map((item: any, i: number) => (
      <div key={i}>
        <button
          onClick={() => { setEpubGoToHref(item.href); setShowToc(false); setTimeout(() => setEpubGoToHref(null), 100) }}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '10px 16px', paddingLeft: 16 + level * 20,
            background: 'none', border: 'none',
            color: themeColors.text,
            cursor: 'pointer', fontSize: 14, fontWeight: 500, lineHeight: 1.5,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = theme === 'dark' ? 'var(--overlay-hover)' : 'var(--overlay-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          {item.label}
        </button>
        {item.subitems && item.subitems.length > 0 && renderEpubTocItems(item.subitems, level + 1)}
      </div>
    ))
  }

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
              ? (theme === 'dark' ? 'var(--color-accent-primary-15)' : 'var(--color-accent-primary-08)')
              : 'none',
            border: 'none', color: themeColors.text,
            cursor: 'pointer', fontSize: 14, fontWeight: 500, lineHeight: 1.5, transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--glass-bg-light)'}
          onMouseLeave={e => e.currentTarget.style.background = currentPage === item.pageIndex + 1
            ? 'var(--color-accent-primary-15)' : 'transparent'}
        >
          <span style={{ flex: 1, marginRight: 12 }}>{item.title}</span>
          <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>{item.pageIndex + 1}</span>
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
        background: active ? 'var(--glass-bg-light)' : 'transparent',
        border: 'none', color: 'var(--color-text-primary)',
        cursor: 'pointer', transition: 'background 0.15s', flexShrink: 0,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--glass-bg-light)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}
