'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Rendition, Book, NavItem, Contents } from 'epubjs'
import AudioReader from './AudioReader'
import { supabase } from '@/lib/supabase/client'
import { EpubToolbar } from './EpubToolbar'
import { EpubSettings } from './EpubSettings'
import { EpubSearchPanel, EpubNotesPanel, EpubStatsPanel, type EpubHighlight } from './EpubNavigation'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { t as moduleT } from '@/lib/i18n'

// ─── Types ───────────────────────────────────────────────────────────

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
type FontSize = 'small' | 'medium' | 'large'
type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'
type LineHeight = 'compact' | 'normal' | 'relaxed'
type PageMargin = 'narrow' | 'normal' | 'wide'

interface EpubSpineItem {
  load: (loader: (path: string) => Promise<object>) => Promise<Document>
  cfiFromRange: (range: Range) => string
  href: string
  unload: () => void
}

interface EpubSpine {
  items?: EpubSpineItem[]
  spineItems?: EpubSpineItem[]
}

interface EpubContentsEntry {
  document?: Document
  content?: { ownerDocument?: Document }
}

interface EpubControlsElement extends HTMLElement {
  __epubControls?: Record<string, () => void>
}

type SearchResult = {
  cfi: string
  excerpt: string
}

type ReadingStats = {
  sessionStartTime: number
  totalReadingTimeSec: number
  pagesRead: number
  sessionsCount: number
  avgSpeedCharsPerMin: number
}

type HighlightSortMode = 'time' | 'position'
type HighlightFilterColor = string | 'all'

export type EpubReaderProps = {
  url: string
  bookId: string
  theme: ReadingTheme
  fontSize: FontSize
  fontFamily: FontFamily
  onTocLoaded?: (toc: NavItem[]) => void
  onProgressChange?: (percent: number, currentPage: number, totalPages: number) => void
  onReady?: () => void
  goToHref?: string | null
  className?: string
  lineHeight?: LineHeight
  pageMargin?: PageMargin
  onLineHeightChange?: (lh: LineHeight) => void
  onPageMarginChange?: (pm: PageMargin) => void
}

// ─── Constants ───────────────────────────────────────────────────────

const THEME_STYLES: Record<ReadingTheme, { body: Record<string, string> }> = {
  white: { body: { background: 'var(--color-on-accent)', color: 'var(--color-text-primary)' } },
  sepia: { body: { background: 'var(--color-bg-secondary)', color: 'var(--color-bg-tertiary)' } },
  dark:  { body: { background: 'var(--color-bg-secondary)', color: 'var(--color-border-primary)' } },
  green: { body: { background: 'var(--color-accent-success-20)', color: 'var(--color-accent-success)' } },
}

const FONT_SIZE_MAP: Record<FontSize, number> = { small: 90, medium: 100, large: 120 }

const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif',
  serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  mono: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
  kai: '"STKaiti", "KaiTi", "楷体", serif',
}

const LINE_HEIGHT_MAP: Record<LineHeight, string> = {
  compact: '1.5',
  normal: '1.8',
  relaxed: '2.2',
}

const PAGE_MARGIN_MAP: Record<PageMargin, string> = {
  narrow: '20px',
  normal: '48px',
  wide: '80px',
}

const HIGHLIGHT_COLORS = ['var(--color-chart-yellow)', 'var(--color-chart-blue)', 'var(--color-accent-success-20)', 'var(--color-accent-error)', 'var(--color-chart-pink)']

const LS_PREFIX = 'reader_'

function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const v = localStorage.getItem(LS_PREFIX + key)
    return v ? JSON.parse(v) : fallback
  } catch { return fallback }
}

function lsSet(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)) } catch { /* empty */ }
}

// ─── Supabase sync helpers ───────────────────────────────────────────

async function syncEpubPositionToServer(bookId: string, cfi: string, percent: number, page: number, totalPages: number) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    await supabase.from('reading_progress').upsert({
      user_id: session.user.id,
      book_id: bookId,
      current_page: page,
      total_pages: totalPages,
      epub_cfi: cfi,
      progress_percent: percent,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,book_id' })
  } catch { /* empty */ }
}

