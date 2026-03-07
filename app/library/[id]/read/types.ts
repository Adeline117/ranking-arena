// ─── Types ───────────────────────────────────────────────────────────

// pdfjs-dist types (stubbed - package removed, loaded from CDN at runtime)
export type PDFDocumentProxy = {
  numPages: number
  getPage(n: number): Promise<PDFPageProxy>
  getDestination(dest: string): Promise<any[] | null>
  getPageIndex(ref: unknown): Promise<number>
  destroy(): void
}
export type PDFPageProxy = {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }): PDFRenderTask
}
export type PDFRenderTask = { promise: Promise<void>; cancel(): void }

export interface EpubTocEntry {
  label: string
  href: string
  subitems?: EpubTocEntry[]
}

export type BookInfo = {
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

export type ReadingTheme = 'white' | 'sepia' | 'dark' | 'green'
export type FontSize = 'small' | 'medium' | 'large'
export type FontFamily = 'sans' | 'serif' | 'mono' | 'kai'
export type ContentMode = 'pdf' | 'html' | 'epub' | 'none'

export type TocItem = {
  title: string
  pageIndex: number
  level: number
  children?: TocItem[]
}

export type HtmlChapter = {
  title: string
  content: string
}

export interface PDFOutlineItem {
  title: string
  dest: string | unknown[] | null
  items?: PDFOutlineItem[]
}

// ─── Constants ───────────────────────────────────────────────────────

export const THEME_PRESETS: Record<ReadingTheme, {
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

export const FONT_SIZES: Record<FontSize, { body: number; heading: number; labelZh: string; label: string }> = {
  small:  { body: 15, heading: 22, labelZh: '小', label: 'S' },
  medium: { body: 18, heading: 26, labelZh: '中', label: 'M' },
  large:  { body: 22, heading: 32, labelZh: '大', label: 'L' },
}

export const FONT_FAMILIES: Record<FontFamily, { css: string; labelZh: string; label: string }> = {
  sans:  { css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif', labelZh: '黑体', label: 'Sans' },
  serif: { css: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif', labelZh: '宋体', label: 'Serif' },
  mono:  { css: '"SF Mono", "Fira Code", "Cascadia Code", Menlo, monospace', labelZh: '等宽', label: 'Mono' },
  kai:   { css: '"STKaiti", "KaiTi", "楷体", serif', labelZh: '楷体', label: 'Kai' },
}

export const LS_PREFIX = 'reader_'
export const CHARS_PER_PAGE_BASE = 1200 // approximate chars per page at medium font
