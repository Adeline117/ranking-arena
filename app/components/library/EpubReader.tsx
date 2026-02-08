'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Rendition, Book, NavItem, Contents } from 'epubjs'

// ─── Types ───────────────────────────────────────────────────────────

type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
type FontSize = 'small' | 'medium' | 'large'
type FontFamily = 'sans' | 'serif'

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
}

// ─── Constants ───────────────────────────────────────────────────────

const THEME_STYLES: Record<ReadingTheme, { body: Record<string, string> }> = {
  white: { body: { background: '#FFFFFF', color: '#1a1a1a' } },
  sepia: { body: { background: '#F4ECD8', color: '#5b4636' } },
  dark:  { body: { background: '#1a1a2e', color: '#d4d4d8' } },
  green: { body: { background: '#C7EDCC', color: '#2d4a32' } },
}

const FONT_SIZE_MAP: Record<FontSize, number> = { small: 90, medium: 100, large: 120 }

const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif',
  serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
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
}: EpubReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [ready, setReady] = useState(false)

  // Highlights & notes
  const [highlights, setHighlights] = useState<EpubHighlight[]>(() =>
    lsGet(`epub_highlights_${bookId}`, [])
  )
  const [showNoteInput, setShowNoteInput] = useState(false)
  const [pendingHighlight, setPendingHighlight] = useState<{ cfiRange: string; text: string } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0])

  // Search
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Notes panel
  const [showNotes, setShowNotes] = useState(false)

  // Persist highlights
  useEffect(() => {
    lsSet(`epub_highlights_${bookId}`, highlights)
  }, [highlights, bookId])

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
      applyTheme(rendition, theme, fontSize, fontFamily)

      // Load saved position
      const savedLocation = lsGet<string | null>(`epub_location_${bookId}`, null)
      if (savedLocation) {
        rendition.display(savedLocation)
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
        if (cfi) lsSet(`epub_location_${bookId}`, cfi)

        if (onProgressChange && location.start) {
          const percent = book.locations?.percentageFromCfi?.(cfi)
          if (typeof percent === 'number') {
            onProgressChange(Math.round(percent * 100), location.start.displayed?.page || 1, location.start.displayed?.total || 1)
          }
        }
      })

      // Generate locations for progress
      book.ready.then(() => {
        if (cancelled) return
        return book.locations.generate(1024)
      }).then(() => {
        if (cancelled) return
        setReady(true)
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
  function applyTheme(rendition: Rendition, t: ReadingTheme, fs: FontSize, ff: FontFamily) {
    const styles = THEME_STYLES[t]
    rendition.themes.default({
      body: {
        ...styles.body,
        'font-family': FONT_FAMILY_MAP[ff] + ' !important',
        'font-size': FONT_SIZE_MAP[fs] + '% !important',
        'line-height': '1.8 !important',
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
      applyTheme(renditionRef.current, theme, fontSize, fontFamily)
    }
  }, [theme, fontSize, fontFamily, ready])

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
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext() }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev() }
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

      // Iterate through spine items
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
            // Generate a rough CFI
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

  // ─── Render ────────────────────────────────────────────────────

  const themeIsDark = theme === 'dark'
  const panelBg = themeIsDark ? '#1e1e36' : '#fff'
  const panelText = themeIsDark ? '#d4d4d8' : '#1a1a1a'
  const panelBorder = themeIsDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

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
            borderTopColor: 'var(--color-accent-primary, #6366f1)', borderRadius: '50%',
            animation: 'epubSpin 0.8s linear infinite',
          }} />
          <span style={{ fontSize: 13, color: panelText, opacity: 0.5 }}>
            {isZh ? '正在加载...' : 'Loading...'}
          </span>
        </div>
      )}

      {/* Note input modal */}
      {showNoteInput && pendingHighlight && (
        <>
          <div onClick={() => { setShowNoteInput(false); setPendingHighlight(null) }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            background: panelBg, color: panelText, borderRadius: 16, padding: '24px 28px',
            width: 340, maxWidth: '90vw', zIndex: 301, boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
            border: `1px solid ${panelBorder}`,
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>
              {isZh ? '添加高亮和笔记' : 'Add Highlight & Note'}
            </h3>
            <p style={{
              fontSize: 13, lineHeight: 1.6, marginBottom: 12, padding: '8px 12px',
              background: themeIsDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
              borderRadius: 8, borderLeft: `3px solid ${highlightColor}`,
              maxHeight: 80, overflow: 'auto',
            }}>
              {pendingHighlight.text.slice(0, 200)}{pendingHighlight.text.length > 200 ? '...' : ''}
            </p>

            {/* Color picker */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {HIGHLIGHT_COLORS.map(c => (
                <button key={c} onClick={() => setHighlightColor(c)} style={{
                  width: 24, height: 24, borderRadius: '50%', background: c, border: 'none',
                  cursor: 'pointer',
                  outline: highlightColor === c ? `2px solid ${panelText}` : 'none',
                  outlineOffset: 2,
                }} />
              ))}
            </div>

            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder={isZh ? '添加笔记（可选）...' : 'Add a note (optional)...'}
              style={{
                width: '100%', minHeight: 60, padding: '8px 12px', borderRadius: 8,
                border: `1px solid ${panelBorder}`, background: themeIsDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                color: panelText, fontSize: 13, resize: 'vertical', outline: 'none',
                fontFamily: 'inherit',
              }}
            />

            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowNoteInput(false); setPendingHighlight(null) }} style={{
                padding: '7px 16px', borderRadius: 8, border: `1px solid ${panelBorder}`,
                background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 13,
              }}>
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button onClick={confirmHighlight} style={{
                padding: '7px 16px', borderRadius: 8, border: 'none',
                background: 'var(--color-accent-primary, #6366f1)', color: '#fff',
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
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div style={{
            position: 'fixed', top: 60, right: 12, width: 340, maxWidth: '90vw', maxHeight: '70vh',
            background: panelBg, color: panelText, borderRadius: 16, zIndex: 301,
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)', border: `1px solid ${panelBorder}`,
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
                    flex: 1, padding: '7px 12px', borderRadius: 8,
                    border: `1px solid ${panelBorder}`,
                    background: themeIsDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                    color: panelText, fontSize: 13, outline: 'none',
                  }}
                  autoFocus
                />
                <button onClick={doSearch} disabled={searching} style={{
                  padding: '7px 14px', borderRadius: 8, border: 'none',
                  background: 'var(--color-accent-primary, #6366f1)', color: '#fff',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                }}>
                  {searching ? (isZh ? '搜索中...' : 'Searching...') : (isZh ? '搜索' : 'Search')}
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
              {searchResults.length === 0 && !searching && searchQuery && (
                <p style={{ padding: '16px', fontSize: 13, opacity: 0.5, textAlign: 'center' }}>
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
                }}
                  onMouseEnter={e => e.currentTarget.style.background = themeIsDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {r.excerpt}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Notes/Highlights panel */}
      {showNotes && (
        <>
          <div onClick={() => setShowNotes(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 340, maxWidth: '85vw', zIndex: 301,
            background: panelBg, color: panelText, boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 16px', borderBottom: `1px solid ${panelBorder}`,
            }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>
                {isZh ? '高亮和笔记' : 'Highlights & Notes'}
              </span>
              <button onClick={() => setShowNotes(false)} style={{
                background: 'none', border: 'none', color: panelText, cursor: 'pointer', padding: 4, opacity: 0.5,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
              {highlights.length === 0 && (
                <p style={{ padding: 20, fontSize: 13, opacity: 0.4, textAlign: 'center' }}>
                  {isZh ? '暂无高亮或笔记。选中文字即可添加。' : 'No highlights or notes yet. Select text to add.'}
                </p>
              )}
              {highlights.map((h, i) => (
                <div key={i} style={{
                  padding: '12px 16px', borderBottom: `1px solid ${panelBorder}`,
                  cursor: 'pointer',
                }} onClick={() => {
                  renditionRef.current?.display(h.cfiRange)
                  setShowNotes(false)
                }}>
                  <p style={{
                    fontSize: 13, lineHeight: 1.6, marginBottom: h.note ? 6 : 0,
                    borderLeft: `3px solid ${h.color}`, paddingLeft: 10,
                  }}>
                    {h.text.slice(0, 150)}{h.text.length > 150 ? '...' : ''}
                  </p>
                  {h.note && (
                    <p style={{ fontSize: 12, opacity: 0.6, paddingLeft: 13, fontStyle: 'italic' }}>
                      {h.note}
                    </p>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingLeft: 13 }}>
                    <span style={{ fontSize: 11, opacity: 0.3 }}>
                      {new Date(h.createdAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); removeHighlight(i) }} style={{
                      background: 'none', border: 'none', color: panelText, cursor: 'pointer',
                      fontSize: 11, opacity: 0.4, padding: '2px 6px',
                    }}>
                      {isZh ? '删除' : 'Delete'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Expose controls via imperative handle-like pattern using data attributes */}
      <div data-epub-controls="true" style={{ display: 'none' }}
        ref={(el) => {
          if (el) {
            (el as any).__epubControls = {
              goNext, goPrev, showSearch: () => setShowSearch(true),
              showNotes: () => setShowNotes(true),
              toggleSearch: () => setShowSearch(p => !p),
              toggleNotes: () => setShowNotes(p => !p),
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
  const el = container.querySelector('[data-epub-controls]') as any
  return el?.__epubControls || null
}