async function loadEpubPositionFromServer(bookId: string): Promise<{ cfi: string; percent: number } | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return null
    const { data } = await supabase
      .from('reading_progress')
      .select('epub_cfi, progress_percent')
      .eq('user_id', session.user.id)
      .eq('book_id', bookId)
      .maybeSingle()
    if (data?.epub_cfi) return { cfi: data.epub_cfi, percent: data.progress_percent || 0 }
  } catch { /* empty */ }
  return null
}

async function syncReadingStatsToServer(bookId: string, stats: ReadingStats) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    await supabase.from('reading_statistics').upsert({
      user_id: session.user.id,
      book_id: bookId,
      total_reading_time_sec: stats.totalReadingTimeSec,
      pages_read: stats.pagesRead,
      sessions_count: stats.sessionsCount,
      avg_speed_chars_per_min: stats.avgSpeedCharsPerMin,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,book_id' })
  } catch { /* empty */ }
}

function formatDuration(seconds: number): string {
  const sec = moduleT('durationSec')
  const min = moduleT('durationMin')
  const hour = moduleT('durationHour')
  const minSuffix = moduleT('durationMinSuffix')
  if (seconds < 60) return `${seconds}${sec}`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}${min}`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}${hour}${rm > 0 ? ` ${rm}${minSuffix}` : ''}`
}

function estimateTimeRemaining(percent: number, elapsedSec: number): string {
  if (percent <= 0 || elapsedSec < 30) return moduleT('epubCalculating')
  const totalEstimate = elapsedSec / (percent / 100)
  const remaining = Math.max(0, totalEstimate - elapsedSec)
  return formatDuration(Math.round(remaining))
}

// ─── Component ───────────────────────────────────────────────────────

