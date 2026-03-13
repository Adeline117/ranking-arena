import { useState, useEffect, useRef } from 'react'
import { type ReadingStats, lsGet, lsSet, syncReadingStatsToServer } from './EpubReaderUtils'

export function useEpubReadingStats(bookId: string) {
  const [readingStats, setReadingStats] = useState<ReadingStats>(() => {
    const saved = lsGet<ReadingStats | null>(`epub_stats_${bookId}`, null)
    return saved || {
      sessionStartTime: Date.now(),
      totalReadingTimeSec: 0,
      pagesRead: 0,
      sessionsCount: 0,
      avgSpeedCharsPerMin: 0,
    }
  })
  const [sessionElapsedSec, setSessionElapsedSec] = useState(0)
  const sessionStartRef = useRef(Date.now())
  const lastActiveRef = useRef(Date.now())
  const [showStats, setShowStats] = useState(false)

  // Persist stats
  useEffect(() => {
    lsSet(`epub_stats_${bookId}`, readingStats)
  }, [readingStats, bookId])

  // Session timer
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      if (now - lastActiveRef.current < 60000) {
        setSessionElapsedSec(Math.floor((now - sessionStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Track activity
  useEffect(() => {
    const markActive = () => { lastActiveRef.current = Date.now() }
    window.addEventListener('mousemove', markActive)
    window.addEventListener('keydown', markActive)
    window.addEventListener('touchstart', markActive)
    return () => {
      window.removeEventListener('mousemove', markActive)
      window.removeEventListener('keydown', markActive)
      window.removeEventListener('touchstart', markActive)
    }
  }, [])

  // Update stats on session end
  useEffect(() => {
    const handleUnload = () => {
      const updatedStats = {
        ...readingStats,
        totalReadingTimeSec: readingStats.totalReadingTimeSec + sessionElapsedSec,
        sessionsCount: readingStats.sessionsCount + 1,
        sessionStartTime: Date.now(),
      }
      lsSet(`epub_stats_${bookId}`, updatedStats)
      syncReadingStatsToServer(bookId, updatedStats)
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [bookId, readingStats, sessionElapsedSec])

  const incrementSession = () => {
    setReadingStats(prev => ({
      ...prev,
      sessionsCount: prev.sessionsCount + 1,
      sessionStartTime: Date.now(),
    }))
  }

  const updatePagesRead = (page: number) => {
    setReadingStats(prev => ({ ...prev, pagesRead: Math.max(prev.pagesRead, page) }))
  }

  return {
    readingStats,
    sessionElapsedSec,
    showStats,
    setShowStats,
    incrementSession,
    updatePagesRead,
  }
}
