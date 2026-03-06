import { supabase } from '@/lib/supabase/client'
import type { BookInfo, ContentMode, FontSize, HtmlChapter } from './types'
import { LS_PREFIX, CHARS_PER_PAGE_BASE } from './types'

// ─── LocalStorage Helpers ─────────────────────────────────────────────

export function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const v = localStorage.getItem(LS_PREFIX + key)
    return v ? JSON.parse(v) : fallback
  } catch { return fallback }
}

export function lsSet(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)) } catch { /* intentionally empty */ }
}

// ─── Server Progress Sync ─────────────────────────────────────────────

export async function syncProgressToServer(bookId: string, page: number, totalPages: number) {
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

export async function loadProgressFromServer(bookId: string): Promise<{ page: number; total: number } | null> {
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

// ─── Content Detection ────────────────────────────────────────────────

export function detectContentMode(book: BookInfo): ContentMode {
  if (book.epub_url) return 'epub'
  if (book.pdf_url) return 'pdf'
  if (book.file_key) {
    if (book.file_key.endsWith('.epub')) return 'epub'
    return 'pdf'
  }
  if (book.content_url?.endsWith('.pdf') || book.content_url?.includes('cdn.arenafi.org/papers/')) return 'pdf'
  return 'none'
}

// ─── HTML Parsing ─────────────────────────────────────────────────────

export function parseHtmlIntoChapters(html: string): HtmlChapter[] {
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

export function paginateText(text: string, fontSize: FontSize): string[] {
  const charsPerPage = fontSize === 'small' ? 1600 : fontSize === 'large' ? 800 : CHARS_PER_PAGE_BASE
  const pages: string[] = []

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