export default function EpubReader({
  url,
  bookId,
  theme,
  fontSize,
  fontFamily,
  onTocLoaded,
  onProgressChange,
  onReady,
  goToHref,
  className,
  lineHeight = 'normal',
  pageMargin = 'normal',
}: EpubReaderProps) {
  const { t } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [ready, setReady] = useState(false)

  // Progress
  const [progressPercent, setProgressPercent] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  // Reading stats
  const [readingStats, setReadingStats] = useState<ReadingStats>(() => {
    const saved = lsGet<ReadingStats | null>(`epub_stats_${bookId}`, null)
    return saved || {
      sessionStartTime: Date.now(),
      totalReadingTimeSec: 0,
      pagesRead: 0,
      sessionsCount: 0,
      avgSpeedCharsPerMin: 0,
    }
  })
  const [sessionElapsedSec, setSessionElapsedSec] = useState(0)
  const sessionStartRef = useRef(Date.now())
  const lastActiveRef = useRef(Date.now())
  const [showStats, setShowStats] = useState(false)

  // Highlights & notes
  const [highlights, setHighlights] = useState<EpubHighlight[]>(() =>
    lsGet(`epub_highlights_${bookId}`, [])
  )
  const [showNoteInput, setShowNoteInput] = useState(false)
  const [pendingHighlight, setPendingHighlight] = useState<{ cfiRange: string; text: string } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0])

  // Highlight management
  const [highlightSort, setHighlightSort] = useState<HighlightSortMode>('time')
  const [highlightFilter, setHighlightFilter] = useState<HighlightFilterColor>('all')
  const [editingNoteIdx, setEditingNoteIdx] = useState<number | null>(null)
  const [editNoteText, setEditNoteText] = useState('')

  // Search
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Notes panel
  const [showNotes, setShowNotes] = useState(false)

  // Audio reader
  const [showAudioReader, setShowAudioReader] = useState(false)
  const [currentPageText, setCurrentPageText] = useState('')

  // Typography settings panel
  const [showTypography, setShowTypography] = useState(false)
  const [localLineHeight, setLocalLineHeight] = useState<LineHeight>(lineHeight)
  const [localPageMargin, setLocalPageMargin] = useState<PageMargin>(pageMargin)

  // Persist highlights
  useEffect(() => {
    lsSet(`epub_highlights_${bookId}`, highlights)
  }, [highlights, bookId])

  // Persist stats
  useEffect(() => {
    lsSet(`epub_stats_${bookId}`, readingStats)
  }, [readingStats, bookId])

  // Session timer
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      if (now - lastActiveRef.current < 60000) {
        setSessionElapsedSec(Math.floor((now - sessionStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Track activity
  useEffect(() => {
    const markActive = () => { lastActiveRef.current = Date.now() }
    window.addEventListener('mousemove', markActive)
    window.addEventListener('keydown', markActive)
    window.addEventListener('touchstart', markActive)
    return () => {
      window.removeEventListener('mousemove', markActive)
      window.removeEventListener('keydown', markActive)
      window.removeEventListener('touchstart', markActive)
    }
  }, [])

  // Update stats on session end
  useEffect(() => {
    const handleUnload = () => {
      const updatedStats = {
        ...readingStats,
        totalReadingTimeSec: readingStats.totalReadingTimeSec + sessionElapsedSec,
        sessionsCount: readingStats.sessionsCount + 1,
        sessionStartTime: Date.now(),
      }
      lsSet(`epub_stats_${bookId}`, updatedStats)
      syncReadingStatsToServer(bookId, updatedStats)
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [bookId, readingStats, sessionElapsedSec])

  // ─── Initialize epub.js ─────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    async function init() {
      const ePub = (await import('epubjs')).default
      if (cancelled || !containerRef.current) return

      let waitAttempts = 0
      while (containerRef.current && waitAttempts < 20) {
        const r = containerRef.current.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) break
        await new Promise(resolve => setTimeout(resolve, 50))
        waitAttempts++
      }
      if (cancelled || !containerRef.current) return

      let bookInput: string | ArrayBuffer = url
      try {
        const resp = await fetch(url)
        if (resp.ok) bookInput = await resp.arrayBuffer()
      } catch { /* fall back to URL */ }
      if (cancelled) return

      const book = ePub(bookInput)
      bookRef.current = book

      const containerEl = containerRef.current
      const rect = containerEl.getBoundingClientRect()
      const initWidth = Math.round(rect.width) || window.innerWidth
      const initHeight = Math.round(rect.height) || window.innerHeight

      const rendition = book.renderTo(containerEl, {
        width: initWidth,
        height: initHeight,
        spread: 'none',
        flow: 'paginated',
      })

      renditionRef.current = rendition

      // Fix iframe sandbox
      const iframeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLIFrameElement && node.sandbox) {
              if (!node.sandbox.toString().includes('allow-scripts')) {
                node.sandbox.add('allow-scripts')
              }
            }
          }
        }
      })
      if (containerEl) iframeObserver.observe(containerEl, { childList: true, subtree: true })

      // Fix CSP: convert blob: stylesheets to inline <style>
      rendition.hooks.content.register((contents: Contents) => {
        try {
          const doc = contents.document
          if (!doc) return
          const links = doc.querySelectorAll('link[rel="stylesheet"]')
          links.forEach((link: Element) => {
            const href = link.getAttribute('href')
            if (href && href.startsWith('blob:')) {
              fetch(href).then(r => r.text()).then(css => {
                const style = doc.createElement('style')
                style.textContent = css
                link.parentNode?.replaceChild(style, link)
              }).catch(err => console.warn('[EpubReader] op failed', err))
            }
          })
        } catch { /* silent */ }
      })

      applyTheme(rendition, theme, fontSize, fontFamily, localLineHeight, localPageMargin)

      let startLocation: string | null = null
      const serverPos = await loadEpubPositionFromServer(bookId)
      if (serverPos?.cfi) {
        startLocation = serverPos.cfi
      } else {
        startLocation = lsGet<string | null>(`epub_location_${bookId}`, null)
      }

      if (startLocation) rendition.display(startLocation)
      else rendition.display()

      book.loaded.navigation.then((nav) => {
        if (!cancelled && onTocLoaded) onTocLoaded(nav.toc)
      }).catch(() => { /* Intentionally swallowed: TOC loading is non-critical for reading */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget

      rendition.on('relocated', (location: { start?: { cfi: string; displayed?: { page: number; total: number } }; end?: { cfi: string } }) => {
        if (cancelled) return
        const cfi = location.start?.cfi
        if (cfi) {
          lsSet(`epub_location_${bookId}`, cfi)

          const percent = book.locations?.percentageFromCfi?.(cfi)
          const p = typeof percent === 'number' ? Math.round(percent * 100) : 0

          const bookTotal = (book.locations as unknown as { total?: number }).total || 0
          let page: number, total: number
          if (bookTotal > 1) {
            const locIdx = (book.locations as unknown as { locationFromCfi?: (cfi: string) => number }).locationFromCfi?.(cfi) ?? 1
            page = Math.max(1, locIdx)
            total = bookTotal
          } else {
            page = location.start?.displayed?.page || 1
            total = location.start?.displayed?.total || 1
          }

          setProgressPercent(p)
          setCurrentPage(page)
          setTotalPages(total)
          setReadingStats(prev => ({ ...prev, pagesRead: Math.max(prev.pagesRead, page) }))
          if (onProgressChange) onProgressChange(p, page, total)

          try {
            const contents = rendition.getContents() as unknown as EpubContentsEntry[]
            if (contents && contents.length > 0) {
              const doc = contents[0]?.document || contents[0]?.content?.ownerDocument
              if (doc) {
                const body = doc.querySelector?.('body') || doc.body
                setCurrentPageText(body?.textContent?.trim() || '')
              }
            }
          } catch { /* empty */ }

          syncEpubPositionToServer(bookId, cfi, p, page, total)
        }
      })

      book.ready.then(() => {
        if (cancelled) return
        return book.locations.generate(1024)
      }).then(() => {
        if (cancelled) return
        const bookTotal = (book.locations as unknown as { total?: number }).total || 0
        if (bookTotal > 1) {
          setTotalPages(bookTotal)
          if (onProgressChange) {
            const cfi = (renditionRef.current?.currentLocation() as unknown as { start?: { cfi: string } })?.start?.cfi
            if (cfi) {
              const locIdx = (book.locations as unknown as { locationFromCfi?: (cfi: string) => number }).locationFromCfi?.(cfi) ?? 1
              onProgressChange(Math.round((locIdx / bookTotal) * 100), locIdx, bookTotal)
            }
          }
        }
        setReady(true)
        setReadingStats(prev => ({
          ...prev,
          sessionsCount: prev.sessionsCount + 1,
          sessionStartTime: Date.now(),
        }))
        onReady?.()
      }).catch(() => { /* Intentionally swallowed: location generation non-critical for reading */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget

      rendition.on('selected', (cfiRange: string, contents: Contents) => {
        if (cancelled) return
        const range = contents.range(cfiRange)
        const text = range?.toString() || ''
        if (text.trim()) {
          setPendingHighlight({ cfiRange, text: text.trim() })
          setShowNoteInput(true)
        }
      })

      rendition.on('rendered', () => {
        const stored = lsGet<EpubHighlight[]>(`epub_highlights_${bookId}`, [])
        stored.forEach((h) => {
          rendition.annotations.highlight(h.cfiRange, {}, () => {}, '', { fill: h.color, 'fill-opacity': '0.3' })
        })
      })
    }

    init()

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver((entries) => {
      if (cancelled) return
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0 && renditionRef.current) {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          renditionRef.current?.resize(Math.round(width), Math.round(height))
        }, 150)
      }
    })
    if (containerRef.current) observer.observe(containerRef.current)

    return () => {
      cancelled = true
      observer.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (bookRef.current) {
        bookRef.current.destroy()
        bookRef.current = null
        renditionRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- heavy init effect; theme/font changes applied via separate useEffect
  }, [url, bookId])

  // ─── Apply theme/font changes ──────────────────────────────────
  function applyTheme(rendition: Rendition, t: ReadingTheme, fs: FontSize, ff: FontFamily, lh: LineHeight, pm: PageMargin) {
    const styles = THEME_STYLES[t]
    rendition.themes.default({
      body: {
        ...styles.body,
        'font-family': FONT_FAMILY_MAP[ff] + ' !important',
        'font-size': FONT_SIZE_MAP[fs] + '% !important',
        'line-height': LINE_HEIGHT_MAP[lh] + ' !important',
        'padding-left': PAGE_MARGIN_MAP[pm] + ' !important',
        'padding-right': PAGE_MARGIN_MAP[pm] + ' !important',
        'transition': 'background 0.3s ease, color 0.3s ease',
      },
      'p, div, span, li, td, th, h1, h2, h3, h4, h5, h6': {
        color: styles.body.color + ' !important',
      },
      'a': { color: t === 'dark' ? '#8b9cf7 !important' : '#4a6fa5 !important' },
    })
  }

  useEffect(() => {
    if (renditionRef.current && ready) {
      applyTheme(renditionRef.current, theme, fontSize, fontFamily, localLineHeight, localPageMargin)
    }
  }, [theme, fontSize, fontFamily, ready, localLineHeight, localPageMargin])

  // ─── Navigate to href (from TOC) ──────────────────────────────
  useEffect(() => {
    if (goToHref && renditionRef.current) {
      renditionRef.current.display(goToHref)
    }
  }, [goToHref])  

  // ─── Navigation ────────────────────────────────────────────────
  const goNext = useCallback(() => { renditionRef.current?.next() }, [])
  const goPrev = useCallback(() => { renditionRef.current?.prev() }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev() }
      if (e.key === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowSearch(p => !p) }
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowNotes(p => !p) }
      if (e.key === 'i' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowStats(p => !p) }
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowTypography(p => !p) }
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowAudioReader(p => !p) }
      if (e.key === 'Escape') {
        setShowSearch(false); setShowNotes(false); setShowStats(false)
        setShowTypography(false); setShowNoteInput(false); setShowAudioReader(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goNext, goPrev])

  // Touch swipe
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = e.changedTouches[0].clientY - touchStartY.current
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx < 0) goNext(); else goPrev()
    }
  }, [goNext, goPrev])

  // Click zones
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    if (x < 0.25) goPrev(); else if (x > 0.75) goNext()
  }, [goNext, goPrev])

  // ─── Search ────────────────────────────────────────────────────
  const doSearch = useCallback(async () => {
    const book = bookRef.current
    if (!book || !searchQuery.trim()) return
    setSearching(true)
    setSearchResults([])

    try {
      const results: SearchResult[] = []
      const spine = book.spine as unknown as EpubSpine
      const spineItems = spine.items || spine.spineItems || []
      for (const item of spineItems) {
        if (!item.load) continue
        try {
          const doc = await item.load(book.load.bind(book))
          if (!doc) continue
          const body = doc.querySelector?.('body') || doc.body
          if (!body) continue
          const text = body.textContent || ''
          const query = searchQuery.toLowerCase()
          let idx = text.toLowerCase().indexOf(query)
          while (idx !== -1) {
            const start = Math.max(0, idx - 30)
            const end = Math.min(text.length, idx + query.length + 30)
            const excerpt = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
            const cfi = item.cfiFromRange?.(doc.createRange?.()) || item.href
            results.push({ cfi: typeof cfi === 'string' ? cfi : item.href, excerpt })
            idx = text.toLowerCase().indexOf(query, idx + query.length)
            if (results.length > 50) break
          }
          item.unload?.()
        } catch { /* skip */ }
        if (results.length > 50) break
      }
      setSearchResults(results)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchQuery])

  // ─── Add highlight ─────────────────────────────────────────────
  const confirmHighlight = useCallback(() => {
    if (!pendingHighlight || !renditionRef.current) return
    const newHighlight: EpubHighlight = {
      cfiRange: pendingHighlight.cfiRange,
      text: pendingHighlight.text,
      note: noteText,
      color: highlightColor,
      createdAt: Date.now(),
    }
    renditionRef.current.annotations.highlight(
      pendingHighlight.cfiRange, {}, () => {}, '', { fill: highlightColor, 'fill-opacity': '0.3' }
    )
    setHighlights(prev => [...prev, newHighlight])
    setShowNoteInput(false)
    setPendingHighlight(null)
    setNoteText('')
  }, [pendingHighlight, noteText, highlightColor])

  const removeHighlight = useCallback((index: number) => {
    const h = highlights[index]
    if (h && renditionRef.current) {
      renditionRef.current.annotations.remove(h.cfiRange, 'highlight')
    }
    setHighlights(prev => prev.filter((_, i) => i !== index))
  }, [highlights])

  const updateHighlightNote = useCallback((index: number, newNote: string) => {
    setHighlights(prev => prev.map((h, i) => i === index ? { ...h, note: newNote } : h))
    setEditingNoteIdx(null)
    setEditNoteText('')
  }, [])

  // Sorted/filtered highlights
  const filteredHighlights = highlights
    .filter(h => highlightFilter === 'all' || h.color === highlightFilter)
    .sort((a, b) => {
      if (highlightSort === 'time') return b.createdAt - a.createdAt
      return a.cfiRange.localeCompare(b.cfiRange)
    })

  // ─── Derived style vars ────────────────────────────────────────
  const themeIsDark = theme === 'dark'
  const panelBg = themeIsDark ? 'var(--color-bg-secondary)' : 'var(--color-on-accent)'
  const panelText = themeIsDark ? 'var(--color-border-primary)' : 'var(--color-text-primary)'
  const panelBorder = themeIsDark ? 'var(--glass-bg-light)' : 'var(--color-overlay-subtle)'
  const panelSubtle = themeIsDark ? 'var(--overlay-hover)' : 'var(--overlay-hover)'
  const accent = 'var(--color-accent-primary, #6366f1)'
  const totalSessionTime = readingStats.totalReadingTimeSec + sessionElapsedSec
  const timeRemainingStr = estimateTimeRemaining(progressPercent, totalSessionTime)

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* ePub render container */}
      <div
        ref={containerRef}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          width: '100%',
          height: 'calc(100% - 32px)',
          transition: 'opacity 0.3s ease',
          opacity: ready ? 1 : 0.3,
        }}
      />

      {/* Loading indicator */}
      {!ready && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 32, height: 32, border: '3px solid var(--color-overlay-medium)',
            borderTopColor: accent, borderRadius: '50%',
            animation: 'epubSpin 0.8s linear infinite',
          }} />
          <span style={{ fontSize: 13, color: panelText, opacity: 0.5 }}>
            {t('epubLoading')}
          </span>
        </div>
      )}

      {/* Audio Reader overlay */}
      {showAudioReader && currentPageText && (
        <AudioReader
          text={currentPageText}
          themeIsDark={themeIsDark}
          onClose={() => setShowAudioReader(false)}
        />
      )}

      {/* Bottom toolbar */}
      <EpubToolbar
        ready={ready}
        progressPercent={progressPercent}
        currentPage={currentPage}
        totalPages={totalPages}
        sessionElapsedSec={sessionElapsedSec}
        showAudioReader={showAudioReader}
        themeIsDark={themeIsDark}
        panelBorder={panelBorder}
        accent={accent}
        timeRemainingStr={timeRemainingStr}
        onToggleAudio={() => setShowAudioReader(p => !p)}
      />

      {/* Note input modal */}
      {showNoteInput && pendingHighlight && (
        <>
          <div onClick={() => { setShowNoteInput(false); setPendingHighlight(null) }}
            role="presentation"
            style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
          <div role="dialog" aria-modal="true" aria-label={t('epubAddHighlight')} style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: panelBg, color: panelText, borderRadius: 16, padding: '24px 28px',
            width: 380, maxWidth: '90vw', zIndex: 301, boxShadow: '0 12px 40px var(--color-overlay-medium)',
            border: `1px solid ${panelBorder}`,
          }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
              {t('epubAddHighlight')}
            </h3>
            <p style={{
              fontSize: 13, lineHeight: 1.6, marginBottom: 12, padding: '8px 12px',
              background: panelSubtle, borderRadius: 8, borderLeft: `3px solid ${highlightColor}`,
              maxHeight: 80, overflow: 'auto',
            }}>
              {pendingHighlight.text.slice(0, 200)}{pendingHighlight.text.length > 200 ? '...' : ''}
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {HIGHLIGHT_COLORS.map(c => (
                <button key={c} onClick={() => setHighlightColor(c)} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, border: 'none',
                  cursor: 'pointer',
                  outline: highlightColor === c ? `2px solid ${panelText}` : 'none',
                  outlineOffset: 2, transition: 'transform 0.15s',
                  transform: highlightColor === c ? 'scale(1.15)' : 'scale(1)',
                }} />
              ))}
            </div>
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder={t('epubAddNotePlaceholder')}
              style={{
                width: '100%', minHeight: 72, padding: '10px 12px', borderRadius: 8,
                border: `1px solid ${panelBorder}`, background: panelSubtle,
                color: panelText, fontSize: 13, resize: 'vertical', outline: 'none', fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowNoteInput(false); setPendingHighlight(null) }} style={{
                padding: '8px 18px', borderRadius: 8, border: `1px solid ${panelBorder}`,
                background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 13,
              }}>
                {t('epubCancel')}
              </button>
              <button onClick={confirmHighlight} style={{
                padding: '8px 18px', borderRadius: 8, border: 'none',
                background: accent, color: 'var(--foreground)',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>
                {t('epubSave')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Search panel */}
      <EpubSearchPanel
        show={showSearch}
        onClose={() => setShowSearch(false)}
        panelBg={panelBg}
        panelText={panelText}
        panelBorder={panelBorder}
        panelSubtle={panelSubtle}
        accent={accent}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onSearch={doSearch}
        searching={searching}
        searchResults={searchResults}
        onJumpTo={(cfi) => renditionRef.current?.display(cfi)}
      />

      {/* Notes panel */}
      <EpubNotesPanel
        show={showNotes}
        onClose={() => setShowNotes(false)}
        panelBg={panelBg}
        panelText={panelText}
        panelBorder={panelBorder}
        panelSubtle={panelSubtle}
        accent={accent}
        highlights={highlights}
        highlightSort={highlightSort}
        highlightFilter={highlightFilter}
        filteredHighlights={filteredHighlights}
        editingNoteIdx={editingNoteIdx}
        editNoteText={editNoteText}
        onHighlightSortChange={setHighlightSort}
        onHighlightFilterChange={setHighlightFilter}
        onJumpToHighlight={(cfi) => renditionRef.current?.display(cfi)}
        onRemoveHighlight={removeHighlight}
        onStartEditNote={(idx, note) => { setEditingNoteIdx(idx); setEditNoteText(note) }}
        onSaveNote={updateHighlightNote}
        onCancelEditNote={() => setEditingNoteIdx(null)}
        onEditNoteTextChange={setEditNoteText}
      />

      {/* Stats panel */}
      <EpubStatsPanel
        show={showStats}
        onClose={() => setShowStats(false)}
        panelBg={panelBg}
        panelText={panelText}
        panelBorder={panelBorder}
        panelSubtle={panelSubtle}
        accent={accent}
        progressPercent={progressPercent}
        currentPage={currentPage}
        totalPages={totalPages}
        sessionElapsedSec={sessionElapsedSec}
        totalSessionTime={totalSessionTime}
        sessionsCount={readingStats.sessionsCount}
        timeRemainingStr={timeRemainingStr}
      />

      {/* Typography settings */}
      <EpubSettings
        show={showTypography}
        onClose={() => setShowTypography(false)}
        panelBg={panelBg}
        panelText={panelText}
        panelBorder={panelBorder}
        panelSubtle={panelSubtle}
        accent={accent}
        fontFamily={fontFamily}
        theme={theme}
        fontSize={fontSize}
        localLineHeight={localLineHeight}
        localPageMargin={localPageMargin}
        onLineHeightChange={setLocalLineHeight}
        onPageMarginChange={setLocalPageMargin}
      />

      {/* Expose controls */}
      <div data-epub-controls="true" style={{ display: 'none' }}
        ref={(el) => {
          if (el) {
            (el as EpubControlsElement).__epubControls = {
              goNext, goPrev,
              showSearch: () => setShowSearch(true),
              showNotes: () => setShowNotes(true),
              showStats: () => setShowStats(true),
              showTypography: () => setShowTypography(true),
              toggleSearch: () => setShowSearch(p => !p),
              toggleNotes: () => setShowNotes(p => !p),
              toggleStats: () => setShowStats(p => !p),
              toggleTypography: () => setShowTypography(p => !p),
            }
          }
        }}
      />

      <style>{`
        @keyframes epubSpin { to { transform: rotate(360deg) } }
      `}</style>
    </div>
  )
}

// Export control accessor
export function getEpubControls(container: HTMLElement | null) {
  if (!container) return null
  const el = container.querySelector('[data-epub-controls]') as EpubControlsElement | null
  return el?.__epubControls || null
}
