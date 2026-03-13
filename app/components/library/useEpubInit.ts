import { useEffect, useRef } from 'react'
import type { Rendition, Book, Contents } from 'epubjs'
import type { EpubHighlight } from './EpubNavigation'
import {
  type ReadingTheme,
  type FontSize,
  type FontFamily,
  type LineHeight,
  type PageMargin,
  type EpubContentsEntry,
  lsGet,
  lsSet,
  syncEpubPositionToServer,
  loadEpubPositionFromServer,
  applyTheme,
} from './EpubReaderUtils'

interface EpubInitCallbacks {
  onProgressUpdate: (percent: number, page: number, total: number) => void
  onPageTextUpdate: (text: string) => void
  onTextSelected: (cfiRange: string, text: string) => void
  onSessionReady: () => void
  onReady?: () => void
  onTocLoaded?: (toc: import('epubjs').NavItem[]) => void
  onProgressChange?: (percent: number, currentPage: number, totalPages: number) => void
}

interface EpubInitConfig {
  url: string
  bookId: string
  theme: ReadingTheme
  fontSize: FontSize
  fontFamily: FontFamily
  lineHeight: LineHeight
  pageMargin: PageMargin
}

export function useEpubInit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  bookRef: React.MutableRefObject<Book | null>,
  renditionRef: React.MutableRefObject<Rendition | null>,
  config: EpubInitConfig,
  callbacks: EpubInitCallbacks,
) {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks

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

      let bookInput: string | ArrayBuffer = config.url
      try {
        const resp = await fetch(config.url)
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

      applyTheme(rendition, config.theme, config.fontSize, config.fontFamily, config.lineHeight, config.pageMargin)

      let startLocation: string | null = null
      const serverPos = await loadEpubPositionFromServer(config.bookId)
      if (serverPos?.cfi) {
        startLocation = serverPos.cfi
      } else {
        startLocation = lsGet<string | null>(`epub_location_${config.bookId}`, null)
      }

      if (startLocation) rendition.display(startLocation)
      else rendition.display()

      book.loaded.navigation.then((nav) => {
        if (!cancelled && callbacksRef.current.onTocLoaded) callbacksRef.current.onTocLoaded(nav.toc)
      }).catch(() => { /* Intentionally swallowed: TOC loading is non-critical for reading */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget

      rendition.on('relocated', (location: { start?: { cfi: string; displayed?: { page: number; total: number } }; end?: { cfi: string } }) => {
        if (cancelled) return
        const cfi = location.start?.cfi
        if (cfi) {
          lsSet(`epub_location_${config.bookId}`, cfi)

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

          callbacksRef.current.onProgressUpdate(p, page, total)
          if (callbacksRef.current.onProgressChange) callbacksRef.current.onProgressChange(p, page, total)

          try {
            const contents = rendition.getContents() as unknown as EpubContentsEntry[]
            if (contents && contents.length > 0) {
              const doc = contents[0]?.document || contents[0]?.content?.ownerDocument
              if (doc) {
                const body = doc.querySelector?.('body') || doc.body
                callbacksRef.current.onPageTextUpdate(body?.textContent?.trim() || '')
              }
            }
          } catch { /* empty */ }

          syncEpubPositionToServer(config.bookId, cfi, p, page, total)
        }
      })

      book.ready.then(() => {
        if (cancelled) return
        return book.locations.generate(1024)
      }).then(() => {
        if (cancelled) return
        const bookTotal = (book.locations as unknown as { total?: number }).total || 0
        if (bookTotal > 1) {
          if (callbacksRef.current.onProgressChange) {
            const cfi = (renditionRef.current?.currentLocation() as unknown as { start?: { cfi: string } })?.start?.cfi
            if (cfi) {
              const locIdx = (book.locations as unknown as { locationFromCfi?: (cfi: string) => number }).locationFromCfi?.(cfi) ?? 1
              callbacksRef.current.onProgressChange(Math.round((locIdx / bookTotal) * 100), locIdx, bookTotal)
            }
          }
          // Signal total pages via progress update
          callbacksRef.current.onProgressUpdate(-1, -1, bookTotal)
        }
        callbacksRef.current.onSessionReady()
        callbacksRef.current.onReady?.()
      }).catch(() => { /* Intentionally swallowed: location generation non-critical for reading */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget

      rendition.on('selected', (cfiRange: string, contents: Contents) => {
        if (cancelled) return
        const range = contents.range(cfiRange)
        const text = range?.toString() || ''
        callbacksRef.current.onTextSelected(cfiRange, text)
      })

      rendition.on('rendered', () => {
        const stored = lsGet<EpubHighlight[]>(`epub_highlights_${config.bookId}`, [])
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
  }, [config.url, config.bookId])
}
