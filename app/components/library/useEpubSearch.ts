import { useState, useCallback } from 'react'
import type { Book } from 'epubjs'
import { type EpubSpine, type SearchResult } from './EpubReaderUtils'

export function useEpubSearch(bookRef: React.RefObject<Book | null>) {
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

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
  }, [searchQuery, bookRef])

  return {
    showSearch,
    setShowSearch,
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    doSearch,
  }
}
