import type { NavItem } from 'epubjs'
import { t as moduleT } from '@/lib/i18n'
import { supabase } from '@/lib/supabase/client'

// ─── Types ───────────────────────────────────────────────────────────

export type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
export type FontSize = 'small' | 'medium' | 'large'
export type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'
export type LineHeight = 'compact' | 'normal' | 'relaxed'
export type PageMargin = 'narrow' | 'normal' | 'wide'

export interface EpubSpineItem {
  load: (loader: (path: string) => Promise<object>) => Promise<Document>
  cfiFromRange: (range: Range) => string
  href: string
  unload: () => void
}

export interface EpubSpine {
  items?: EpubSpineItem[]
  spineItems?: EpubSpineItem[]
}

export interface EpubContentsEntry {
  document?: Document
  content?: { ownerDocument?: Document }
}

export interface EpubControlsElement extends HTMLElement {
  __epubControls?: Record<string, () => void>
}

export type SearchResult = {
  cfi: string
  excerpt: string
}

export type ReadingStats = {
  sessionStartTime: number
  totalReadingTimeSec: number
  pagesRead: number
  sessionsCount: number
  avgSpeedCharsPerMin: number
}

export type HighlightSortMode = 'time' | 'position'
export type HighlightFilterColor = string | 'all'

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

export const THEME_STYLES: Record<ReadingTheme, { body: Record<string, string> }> = {
  white: { body: { background: 'var(--color-on-accent)', color: 'var(--color-text-primary)' } },
  sepia: { body: { background: 'var(--color-bg-secondary)', color: 'var(--color-bg-tertiary)' } },
  dark:  { body: { background: 'var(--color-bg-secondary)', color: 'var(--color-border-primary)' } },
  green: { body: { background: 'var(--color-accent-success-20)', color: 'var(--color-accent-success)' } },
}

export const FONT_SIZE_MAP: Record<FontSize, number> = { small: 90, medium: 100, large: 120 }

export const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif',
  serif: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
  mono: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
  kai: '"STKaiti", "KaiTi", "楷体", serif',
}

export const LINE_HEIGHT_MAP: Record<LineHeight, string> = {
  compact: '1.5',
  normal: '1.8',
  relaxed: '2.2',
}

export const PAGE_MARGIN_MAP: Record<PageMargin, string> = {
  narrow: '20px',
  normal: '48px',
  wide: '80px',
}

export const HIGHLIGHT_COLORS = ['var(--color-chart-yellow)', 'var(--color-chart-blue)', 'var(--color-accent-success-20)', 'var(--color-accent-error)', 'var(--color-chart-pink)']

// ─── LocalStorage helpers ────────────────────────────────────────────

const LS_PREFIX = 'reader_'

export function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const v = localStorage.getItem(LS_PREFIX + key)
    return v ? JSON.parse(v) : fallback
  } catch { return fallback }
}

export function lsSet(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)) } catch { /* empty */ }
}

// ─── Supabase sync helpers ───────────────────────────────────────────

export async function syncEpubPositionToServer(bookId: string, cfi: string, percent: number, page: number, totalPages: number) {
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

export async function loadEpubPositionFromServer(bookId: string): Promise<{ cfi: string; percent: number } | null> {
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

export async function syncReadingStatsToServer(bookId: string, stats: ReadingStats) {
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

// ─── Formatting helpers ──────────────────────────────────────────────

export function formatDuration(seconds: number): string {
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

export function estimateTimeRemaining(percent: number, elapsedSec: number): string {
  if (percent <= 0 || elapsedSec < 30) return moduleT('epubCalculating')
  const totalEstimate = elapsedSec / (percent / 100)
  const remaining = Math.max(0, totalEstimate - elapsedSec)
  return formatDuration(Math.round(remaining))
}

// ─── Theme application ──────────────────────────────────────────────

export function applyTheme(
  rendition: import('epubjs').Rendition,
  t: ReadingTheme,
  fs: FontSize,
  ff: FontFamily,
  lh: LineHeight,
  pm: PageMargin,
) {
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
