'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type HighlightSortMode = 'time' | 'position'
type HighlightFilterColor = string | 'all'

export type EpubHighlight = {
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

const HIGHLIGHT_COLORS = [
  'var(--color-chart-yellow)',
  'var(--color-chart-blue)',
  'var(--color-accent-success-20)',
  'var(--color-accent-error)',
  'var(--color-chart-pink)',
]

// ─── Search Panel ────────────────────────────────────────────────────

interface EpubSearchPanelProps {
  show: boolean
  onClose: () => void
  panelBg: string
  panelText: string
  panelBorder: string
  panelSubtle: string
  accent: string
  searchQuery: string
  onSearchQueryChange: (q: string) => void
  onSearch: () => void
  searching: boolean
  searchResults: SearchResult[]
  onJumpTo: (cfi: string) => void
}

export function EpubSearchPanel({
  show, onClose,
  panelBg, panelText, panelBorder, panelSubtle, accent,
  searchQuery, onSearchQueryChange, onSearch, searching, searchResults, onJumpTo,
}: EpubSearchPanelProps) {
  const { t } = useLanguage()
  if (!show) return null

  return (
    <>
      <div onClick={onClose}
        role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
      <div role="dialog" aria-modal="true" aria-label={t('search')} style={{
        position: 'fixed', top: 60, right: 12, width: 380, maxWidth: '90vw', maxHeight: '70vh',
        background: panelBg, color: panelText, borderRadius: tokens.radius.xl, zIndex: 301,
        boxShadow: 'var(--shadow-lg-dark)', border: `1px solid ${panelBorder}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${panelBorder}` }}>
          <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            {t('search')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={searchQuery}
              onChange={e => onSearchQueryChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onSearch() }}
              placeholder={t('epubEnterKeyword')}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: tokens.radius.md,
                border: `1px solid ${panelBorder}`,
                background: panelSubtle, color: panelText, fontSize: 13, outline: 'none',
              }}
              autoFocus
            />
            <button onClick={onSearch} disabled={searching} style={{
              padding: '8px 16px', borderRadius: tokens.radius.md, border: 'none',
              background: accent, color: 'var(--foreground)',
              cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
              opacity: searching ? 0.6 : 1,
            }}>
              {searching ? (t('epubSearching')) : (t('search'))}
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {searchResults.length === 0 && !searching && searchQuery && (
            <p style={{ padding: '20px', fontSize: 13, opacity: 0.4, textAlign: 'center' }}>
              {t('noResultsFound')}
            </p>
          )}
          {searchResults.map((r, i) => (
            <button key={i} onClick={() => { onJumpTo(r.cfi); onClose() }} style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px',
              border: 'none', background: 'transparent', color: panelText,
              cursor: 'pointer', fontSize: 13, lineHeight: 1.5,
              borderBottom: `1px solid ${panelBorder}`, transition: 'background 0.15s',
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
  )
}

// ─── Notes / Highlights Panel ────────────────────────────────────────

interface EpubNotesPanelProps {
  show: boolean
  onClose: () => void
  panelBg: string
  panelText: string
  panelBorder: string
  panelSubtle: string
  accent: string
  highlights: EpubHighlight[]
  highlightSort: HighlightSortMode
  highlightFilter: HighlightFilterColor
  filteredHighlights: EpubHighlight[]
  editingNoteIdx: number | null
  editNoteText: string
  onHighlightSortChange: (mode: HighlightSortMode) => void
  onHighlightFilterChange: (color: HighlightFilterColor) => void
  onJumpToHighlight: (cfiRange: string) => void
  onRemoveHighlight: (index: number) => void
  onStartEditNote: (index: number, currentNote: string) => void
  onSaveNote: (index: number, note: string) => void
  onCancelEditNote: () => void
  onEditNoteTextChange: (text: string) => void
}

export function EpubNotesPanel({
  show, onClose, _isZh,
  panelBg, panelText, panelBorder, panelSubtle, accent,
  highlights, highlightSort, highlightFilter, filteredHighlights,
  editingNoteIdx, editNoteText,
  onHighlightSortChange, onHighlightFilterChange,
  onJumpToHighlight, onRemoveHighlight,
  onStartEditNote, onSaveNote, onCancelEditNote, onEditNoteTextChange,
}: EpubNotesPanelProps) {
  const { t } = useLanguage()
  if (!show) return null

  return (
    <>
      <div onClick={onClose}
        role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
      <div role="dialog" aria-modal="true" aria-label={t('notesHighlights')} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 380, maxWidth: '85vw', zIndex: 301,
        background: panelBg, color: panelText, boxShadow: '-4px 0 24px var(--color-overlay-medium)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 16px 12px', borderBottom: `1px solid ${panelBorder}`,
        }}>
          <div>
            <span style={{ fontSize: 16, fontWeight: 700 }}>
              {t('epubHighlightsNotes')}
            </span>
            <span style={{ fontSize: 12, opacity: 0.4, marginLeft: 8 }}>
              {highlights.length}{isZh ? ' 条' : ''}
            </span>
          </div>
          <button aria-label="Close notes panel" onClick={onClose} style={{
            background: 'none', border: 'none', color: panelText, cursor: 'pointer', padding: 4, opacity: 0.5,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Filters & Sort */}
        {highlights.length > 0 && (
          <div style={{
            padding: '10px 16px', borderBottom: `1px solid ${panelBorder}`,
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <button onClick={() => onHighlightFilterChange('all')} style={{
              width: 20, height: 20, borderRadius: '50%', border: `2px solid ${panelBorder}`,
              background: 'linear-gradient(135deg, #FFEB3B 25%, #81D4FA 25%, #81D4FA 50%, #A5D6A7 50%, #A5D6A7 75%, #CE93D8 75%)',
              cursor: 'pointer', outline: highlightFilter === 'all' ? `2px solid ${panelText}` : 'none',
              outlineOffset: 2, flexShrink: 0,
            }} />
            {HIGHLIGHT_COLORS.map(c => (
              <button key={c} onClick={() => onHighlightFilterChange(c)} style={{
                width: 20, height: 20, borderRadius: '50%', background: c, border: 'none',
                cursor: 'pointer', outline: highlightFilter === c ? `2px solid ${panelText}` : 'none',
                outlineOffset: 2, flexShrink: 0,
              }} />
            ))}
            <div style={{ flex: 1 }} />
            <select value={highlightSort} onChange={e => onHighlightSortChange(e.target.value as HighlightSortMode)} style={{
              padding: '4px 8px', borderRadius: tokens.radius.sm, border: `1px solid ${panelBorder}`,
              background: panelSubtle, color: panelText, fontSize: 11, outline: 'none',
            }}>
              <option value="time">{t('epubByTime')}</option>
              <option value="position">{t('epubByPosition')}</option>
            </select>
          </div>
        )}

        {/* Highlights list */}
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {highlights.length === 0 && (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.15, margin: '0 auto 12px', display: 'block' }}>
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <p style={{ fontSize: 13, opacity: 0.35, lineHeight: 1.6 }}>
                {isZh ? '暂无高亮或笔记。\n选中文字即可添加。' : 'No highlights yet.\nSelect text to add.'}
              </p>
            </div>
          )}
          {filteredHighlights.map((h) => {
            const realIdx = highlights.indexOf(h)
            return (
              <div key={realIdx} style={{
                padding: '14px 16px', borderBottom: `1px solid ${panelBorder}`,
                cursor: 'pointer', transition: 'background 0.15s',
              }}
                onClick={() => { onJumpToHighlight(h.cfiRange); onClose() }}
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
                      onChange={e => onEditNoteTextChange(e.target.value)}
                      style={{
                        width: '100%', minHeight: 48, padding: '6px 10px', borderRadius: tokens.radius.sm,
                        border: `1px solid ${panelBorder}`, background: panelSubtle,
                        color: panelText, fontSize: 12, resize: 'vertical', outline: 'none',
                        fontFamily: 'inherit',
                      }}
                      autoFocus
                    />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button onClick={e => { e.stopPropagation(); onSaveNote(realIdx, editNoteText) }} style={{
                        padding: '4px 12px', borderRadius: tokens.radius.sm, border: 'none',
                        background: accent, color: 'var(--foreground)', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                      }}>{t('save')}</button>
                      <button onClick={e => { e.stopPropagation(); onCancelEditNote() }} style={{
                        padding: '4px 12px', borderRadius: tokens.radius.sm, border: `1px solid ${panelBorder}`,
                        background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 11,
                      }}>{t('cancel')}</button>
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
                    <button onClick={e => { e.stopPropagation(); onStartEditNote(realIdx, h.note) }} style={{
                      background: 'none', border: 'none', color: panelText, cursor: 'pointer',
                      fontSize: 11, opacity: 0.35, padding: '2px 4px',
                    }}>
                      {t('edit')}
                    </button>
                    <button onClick={e => { e.stopPropagation(); onRemoveHighlight(realIdx) }} style={{
                      background: 'none', border: 'none', color: 'var(--color-accent-error)', cursor: 'pointer',
                      fontSize: 11, opacity: 0.5, padding: '2px 4px',
                    }}>
                      {t('delete')}
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
              width: '100%', padding: '8px', borderRadius: tokens.radius.md, border: `1px solid ${panelBorder}`,
              background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 12,
              opacity: 0.6, transition: 'opacity 0.15s',
            }}
              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
              onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
            >
              {t('epubCopyAllNotes')}
            </button>
          </div>
        )}
      </div>
    </>
  )
}

// ─── Stats Panel ─────────────────────────────────────────────────────

interface EpubStatsPanelProps {
  show: boolean
  onClose: () => void
  isZh: boolean
  panelBg: string
  panelText: string
  panelBorder: string
  panelSubtle: string
  accent: string
  progressPercent: number
  currentPage: number
  totalPages: number
  sessionElapsedSec: number
  totalSessionTime: number
  sessionsCount: number
  timeRemainingStr: string
}

function StatCard({ label, value, themeIsDark }: { label: string; value: string; themeIsDark: boolean }) {
  return (
    <div style={{
      padding: '14px 12px', borderRadius: tokens.radius.lg,
      background: themeIsDark ? 'var(--overlay-hover)' : 'var(--overlay-hover)',
      textAlign: 'center',
    }}>
      <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{value}</p>
      <p style={{ fontSize: 11, opacity: 0.4 }}>{label}</p>
    </div>
  )
}

function formatDur(seconds: number, isZh: boolean): string {
  if (seconds < 60) return isZh ? `${seconds}秒` : `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return isZh ? `${m}分钟` : `${m}min`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return isZh ? `${h}小时${rm > 0 ? rm + '分钟' : ''}` : `${h}h ${rm > 0 ? rm + 'm' : ''}`
}

export function EpubStatsPanel({
  show, onClose, _isZh,
  panelBg, panelText, panelBorder, panelSubtle,
  accent, progressPercent, currentPage, totalPages,
  sessionElapsedSec, totalSessionTime, sessionsCount, timeRemainingStr,
}: EpubStatsPanelProps) {
  const { t } = useLanguage()
  if (!show) return null

  const themeIsDark = panelBg.includes('secondary') // rough detection

  return (
    <>
      <div onClick={onClose}
        role="presentation"
        style={{ position: 'fixed', inset: 0, background: 'var(--color-backdrop-light)', zIndex: 300 }} />
      <div role="dialog" aria-modal="true" aria-label={t('epubReadingStats')} style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: panelBg, color: panelText, borderRadius: tokens.radius['2xl'], padding: '28px 32px',
        width: 360, maxWidth: '90vw', zIndex: 301, boxShadow: 'var(--shadow-elevated)',
        border: `1px solid ${panelBorder}`,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, textAlign: 'center' }}>
          {t('epubReadingStats')}
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <StatCard label={t('epubProgress')} value={`${progressPercent}%`} themeIsDark={themeIsDark} />
          <StatCard label={t('epubCurrentPage')} value={`${currentPage}/${totalPages}`} themeIsDark={themeIsDark} />
          <StatCard label={t('epubThisSession')} value={formatDur(sessionElapsedSec, isZh)} themeIsDark={themeIsDark} />
          <StatCard label={t('epubTotalTime')} value={formatDur(totalSessionTime, isZh)} themeIsDark={themeIsDark} />
          <StatCard label={t('epubSessions')} value={`${sessionsCount}`} themeIsDark={themeIsDark} />
          <StatCard label={t('epubRemaining')} value={timeRemainingStr} themeIsDark={themeIsDark} />
        </div>

        {/* Progress bar */}
        <div style={{ marginTop: 20 }}>
          <div style={{ height: 6, borderRadius: 3, background: panelSubtle, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3, width: `${progressPercent}%`,
              background: accent, transition: 'width 0.3s ease',
            }} />
          </div>
        </div>

        <button onClick={onClose} style={{
          display: 'block', width: '100%', marginTop: 20, padding: '10px',
          borderRadius: tokens.radius.md, border: `1px solid ${panelBorder}`,
          background: 'transparent', color: panelText, cursor: 'pointer', fontSize: 13,
        }}>
          {t('close')}
        </button>
      </div>
    </>
  )
}
