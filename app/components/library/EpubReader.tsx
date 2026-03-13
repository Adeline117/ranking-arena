'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Rendition, Book, Contents } from 'epubjs'
import AudioReader from './AudioReader'
import { EpubToolbar } from './EpubToolbar'
import { EpubSettings } from './EpubSettings'
import { EpubSearchPanel, EpubNotesPanel, EpubStatsPanel, type EpubHighlight } from './EpubNavigation'
import EpubNoteInputModal from './EpubNoteInputModal'
import EpubLoadingIndicator from './EpubLoadingIndicator'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  type ReadingTheme,
  type FontSize,
  type FontFamily,
  type LineHeight,
  type PageMargin,
  type EpubSpine,
  type EpubContentsEntry,
  type EpubControlsElement,
  type SearchResult,
  type ReadingStats,
  type HighlightSortMode,
  type HighlightFilterColor,
  type EpubReaderProps,
  HIGHLIGHT_COLORS,
  lsGet,
  lsSet,
  syncEpubPositionToServer,
  loadEpubPositionFromServer,
  syncReadingStatsToServer,
  estimateTimeRemaining,
  applyTheme,
} from './EpubReaderUtils'

// Re-export types for external consumers
export type { EpubReaderProps }

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

  const cancelNoteInput = useCallback(() => {
    setShowNoteInput(false)
    setPendingHighlight(null)
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
      {!ready && <EpubLoadingIndicator panelText={panelText} accent={accent} />}

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
        <EpubNoteInputModal
          pendingHighlight={pendingHighlight}
          noteText={noteText}
          highlightColor={highlightColor}
          panelBg={panelBg}
          panelText={panelText}
          panelBorder={panelBorder}
          panelSubtle={panelSubtle}
          accent={accent}
          onNoteTextChange={setNoteText}
          onHighlightColorChange={setHighlightColor}
          onConfirm={confirmHighlight}
          onCancel={cancelNoteInput}
        />
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
