'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Rendition, Book, NavItem, Contents } from 'epubjs'
import AudioReader from './AudioReader'
import { supabase } from '@/lib/supabase/client'

// ─── Types ───────────────────────────────────────────────────────────

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
type FontSize = 'small' | 'medium' | 'large'
type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'

type LineHeight = 'compact' | 'normal' | 'relaxed'
type PageMargin = 'narrow' | 'normal' | 'wide'

type EpubHighlight = {
  cfiRange: string
  text: string
  note: string
  color: string
  createdAt: number
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
  isZh: boolean
  theme: ReadingTheme
  fontSize: FontSize
  fontFamily: FontFamily
  onTocLoaded?: (toc: NavItem[]) => void
  onProgressChange?: (percent: number, currentPage: number, totalPages: number) => void
  onReady?: () => void
  goToHref?: string | null
  className?: string
  // New props
  lineHeight?: LineHeight
  pageMargin?: PageMargin
  onLineHeightChange?: (lh: LineHeight) => void
  onPageMarginChange?: (pm: PageMargin) => void
}

// ─── Constants ───────────────────────────────────────────────────────

const THEME_STYLES: Record<ReadingTheme, { body: Record<string, string> }> = {
  white: { body: { background: '#FFFFFF', color: '#1a1a1a' } },
  sepia: { body: { background: '#F4ECD8', color: '#5b4636' } },
  dark:  { body: { background: 'var(--color-bg-secondary)', color: '#d4d4d8' } },
  green: { body: { background: '#C7EDCC', color: '#2d4a32' } },
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

const HIGHLIGHT_COLORS = ['#FFEB3B', '#81D4FA', '#A5D6A7', '#FFAB91', '#CE93D8']

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

function formatDuration(seconds: number, isZh: boolean): string {
  if (seconds < 60) return isZh ? `${seconds}秒` : `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return isZh ? `${m}分钟` : `${m}min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return isZh ? `${h}小时${rm > 0 ? rm + '分钟' : ''}` : `${h}h ${rm > 0 ? rm + 'm' : ''}`
}

function estimateTimeRemaining(percent: number, elapsedSec: number, isZh: boolean): string {
  if (percent <= 0 || elapsedSec < 30) return isZh ? '计算中...' : 'Calculating...'
  const totalEstimate = elapsedSec / (percent / 100)
  const remaining = Math.max(0, totalEstimate - elapsedSec)
  return formatDuration(Math.round(remaining), isZh)
}

// ─── Component ───────────────────────────────────────────────────────

export default function EpubReader({
  url,
  bookId,
  isZh,
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

  // Session timer - track active reading time
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      // Only count time if user was active in last 60s (not idle)
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

  // Update stats on session end (unload)
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

      const book = ePub(url)
      bookRef.current = book

      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      })

      renditionRef.current = rendition

      // Apply theme
      applyTheme(rendition, theme, fontSize, fontFamily, localLineHeight, localPageMargin)

      // Try server position first, then local
      let startLocation: string | null = null
      const serverPos = await loadEpubPositionFromServer(bookId)
      if (serverPos?.cfi) {
        startLocation = serverPos.cfi
      } else {
        startLocation = lsGet<string | null>(`epub_location_${bookId}`, null)
      }

      if (startLocation) {
        rendition.display(startLocation)
      } else {
        rendition.display()
      }

      // TOC
      book.loaded.navigation.then((nav) => {
        if (!cancelled && onTocLoaded) {
          onTocLoaded(nav.toc)
        }
      })

      // Track location changes
      rendition.on('relocated', (location: any) => {
        if (cancelled) return
        const cfi = location.start?.cfi
        if (cfi) {
          lsSet(`epub_location_${bookId}`, cfi)

          const percent = book.locations?.percentageFromCfi?.(cfi)
          const p = typeof percent === 'number' ? Math.round(percent * 100) : 0
          const page = location.start.displayed?.page || 1
          const total = location.start.displayed?.total || 1

          setProgressPercent(p)
          setCurrentPage(page)
          setTotalPages(total)

          // Track pages read
          setReadingStats(prev => ({
            ...prev,
            pagesRead: Math.max(prev.pagesRead, page),
          }))

          if (onProgressChange) {
            onProgressChange(p, page, total)
          }

          // Extract page text for audio reader
          try {
            const contents = rendition.getContents() as any
            if (contents && contents.length > 0) {
              const doc = contents[0]?.document || contents[0]?.content?.ownerDocument
              if (doc) {
                const body = doc.querySelector?.('body') || doc.body
                setCurrentPageText(body?.textContent?.trim() || '')
              }
            }
          } catch { /* empty */ }

          // Sync to server (debounced by nature of user interaction)
          syncEpubPositionToServer(bookId, cfi, p, page, total)
        }
      })

      // Generate locations for progress
      book.ready.then(() => {
        if (cancelled) return
        return book.locations.generate(1024)
      }).then(() => {
        if (cancelled) return
        setReady(true)
        // Increment session count
        setReadingStats(prev => ({
          ...prev,
          sessionsCount: prev.sessionsCount + 1,
          sessionStartTime: Date.now(),
        }))
        onReady?.()
      })

      // Handle text selection for highlights
      rendition.on('selected', (cfiRange: string, contents: Contents) => {
        if (cancelled) return
        const range = contents.range(cfiRange)
        const text = range?.toString() || ''
        if (text.trim()) {
          setPendingHighlight({ cfiRange, text: text.trim() })
          setShowNoteInput(true)
        }
      })

      // Restore existing highlights
      rendition.on('rendered', () => {
        const stored = lsGet<EpubHighlight[]>(`epub_highlights_${bookId}`, [])
        stored.forEach((h) => {
          rendition.annotations.highlight(h.cfiRange, {}, () => {}, '', {
            fill: h.color,
            'fill-opacity': '0.3',
          })
        })
      })
    }

    init()

    return () => {
      cancelled = true
      if (bookRef.current) {
        bookRef.current.destroy()
        bookRef.current = null
        renditionRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      'a': {
        color: t === 'dark' ? '#8b9cf7 !important' : '#4a6fa5 !important',
      },
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
  const goNext = useCallback(() => {
    renditionRef.current?.next()
  }, [])

  const goPrev = useCallback(() => {
    renditionRef.current?.prev()
  }, [])

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      // Navigation
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev() }

      // Panels
      if (e.key === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowSearch(p => !p) }
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowNotes(p => !p) }
      if (e.key === 'i' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowStats(p => !p) }
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowTypography(p => !p) }
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowAudioReader(p => !p) }
      if (e.key === 'Escape') {
        setShowSearch(false)
        setShowNotes(false)
        setShowStats(false)
        setShowTypography(false)
        setShowNoteInput(false)
        setShowAudioReader(false)
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
      if (dx < 0) goNext()
      else goPrev()
    }
  }, [goNext, goPrev])

  // Click zones
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, a')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    if (x < 0.25) goPrev()
    else if (x > 0.75) goNext()
  }, [goNext, goPrev])

  // ─── Search ────────────────────────────────────────────────────
  const doSearch = useCallback(async () => {
    const book = bookRef.current
    if (!book || !searchQuery.trim()) return
    setSearching(true)
    setSearchResults([])

    try {
      const results: SearchResult[] = []
      const spine = book.spine as any
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
      pendingHighlight.cfiRange, {}, () => {}, '', {
        fill: highlightColor,
        'fill-opacity': '0.3',
      }
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

  // ─── Render ────────────────────────────────────────────────────

  const themeIsDark = theme === 'dark'
  const panelBg = themeIsDark ? '#1e1e36' : '#fff'
  const panelText = themeIsDark ? '#d4d4d8' : '#1a1a1a'
  const panelBorder = themeIsDark ? 'var(--glass-bg-light)' : 'var(--color-overlay-subtle)'
  const panelSubtle = themeIsDark ? 'var(--overlay-hover)' : 'rgba(0,0,0,0.03)'
  const accent = 'var(--color-accent-primary, #6366f1)'

  const totalSessionTime = readingStats.totalReadingTimeSec + sessionElapsedSec
  const timeRemainingStr = estimateTimeRemaining(progressPercent, totalSessionTime, isZh)

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
          height: '100%',
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
            width: 32, height: 32, border: '3px solid rgba(128,128,128,0.2)',
            borderTopColor: accent, borderRadius: '50%',
            animation: 'epubSpin 0.8s linear infinite',
          }} />
          <span style={{ fontSize: 13, color: panelText, opacity: 0.5 }}>
            {isZh ? '正在加载...' : 'Loading...'}
          </span>
        </div>
      )}

      {/* Audio Reader overlay */}
      {showAudioReader && currentPageText && (
        <AudioReader
          text={currentPageText}
          isZh={isZh}
          themeIsDark={themeIsDark}
          onClose={() => {
            setShowAudioReader(false)
          }}
        />
      )}

      {/* ─── Bottom progress info bar ─────────────────────── */}
      {ready && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 16px',
          background: themeIsDark ? 'rgba(15,15,26,0.85)' : 'rgba(255,255,255,0.9)',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          borderTop: `1px solid ${panelBorder}`,
          fontSize: 11, color: themeIsDark ? 'var(--glass-border-heavy)' : 'rgba(0,0,0,0.4)',
          zIndex: 50,
        }}>
          <span>{progressPercent}% -- {currentPage}/{totalPages}</span>
          <span>
            {isZh ? '本次阅读 ' : 'Session: '}{formatDuration(sessionElapsedSec, isZh)}
          </span>
          <span>
            {isZh ? '预计剩余 ' : 'Remaining: '}{timeRemainingStr}
          </span>
          <button
            onClick={() => setShowAudioReader(p => !p)}
            style={{
              padding: '2px 10px', borderRadius: 6, fontSize: 11,
              border: `1px solid ${panelBorder}`,
              background: showAudioReader ? accent : 'transparent',
              color: showAudioReader ? '#fff' : 'inherit',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {isZh ? '朗读模式' : 'Audio'}
          </button>
        </div>
      )}

      {/* Note input modal */}
      {showNoteInput && pendingHighlight && (
        <>
          <div onClick={() => { setShowNoteInput(false); setPendingHighlight(null) }}
            role="presentation"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div role="dialog" aria-modal="true" aria-label={isZh ? '添加高亮和笔记' : 'Add Highlight & Note'} style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: panelBg, color: panelText, borderRadius: 16, padding: '24px 28px',
            width: 380, maxWidth: '90vw', zIndex: 301, boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
            border: `1px solid ${panelBorder}`,
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>
              {isZh ? '添加高亮和笔记' : 'Add Highlight & Note'}
            </h3>
            <p style={{
              fontSize: 13, lineHeight: 1.6, marginBottom: 12, padding: '8px 12px',
              background: panelSubtle,
              borderRadius: 8, borderLeft: `3px solid ${highlightColor}`,
              maxHeight: 80, overflow: 'auto',
            }}>
              {pendingHighlight.text.slice(0, 200)}{pendingHighlight.text.length > 200 ? '...' : ''}
            </p>

            {/* Color picker */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {HIGHLIGHT_COLORS.map(c => (
                <button key={c} onClick={() => setHighlightColor(c)} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, border: 'none',
                  cursor: 'pointer',
                  outline: highlightColor === c ? `2px solid ${panelText}` : 'none',
                  outlineOffset: 2,
                  transition: 'transform 0.15s',
                  transform: highlightColor === c ? 'scale(1.15)' : 'scale(1)',
                }} />
              ))}
            </div>

            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder={isZh ? '添加笔记（可选）...' : 'Add a note (optional)...'}
              style={{
                width: '100%', minHeight: 72, padding: '10px 12px', borderRadius: 8,
                border: `1px solid ${panelBorder}`, background: panelSubtle,
                color: panelText, fontSize: 13, resize: 'vertical', outline: 'none',
                fontFamily: 'inherit',
              }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowNoteInput(false); setPendingHighlight(null) }} style={{
                padding: '8px 18px', borderRadius: 8, border: `1px solid ${panelBorder}`,
                background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 13,
              }}>
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button onClick={confirmHighlight} style={{
                padding: '8px 18px', borderRadius: 8, border: 'none',
                background: accent, color: '#fff',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}>
                {isZh ? '保存' : 'Save'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Search panel */}
      {showSearch && (
        <>
          <div onClick={() => setShowSearch(false)}
            role="presentation"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div role="dialog" aria-modal="true" aria-label={isZh ? '搜索内容' : 'Search'} style={{
            position: 'fixed', top: 60, right: 12, width: 380, maxWidth: '90vw', maxHeight: '70vh',
            background: panelBg, color: panelText, borderRadius: 16, zIndex: 301,
            boxShadow: 'var(--shadow-lg-dark)', border: `1px solid ${panelBorder}`,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{ padding: '14px 16px', borderBottom: `1px solid ${panelBorder}` }}>
              <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
                {isZh ? '搜索内容' : 'Search'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') doSearch() }}
                  placeholder={isZh ? '输入关键词...' : 'Enter keyword...'}
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 8,
                    border: `1px solid ${panelBorder}`,
                    background: panelSubtle,
                    color: panelText, fontSize: 13, outline: 'none',
                  }}
                  autoFocus
                />
                <button onClick={doSearch} disabled={searching} style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none',
                  background: accent, color: '#fff',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                  opacity: searching ? 0.6 : 1,
                }}>
                  {searching ? (isZh ? '搜索中...' : 'Searching...') : (isZh ? '搜索' : 'Search')}
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              {searchResults.length === 0 && !searching && searchQuery && (
                <p style={{ padding: '20px', fontSize: 13, opacity: 0.4, textAlign: 'center' }}>
                  {isZh ? '未找到结果' : 'No results found'}
                </p>
              )}
              {searchResults.map((r, i) => (
                <button key={i} onClick={() => {
                  renditionRef.current?.display(r.cfi)
                  setShowSearch(false)
                }} style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px',
                  border: 'none', background: 'transparent', color: panelText,
                  cursor: 'pointer', fontSize: 13, lineHeight: 1.5,
                  borderBottom: `1px solid ${panelBorder}`,
                  transition: 'background 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = panelSubtle}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {r.excerpt}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Notes/Highlights panel - Enhanced */}
      {showNotes && (
        <>
          <div onClick={() => setShowNotes(false)}
            role="presentation"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div role="dialog" aria-modal="true" aria-label={isZh ? '笔记与高亮' : 'Notes & Highlights'} style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 380, maxWidth: '85vw', zIndex: 301,
            background: panelBg, color: panelText, boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '16px 16px 12px', borderBottom: `1px solid ${panelBorder}`,
            }}>
              <div>
                <span style={{ fontSize: 15, fontWeight: 700 }}>
                  {isZh ? '高亮和笔记' : 'Highlights & Notes'}
                </span>
                <span style={{ fontSize: 12, opacity: 0.4, marginLeft: 8 }}>
                  {highlights.length}{isZh ? ' 条' : ''}
                </span>
              </div>
              <button aria-label="Close notes panel" onClick={() => setShowNotes(false)} style={{
                background: 'none', border: 'none', color: panelText, cursor: 'pointer', padding: 4, opacity: 0.5,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Filters & Sort */}
            {highlights.length > 0 && (
              <div style={{
                padding: '10px 16px', borderBottom: `1px solid ${panelBorder}`,
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                {/* Color filter */}
                <button onClick={() => setHighlightFilter('all')} style={{
                  width: 20, height: 20, borderRadius: '50%', border: `2px solid ${panelBorder}`,
                  background: 'linear-gradient(135deg, #FFEB3B 25%, #81D4FA 25%, #81D4FA 50%, #A5D6A7 50%, #A5D6A7 75%, #CE93D8 75%)',
                  cursor: 'pointer', outline: highlightFilter === 'all' ? `2px solid ${panelText}` : 'none',
                  outlineOffset: 2, flexShrink: 0,
                }} />
                {HIGHLIGHT_COLORS.map(c => (
                  <button key={c} onClick={() => setHighlightFilter(c)} style={{
                    width: 20, height: 20, borderRadius: '50%', background: c, border: 'none',
                    cursor: 'pointer', outline: highlightFilter === c ? `2px solid ${panelText}` : 'none',
                    outlineOffset: 2, flexShrink: 0,
                  }} />
                ))}
                <div style={{ flex: 1 }} />
                <select value={highlightSort} onChange={e => setHighlightSort(e.target.value as HighlightSortMode)} style={{
                  padding: '4px 8px', borderRadius: 6, border: `1px solid ${panelBorder}`,
                  background: panelSubtle, color: panelText, fontSize: 11, outline: 'none',
                }}>
                  <option value="time">{isZh ? '按时间' : 'By time'}</option>
                  <option value="position">{isZh ? '按位置' : 'By position'}</option>
                </select>
              </div>
            )}

            {/* Highlights list */}
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              {highlights.length === 0 && (
                <div style={{ padding: 32, textAlign: 'center' }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.15, margin: '0 auto 12px' }}>
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                  <p style={{ fontSize: 13, opacity: 0.35, lineHeight: 1.6 }}>
                    {isZh ? '暂无高亮或笔记。\n选中文字即可添加。' : 'No highlights yet.\nSelect text to add.'}
                  </p>
                </div>
              )}
              {filteredHighlights.map((h, _i) => {
                const realIdx = highlights.indexOf(h)
                return (
                  <div key={realIdx} style={{
                    padding: '14px 16px', borderBottom: `1px solid ${panelBorder}`,
                    cursor: 'pointer', transition: 'background 0.15s',
                  }}
                    onClick={() => {
                      renditionRef.current?.display(h.cfiRange)
                      setShowNotes(false)
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = panelSubtle}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <p style={{
                      fontSize: 13, lineHeight: 1.6, marginBottom: h.note ? 8 : 0,
                      borderLeft: `3px solid ${h.color}`, paddingLeft: 10,
                    }}>
                      {h.text.slice(0, 200)}{h.text.length > 200 ? '...' : ''}
                    </p>

                    {editingNoteIdx === realIdx ? (
                      <div style={{ paddingLeft: 13, marginTop: 6 }} onClick={e => e.stopPropagation()}>
                        <textarea
                          value={editNoteText}
                          onChange={e => setEditNoteText(e.target.value)}
                          style={{
                            width: '100%', minHeight: 48, padding: '6px 10px', borderRadius: 6,
                            border: `1px solid ${panelBorder}`, background: panelSubtle,
                            color: panelText, fontSize: 12, resize: 'vertical', outline: 'none',
                            fontFamily: 'inherit',
                          }}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button onClick={(e) => { e.stopPropagation(); updateHighlightNote(realIdx, editNoteText) }} style={{
                            padding: '4px 12px', borderRadius: 6, border: 'none',
                            background: accent, color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                          }}>{isZh ? '保存' : 'Save'}</button>
                          <button onClick={(e) => { e.stopPropagation(); setEditingNoteIdx(null) }} style={{
                            padding: '4px 12px', borderRadius: 6, border: `1px solid ${panelBorder}`,
                            background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 11,
                          }}>{isZh ? '取消' : 'Cancel'}</button>
                        </div>
                      </div>
                    ) : h.note ? (
                      <p style={{ fontSize: 12, opacity: 0.55, paddingLeft: 13, fontStyle: 'italic', lineHeight: 1.5 }}>
                        {h.note}
                      </p>
                    ) : null}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingLeft: 13 }}>
                      <span style={{ fontSize: 11, opacity: 0.25 }}>
                        {new Date(h.createdAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={(e) => {
                          e.stopPropagation()
                          setEditingNoteIdx(realIdx)
                          setEditNoteText(h.note)
                        }} style={{
                          background: 'none', border: 'none', color: panelText, cursor: 'pointer',
                          fontSize: 11, opacity: 0.35, padding: '2px 4px',
                        }}>
                          {isZh ? '编辑' : 'Edit'}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); removeHighlight(realIdx) }} style={{
                          background: 'none', border: 'none', color: '#e57373', cursor: 'pointer',
                          fontSize: 11, opacity: 0.5, padding: '2px 4px',
                        }}>
                          {isZh ? '删除' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Export highlights */}
            {highlights.length > 0 && (
              <div style={{ padding: '10px 16px', borderTop: `1px solid ${panelBorder}` }}>
                <button onClick={() => {
                  const text = highlights.map(h =>
                    `"${h.text}"${h.note ? `\n  -- ${h.note}` : ''}\n  [${new Date(h.createdAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}]`
                  ).join('\n\n---\n\n')
                  navigator.clipboard?.writeText(text)
                }} style={{
                  width: '100%', padding: '8px', borderRadius: 8, border: `1px solid ${panelBorder}`,
                  background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 12,
                  opacity: 0.6, transition: 'opacity 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
                >
                  {isZh ? '复制全部笔记到剪贴板' : 'Copy all notes to clipboard'}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* ─── Reading Statistics Panel ─────────────────────── */}
      {showStats && (
        <>
          <div onClick={() => setShowStats(false)}
            role="presentation"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div role="dialog" aria-modal="true" aria-label={isZh ? '阅读统计' : 'Reading Statistics'} style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: panelBg, color: panelText, borderRadius: 20, padding: '28px 32px',
            width: 360, maxWidth: '90vw', zIndex: 301, boxShadow: 'var(--shadow-elevated)',
            border: `1px solid ${panelBorder}`,
          }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, textAlign: 'center' }}>
              {isZh ? '阅读统计' : 'Reading Statistics'}
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <StatCard
                label={isZh ? '阅读进度' : 'Progress'}
                value={`${progressPercent}%`}
                themeIsDark={themeIsDark}
              />
              <StatCard
                label={isZh ? '当前页' : 'Current Page'}
                value={`${currentPage}/${totalPages}`}
                themeIsDark={themeIsDark}
              />
              <StatCard
                label={isZh ? '本次时长' : 'This Session'}
                value={formatDuration(sessionElapsedSec, isZh)}
                themeIsDark={themeIsDark}
              />
              <StatCard
                label={isZh ? '累计阅读' : 'Total Time'}
                value={formatDuration(totalSessionTime, isZh)}
                themeIsDark={themeIsDark}
              />
              <StatCard
                label={isZh ? '阅读次数' : 'Sessions'}
                value={`${readingStats.sessionsCount}`}
                themeIsDark={themeIsDark}
              />
              <StatCard
                label={isZh ? '预计剩余' : 'Remaining'}
                value={timeRemainingStr}
                themeIsDark={themeIsDark}
              />
            </div>

            {/* Progress bar */}
            <div style={{ marginTop: 20 }}>
              <div style={{
                height: 6, borderRadius: 3, background: panelSubtle, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 3, width: `${progressPercent}%`,
                  background: accent, transition: 'width 0.3s ease',
                }} />
              </div>
            </div>

            <button onClick={() => setShowStats(false)} style={{
              display: 'block', width: '100%', marginTop: 20, padding: '10px',
              borderRadius: 10, border: `1px solid ${panelBorder}`,
              background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 13,
            }}>
              {isZh ? '关闭' : 'Close'}
            </button>
          </div>
        </>
      )}

      {/* ─── Typography Settings Panel ────────────────────── */}
      {showTypography && (
        <>
          <div onClick={() => setShowTypography(false)}
            role="presentation"
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div role="dialog" aria-modal="true" aria-label={isZh ? '排版设置' : 'Typography'} style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: panelBg, color: panelText, borderRadius: 20, padding: '28px 32px',
            width: 380, maxWidth: '90vw', zIndex: 301, boxShadow: 'var(--shadow-elevated)',
            border: `1px solid ${panelBorder}`,
          }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
              {isZh ? '排版设置' : 'Typography'}
            </h3>

            {/* Font Family */}
            <div style={{ marginBottom: 18 }}>
              <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
                {isZh ? '字体' : 'Font Family'}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(Object.entries(FONT_FAMILY_MAP) as [FontFamily, string][]).map(([key, css]) => {
                  const labels: Record<FontFamily, { zh: string; en: string }> = {
                    sans: { zh: '黑体', en: 'Sans' },
                    serif: { zh: '宋体', en: 'Serif' },
                    mono: { zh: '等宽', en: 'Mono' },
                    kai: { zh: '楷体', en: 'Kai' },
                  }
                  return (
                    <button key={key} onClick={() => {
                      // fontFamily is controlled by parent, but we expose via typography panel
                    }} style={{
                      padding: '10px 8px', borderRadius: 10,
                      background: fontFamily === key ? accent : panelSubtle,
                      color: fontFamily === key ? '#fff' : panelText,
                      border: 'none', cursor: 'pointer', fontSize: 14,
                      fontFamily: css, fontWeight: 600, transition: 'all 0.15s',
                    }}>
                      {isZh ? labels[key].zh : labels[key].en}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Line Height */}
            <div style={{ marginBottom: 18, borderTop: `1px solid ${panelBorder}`, paddingTop: 16 }}>
              <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
                {isZh ? '行间距' : 'Line Height'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['compact', 'normal', 'relaxed'] as LineHeight[]).map(lh => {
                  const labels: Record<LineHeight, { zh: string; en: string }> = {
                    compact: { zh: '紧凑', en: 'Compact' },
                    normal: { zh: '标准', en: 'Normal' },
                    relaxed: { zh: '宽松', en: 'Relaxed' },
                  }
                  return (
                    <button key={lh} onClick={() => setLocalLineHeight(lh)} style={{
                      flex: 1, padding: '8px 4px', borderRadius: 10,
                      background: localLineHeight === lh ? accent : panelSubtle,
                      color: localLineHeight === lh ? '#fff' : panelText,
                      border: 'none', cursor: 'pointer', fontSize: 12,
                      fontWeight: 600, transition: 'all 0.15s',
                    }}>
                      {isZh ? labels[lh].zh : labels[lh].en}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Page Margin */}
            <div style={{ marginBottom: 18, borderTop: `1px solid ${panelBorder}`, paddingTop: 16 }}>
              <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.5 }}>
                {isZh ? '页面边距' : 'Page Margins'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['narrow', 'normal', 'wide'] as PageMargin[]).map(pm => {
                  const labels: Record<PageMargin, { zh: string; en: string }> = {
                    narrow: { zh: '窄', en: 'Narrow' },
                    normal: { zh: '标准', en: 'Normal' },
                    wide: { zh: '宽', en: 'Wide' },
                  }
                  return (
                    <button key={pm} onClick={() => setLocalPageMargin(pm)} style={{
                      flex: 1, padding: '8px 4px', borderRadius: 10,
                      background: localPageMargin === pm ? accent : panelSubtle,
                      color: localPageMargin === pm ? '#fff' : panelText,
                      border: 'none', cursor: 'pointer', fontSize: 12,
                      fontWeight: 600, transition: 'all 0.15s',
                    }}>
                      {isZh ? labels[pm].zh : labels[pm].en}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Keyboard shortcuts reference */}
            <div style={{ borderTop: `1px solid ${panelBorder}`, paddingTop: 14 }}>
              <p style={{ fontSize: 11, opacity: 0.35, lineHeight: 1.7 }}>
                {isZh
                  ? '快捷键: 方向键/空格 翻页 | S 搜索 | N 笔记 | I 统计 | T 排版 | Esc 关闭'
                  : 'Keys: Arrows/Space nav | S search | N notes | I stats | T typography | Esc close'}
              </p>
            </div>
          </div>
        </>
      )}

      {/* Expose controls via data attributes */}
      <div data-epub-controls="true" style={{ display: 'none' }}
        ref={(el) => {
          if (el) {
            (el as any).__epubControls = {
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

// ─── Stat Card ───────────────────────────────────────────────────────

function StatCard({ label, value, themeIsDark }: { label: string; value: string; themeIsDark: boolean }) {
  return (
    <div style={{
      padding: '14px 12px', borderRadius: 12,
      background: themeIsDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
      textAlign: 'center',
    }}>
      <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{value}</p>
      <p style={{ fontSize: 11, opacity: 0.4 }}>{label}</p>
    </div>
  )
}

// Export control accessor
export function getEpubControls(container: HTMLElement | null) {
  if (!container) return null
  const el = container.querySelector('[data-epub-controls]') as any
  return el?.__epubControls || null
}
