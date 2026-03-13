'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Rendition, Book } from 'epubjs'
import AudioReader from './AudioReader'
import { EpubToolbar } from './EpubToolbar'
import { EpubSettings } from './EpubSettings'
import { EpubSearchPanel, EpubNotesPanel, EpubStatsPanel } from './EpubNavigation'
import EpubNoteInputModal from './EpubNoteInputModal'
import EpubLoadingIndicator from './EpubLoadingIndicator'
import { useEpubHighlights } from './useEpubHighlights'
import { useEpubSearch } from './useEpubSearch'
import { useEpubReadingStats } from './useEpubReadingStats'
import { useEpubInit } from './useEpubInit'
import {
  type LineHeight,
  type PageMargin,
  type EpubControlsElement,
  type EpubReaderProps,
  estimateTimeRemaining,
  applyTheme,
} from './EpubReaderUtils'

// Re-export types for external consumers
export type { EpubReaderProps }

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
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [ready, setReady] = useState(false)

  // Progress
  const [progressPercent, setProgressPercent] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  // Custom hooks
  const stats = useEpubReadingStats(bookId)
  const highlights = useEpubHighlights(bookId, renditionRef)
  const search = useEpubSearch(bookRef)

  // Audio reader
  const [showAudioReader, setShowAudioReader] = useState(false)
  const [currentPageText, setCurrentPageText] = useState('')

  // Typography settings panel
  const [showTypography, setShowTypography] = useState(false)
  const [localLineHeight, setLocalLineHeight] = useState<LineHeight>(lineHeight)
  const [localPageMargin, setLocalPageMargin] = useState<PageMargin>(pageMargin)

  // Notes panel
  const [showNotes, setShowNotes] = useState(false)

  // Init config (stable reference for hook)
  const initConfig = useMemo(() => ({
    url, bookId, theme, fontSize, fontFamily,
    lineHeight: localLineHeight, pageMargin: localPageMargin,
  }), [url, bookId, theme, fontSize, fontFamily, localLineHeight, localPageMargin])

  // Initialize epub.js
  useEpubInit(containerRef, bookRef, renditionRef, initConfig, {
    onProgressUpdate: (percent, page, total) => {
      if (percent >= 0) {
        setProgressPercent(percent)
        setCurrentPage(page)
        stats.updatePagesRead(page)
      }
      if (total > 0) setTotalPages(total)
    },
    onPageTextUpdate: setCurrentPageText,
    onTextSelected: highlights.onTextSelected,
    onSessionReady: () => {
      setReady(true)
      stats.incrementSession()
    },
    onReady,
    onTocLoaded,
    onProgressChange,
  })

  // Apply theme/font changes
  useEffect(() => {
    if (renditionRef.current && ready) {
      applyTheme(renditionRef.current, theme, fontSize, fontFamily, localLineHeight, localPageMargin)
    }
  }, [theme, fontSize, fontFamily, ready, localLineHeight, localPageMargin])

  // Navigate to href (from TOC)
  useEffect(() => {
    if (goToHref && renditionRef.current) {
      renditionRef.current.display(goToHref)
    }
  }, [goToHref])

  // Navigation
  const goNext = useCallback(() => { renditionRef.current?.next() }, [])
  const goPrev = useCallback(() => { renditionRef.current?.prev() }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev() }
      if (e.key === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search.setShowSearch(p => !p) }
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowNotes(p => !p) }
      if (e.key === 'i' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); stats.setShowStats(p => !p) }
      if (e.key === 't' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowTypography(p => !p) }
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setShowAudioReader(p => !p) }
      if (e.key === 'Escape') {
        search.setShowSearch(false); setShowNotes(false); stats.setShowStats(false)
        setShowTypography(false); setShowAudioReader(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goNext, goPrev, search, stats])

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

  // Derived style vars
  const themeIsDark = theme === 'dark'
  const panelBg = themeIsDark ? 'var(--color-bg-secondary)' : 'var(--color-on-accent)'
  const panelText = themeIsDark ? 'var(--color-border-primary)' : 'var(--color-text-primary)'
  const panelBorder = themeIsDark ? 'var(--glass-bg-light)' : 'var(--color-overlay-subtle)'
  const panelSubtle = themeIsDark ? 'var(--overlay-hover)' : 'var(--overlay-hover)'
  const accent = 'var(--color-accent-primary, #6366f1)'
  const totalSessionTime = stats.readingStats.totalReadingTimeSec + stats.sessionElapsedSec
  const timeRemainingStr = estimateTimeRemaining(progressPercent, totalSessionTime)

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%' }}>
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

      {!ready && <EpubLoadingIndicator panelText={panelText} accent={accent} />}

      {showAudioReader && currentPageText && (
        <AudioReader text={currentPageText} themeIsDark={themeIsDark} onClose={() => setShowAudioReader(false)} />
      )}

      <EpubToolbar
        ready={ready} progressPercent={progressPercent} currentPage={currentPage} totalPages={totalPages}
        sessionElapsedSec={stats.sessionElapsedSec} showAudioReader={showAudioReader} themeIsDark={themeIsDark}
        panelBorder={panelBorder} accent={accent} timeRemainingStr={timeRemainingStr}
        onToggleAudio={() => setShowAudioReader(p => !p)}
      />

      {highlights.showNoteInput && highlights.pendingHighlight && (
        <EpubNoteInputModal
          pendingHighlight={highlights.pendingHighlight} noteText={highlights.noteText}
          highlightColor={highlights.highlightColor} panelBg={panelBg} panelText={panelText}
          panelBorder={panelBorder} panelSubtle={panelSubtle} accent={accent}
          onNoteTextChange={highlights.setNoteText} onHighlightColorChange={highlights.setHighlightColor}
          onConfirm={highlights.confirmHighlight} onCancel={highlights.cancelNoteInput}
        />
      )}

      <EpubSearchPanel
        show={search.showSearch} onClose={() => search.setShowSearch(false)}
        panelBg={panelBg} panelText={panelText} panelBorder={panelBorder} panelSubtle={panelSubtle} accent={accent}
        searchQuery={search.searchQuery} onSearchQueryChange={search.setSearchQuery}
        onSearch={search.doSearch} searching={search.searching} searchResults={search.searchResults}
        onJumpTo={(cfi) => renditionRef.current?.display(cfi)}
      />

      <EpubNotesPanel
        show={showNotes} onClose={() => setShowNotes(false)}
        panelBg={panelBg} panelText={panelText} panelBorder={panelBorder} panelSubtle={panelSubtle} accent={accent}
        highlights={highlights.highlights} highlightSort={highlights.highlightSort}
        highlightFilter={highlights.highlightFilter} filteredHighlights={highlights.filteredHighlights}
        editingNoteIdx={highlights.editingNoteIdx} editNoteText={highlights.editNoteText}
        onHighlightSortChange={highlights.setHighlightSort} onHighlightFilterChange={highlights.setHighlightFilter}
        onJumpToHighlight={(cfi) => renditionRef.current?.display(cfi)}
        onRemoveHighlight={highlights.removeHighlight}
        onStartEditNote={(idx, note) => { highlights.setEditingNoteIdx(idx); highlights.setEditNoteText(note) }}
        onSaveNote={highlights.updateHighlightNote} onCancelEditNote={() => highlights.setEditingNoteIdx(null)}
        onEditNoteTextChange={highlights.setEditNoteText}
      />

      <EpubStatsPanel
        show={stats.showStats} onClose={() => stats.setShowStats(false)}
        panelBg={panelBg} panelText={panelText} panelBorder={panelBorder} panelSubtle={panelSubtle} accent={accent}
        progressPercent={progressPercent} currentPage={currentPage} totalPages={totalPages}
        sessionElapsedSec={stats.sessionElapsedSec} totalSessionTime={totalSessionTime}
        sessionsCount={stats.readingStats.sessionsCount} timeRemainingStr={timeRemainingStr}
      />

      <EpubSettings
        show={showTypography} onClose={() => setShowTypography(false)}
        panelBg={panelBg} panelText={panelText} panelBorder={panelBorder} panelSubtle={panelSubtle} accent={accent}
        fontFamily={fontFamily} theme={theme} fontSize={fontSize}
        localLineHeight={localLineHeight} localPageMargin={localPageMargin}
        onLineHeightChange={setLocalLineHeight} onPageMarginChange={setLocalPageMargin}
      />

      <div data-epub-controls="true" style={{ display: 'none' }}
        ref={(el) => {
          if (el) {
            (el as EpubControlsElement).__epubControls = {
              goNext, goPrev,
              showSearch: () => search.setShowSearch(true),
              showNotes: () => setShowNotes(true),
              showStats: () => stats.setShowStats(true),
              showTypography: () => setShowTypography(true),
              toggleSearch: () => search.setShowSearch(p => !p),
              toggleNotes: () => setShowNotes(p => !p),
              toggleStats: () => stats.setShowStats(p => !p),
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

export function getEpubControls(container: HTMLElement | null) {
  if (!container) return null
  const el = container.querySelector('[data-epub-controls]') as EpubControlsElement | null
  return el?.__epubControls || null
}
