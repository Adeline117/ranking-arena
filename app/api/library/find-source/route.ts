import { NextRequest, NextResponse } from 'next/server'

/**
 * Search multiple free book sources for a readable version
 * Returns the best available source URL for reading
 */

interface BookSource {
  source: string
  url: string
  format: 'epub' | 'pdf' | 'html' | 'read_online'
  quality: number // 1-10, higher is better
}

async function searchGutenberg(title: string, author: string | null): Promise<BookSource | null> {
  try {
    const query = encodeURIComponent(`${title} ${author || ''}`.trim())
    const res = await fetch(`https://gutendex.com/books/?search=${query}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()

    const normalize = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const titleNorm = normalize(title)

    for (const book of (data.results || [])) {
      const bookTitle = normalize(book.title)
      if (bookTitle.includes(titleNorm) || titleNorm.includes(bookTitle)) {
        const epub = book.formats['application/epub+zip']
        const html = book.formats['text/html']
        if (epub) return { source: 'gutenberg', url: epub, format: 'epub', quality: 9 }
        if (html) return { source: 'gutenberg', url: html, format: 'html', quality: 7 }
      }
    }
    return null
  } catch {
    return null
  }
}

async function searchOpenLibrary(title: string, author: string | null): Promise<BookSource | null> {
  try {
    const query = encodeURIComponent(title)
    const res = await fetch(`https://openlibrary.org/search.json?q=${query}&limit=5&fields=key,title,author_name,ia,availability`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()

    for (const doc of (data.docs || [])) {
      const ia = doc.ia?.[0]
      if (ia) {
        // Internet Archive has this book — link to their online reader
        return {
          source: 'archive.org',
          url: `https://archive.org/details/${ia}`,
          format: 'read_online',
          quality: 6,
        }
      }
    }
    return null
  } catch {
    return null
  }
}

async function searchStandardEbooks(title: string): Promise<BookSource | null> {
  try {
    // Standard Ebooks uses URL slugs
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const res = await fetch(`https://standardebooks.org/ebooks?query=${encodeURIComponent(title)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'ArenaFi/1.0' },
    })
    if (!res.ok) return null
    const html = await res.text()

    // Simple check if any results found
    const match = html.match(/href="(\/ebooks\/[^"]+)"/i)
    if (match) {
      return {
        source: 'standard_ebooks',
        url: `https://standardebooks.org${match[1]}`,
        format: 'epub',
        quality: 10, // Best quality formatting
      }
    }
    return null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('id')

  if (!itemId) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  }

  // Get book info from DB
  const { getSupabaseAdmin } = await import('@/lib/admin/auth')
  const supabase = getSupabaseAdmin()

  const { data: book } = await supabase
    .from('library_items')
    .select('id, title, author, isbn, epub_url, pdf_url, file_key, source_url')
    .eq('id', itemId)
    .maybeSingle()

  if (!book) {
    return NextResponse.json({ error: 'Book not found' }, { status: 404 })
  }

  // Already has a file
  if (book.epub_url || book.pdf_url || book.file_key) {
    return NextResponse.json({
      available: true,
      sources: [{
        source: 'local',
        url: book.epub_url || book.pdf_url || '',
        format: book.epub_url ? 'epub' : 'pdf',
        quality: 10,
      }],
    })
  }

  // Search all sources in parallel
  const results = await Promise.allSettled([
    searchGutenberg(book.title, book.author),
    searchOpenLibrary(book.title, book.author),
    searchStandardEbooks(book.title),
  ])

  const sources: BookSource[] = results
    .filter((r): r is PromiseFulfilledResult<BookSource | null> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value!)
    .sort((a, b) => b.quality - a.quality)

  return NextResponse.json({
    available: sources.length > 0,
    sources,
  }, {
    headers: { 'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400' },
  })
}
