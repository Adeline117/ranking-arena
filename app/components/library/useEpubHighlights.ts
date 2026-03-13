import { useState, useCallback, useEffect } from 'react'
import type { Rendition } from 'epubjs'
import type { EpubHighlight } from './EpubNavigation'
import {
  type HighlightSortMode,
  type HighlightFilterColor,
  HIGHLIGHT_COLORS,
  lsGet,
  lsSet,
} from './EpubReaderUtils'

export function useEpubHighlights(bookId: string, renditionRef: React.RefObject<Rendition | null>) {
  const [highlights, setHighlights] = useState<EpubHighlight[]>(() =>
    lsGet(`epub_highlights_${bookId}`, [])
  )
  const [showNoteInput, setShowNoteInput] = useState(false)
  const [pendingHighlight, setPendingHighlight] = useState<{ cfiRange: string; text: string } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0])

  const [highlightSort, setHighlightSort] = useState<HighlightSortMode>('time')
  const [highlightFilter, setHighlightFilter] = useState<HighlightFilterColor>('all')
  const [editingNoteIdx, setEditingNoteIdx] = useState<number | null>(null)
  const [editNoteText, setEditNoteText] = useState('')

  // Persist highlights
  useEffect(() => {
    lsSet(`epub_highlights_${bookId}`, highlights)
  }, [highlights, bookId])

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
  }, [pendingHighlight, noteText, highlightColor, renditionRef])

  const removeHighlight = useCallback((index: number) => {
    const h = highlights[index]
    if (h && renditionRef.current) {
      renditionRef.current.annotations.remove(h.cfiRange, 'highlight')
    }
    setHighlights(prev => prev.filter((_, i) => i !== index))
  }, [highlights, renditionRef])

  const updateHighlightNote = useCallback((index: number, newNote: string) => {
    setHighlights(prev => prev.map((h, i) => i === index ? { ...h, note: newNote } : h))
    setEditingNoteIdx(null)
    setEditNoteText('')
  }, [])

  const cancelNoteInput = useCallback(() => {
    setShowNoteInput(false)
    setPendingHighlight(null)
  }, [])

  const onTextSelected = useCallback((cfiRange: string, text: string) => {
    if (text.trim()) {
      setPendingHighlight({ cfiRange, text: text.trim() })
      setShowNoteInput(true)
    }
  }, [])

  const filteredHighlights = highlights
    .filter(h => highlightFilter === 'all' || h.color === highlightFilter)
    .sort((a, b) => {
      if (highlightSort === 'time') return b.createdAt - a.createdAt
      return a.cfiRange.localeCompare(b.cfiRange)
    })

  return {
    highlights,
    showNoteInput,
    pendingHighlight,
    noteText,
    highlightColor,
    highlightSort,
    highlightFilter,
    editingNoteIdx,
    editNoteText,
    filteredHighlights,
    setNoteText,
    setHighlightColor,
    setHighlightSort,
    setHighlightFilter,
    setEditingNoteIdx,
    setEditNoteText,
    confirmHighlight,
    removeHighlight,
    updateHighlightNote,
    cancelNoteInput,
    onTextSelected,
  }
}
