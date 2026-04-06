'use client'

import { useState, useCallback, useEffect } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { isChineseText } from '../types'
import type { Post } from './useGroupPosts'

interface UsePostTranslationOptions {
  posts: Post[]
  language: string
  translatingEnabled?: boolean
  accessToken?: string | null
}

export function usePostTranslation({ posts, language, translatingEnabled = true, accessToken }: UsePostTranslationOptions) {
  const [translatedPosts, setTranslatedPosts] = useState<Record<string, { title?: string; content?: string }>>({})
  const [translatingPosts, setTranslatingPosts] = useState(false)

  // sessionStorage cache helpers
  const getTranslationCache = useCallback((postId: string, lang: string): { title?: string; content?: string } | null => {
    try {
      const key = `trans:${postId}:${lang}`
      const cached = sessionStorage.getItem(key)
      return cached ? JSON.parse(cached) : null
    } catch { return null }
  }, [])

  const setTranslationCache = useCallback((postId: string, lang: string, value: { title?: string; content?: string }) => {
    try {
      const key = `trans:${postId}:${lang}`
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch { /* storage full, ignore */ }
  }, [])

  // Batch translate posts (with sessionStorage cache)
  const translatePosts = useCallback(async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
    if (translatingPosts) return
    setTranslatingPosts(true)

    // Check cache first
    const cachedResults: Record<string, { title?: string; content?: string }> = {}
    const needsTranslation = postsToTranslate.filter(p => {
      if (translatedPosts[p.id]?.title) return false
      if (!p.title) return false
      const titleIsChinese = isChineseText(p.title)
      const needsIt = targetLang === 'en' ? titleIsChinese : !titleIsChinese
      if (!needsIt) return false
      // Check sessionStorage cache
      const cached = getTranslationCache(p.id, targetLang)
      if (cached) { cachedResults[p.id] = cached; return false }
      return true
    })

    // Apply cached results
    if (Object.keys(cachedResults).length > 0) {
      setTranslatedPosts(prev => ({ ...prev, ...cachedResults }))
    }

    if (needsTranslation.length === 0) {
      setTranslatingPosts(false)
      return
    }

    if (!accessToken) {
      setTranslatingPosts(false)
      return
    }

    try {
      const items: Array<{id: string; text: string; contentType: 'post_title' | 'post_content'; contentId: string}> = []
      needsTranslation.slice(0, 10).forEach(post => {
        if (post.title) items.push({ id: `${post.id}-title`, text: post.title, contentType: 'post_title', contentId: post.id })
        if (post.content) items.push({ id: `${post.id}-content`, text: post.content, contentType: 'post_content', contentId: post.id })
      })

      if (items.length === 0) {
        setTranslatingPosts(false)
        return
      }

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ items, targetLang }),
      })

      if (!response.ok) {
        logger.warn('Translation API failed:', response.status)
        setTranslatingPosts(false)
        return
      }

      const data = await response.json()
      if (data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        setTranslatedPosts(prev => {
          const updated = { ...prev }
          needsTranslation.forEach(post => {
            const translated = {
              title: results[`${post.id}-title`]?.translatedText || post.title || '',
              content: results[`${post.id}-content`]?.translatedText || post.content || '',
            }
            updated[post.id] = translated
            // Cache in sessionStorage
            setTranslationCache(post.id, targetLang, translated)
          })
          return updated
        })
      }
    } catch (error) {
      logger.warn('Translation failed:', error)
    } finally {
      setTranslatingPosts(false)
    }
  }, [translatingPosts, translatedPosts, getTranslationCache, setTranslationCache, accessToken])

  // Trigger translation when posts change
  useEffect(() => {
    if (translatingEnabled && posts.length > 0 && !translatingPosts) {
      translatePosts(posts, language as 'zh' | 'en')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- translatePosts excluded to avoid infinite loop; only trigger on posts/language change
  }, [posts, language])

  return { translatedPosts, translatingPosts }
}
