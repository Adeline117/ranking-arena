/**
 * usePostTranslation Hook
 *
 * Manages post and comment translation functionality.
 * Extracted from PostFeed.tsx to improve maintainability.
 */

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'

export interface UsePostTranslationOptions {
  targetLanguage: 'zh' | 'en'
  accessToken: string | null
  onToast?: (message: string, type?: 'success' | 'error' | 'warning') => void
}

export interface UsePostTranslationReturn {
  // Single post translation
  translatedContent: string | null
  showingOriginal: boolean
  translating: boolean
  translatePost: (content: string, cacheKey: string) => Promise<void>
  toggleOriginal: () => void
  clearTranslation: () => void

  // Batch post translation (list)
  translatedListPosts: Record<string, { title?: string; body?: string }>
  translatingList: boolean
  translatePostList: (posts: Array<{ id: string; title?: string; body?: string }>) => Promise<void>

  // Comment translation
  translatedComments: Record<string, string>
  translatingComments: boolean
  translateComments: (comments: Array<{ id: string; body: string }>) => Promise<void>

  // Translation cache
  translationCache: Record<string, string>
}

export function usePostTranslation(options: UsePostTranslationOptions): UsePostTranslationReturn {
  const { targetLanguage, accessToken, onToast } = options

  // Single post translation state
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})

  // List translation state
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)

  // Comment translation state
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({})
  const [translatingComments, setTranslatingComments] = useState(false)

  // Helper: Remove image markdown from content (avoid translating image links)
  const removeImageMarkdown = useCallback((content: string): string => {
    return content.replace(/!\[.*?\]\(.*?\)/g, '')
  }, [])

  // Helper: Extract images from content
  const extractImages = useCallback((content: string): string[] => {
    const imageRegex = /!\[.*?\]\(.*?\)/g
    return content.match(imageRegex) || []
  }, [])

  // Translate single post content
  const translatePost = useCallback(async (content: string, cacheKey: string) => {
    if (!accessToken) {
      onToast?.('Please login to translate', 'warning')
      return
    }

    // Check cache
    if (translationCache[cacheKey]) {
      const images = extractImages(content)
      setTranslatedContent(translationCache[cacheKey] + '\n\n' + images.join('\n'))
      setShowingOriginal(false)
      return
    }

    setTranslating(true)

    try {
      // Remove images before translation
      const contentWithoutImages = removeImageMarkdown(content)

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          text: contentWithoutImages,
          target_lang: targetLanguage,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Translation failed')
      }

      const data = await response.json()
      const translated = data.translated_text || ''

      // Cache the translation
      setTranslationCache(prev => ({ ...prev, [cacheKey]: translated }))

      // Append original images back
      const images = extractImages(content)
      const finalTranslated = translated + (images.length > 0 ? '\n\n' + images.join('\n') : '')

      setTranslatedContent(finalTranslated)
      setShowingOriginal(false)
    } catch (err: any) {
      onToast?.(err.message || 'Translation failed', 'error')
    } finally {
      setTranslating(false)
    }
  }, [accessToken, targetLanguage, translationCache, onToast, removeImageMarkdown, extractImages])

  // Toggle between original and translated
  const toggleOriginal = useCallback(() => {
    setShowingOriginal(prev => !prev)
  }, [])

  // Clear translation
  const clearTranslation = useCallback(() => {
    setTranslatedContent(null)
    setShowingOriginal(true)
  }, [])

  // Translate post list (batch)
  const translatePostList = useCallback(async (
    posts: Array<{ id: string; title?: string; body?: string }>
  ) => {
    if (!accessToken || posts.length === 0) return

    setTranslatingList(true)

    try {
      // Prepare translation requests (max 10 posts)
      const requests: Array<{ text: string; key: string; type: 'title' | 'body'; postId: string }> = []

      for (const post of posts.slice(0, 10)) {
        if (post.title) {
          requests.push({
            text: post.title,
            key: `title_${post.id}`,
            type: 'title',
            postId: post.id,
          })
        }

        if (post.body) {
          // Translate preview (first 200 chars) to save API calls
          const preview = post.body.substring(0, 200)
          const previewWithoutImages = removeImageMarkdown(preview)

          if (previewWithoutImages.length > 10) {
            requests.push({
              text: previewWithoutImages,
              key: `body_${post.id}`,
              type: 'body',
              postId: post.id,
            })
          }
        }
      }

      if (requests.length === 0) {
        setTranslatingList(false)
        return
      }

      // Call batch translation API
      const response = await fetch('/api/translate/batch', {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          texts: requests.map(r => ({ text: r.text, key: r.key })),
          target_lang: targetLanguage,
        }),
      })

      if (!response.ok) {
        throw new Error('Batch translation failed')
      }

      const data = await response.json()
      const translations = data.translations || []

      // Group translations by post ID
      const translatedMap: Record<string, { title?: string; body?: string }> = {}

      for (let i = 0; i < translations.length; i++) {
        const request = requests[i]
        const translated = translations[i].translated_text || ''

        if (!translatedMap[request.postId]) {
          translatedMap[request.postId] = {}
        }

        if (request.type === 'title') {
          translatedMap[request.postId].title = translated
        } else {
          translatedMap[request.postId].body = translated
        }
      }

      setTranslatedListPosts(prev => ({ ...prev, ...translatedMap }))
    } catch (err: any) {
      // Silent fail for batch translation
      console.error('Batch translation failed:', err)
    } finally {
      setTranslatingList(false)
    }
  }, [accessToken, targetLanguage, removeImageMarkdown])

  // Translate comments (batch)
  const translateComments = useCallback(async (
    comments: Array<{ id: string; body: string }>
  ) => {
    if (!accessToken || comments.length === 0) return

    setTranslatingComments(true)

    try {
      const response = await fetch('/api/translate/batch', {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          texts: comments.map(c => ({ text: c.body, key: c.id })),
          target_lang: targetLanguage,
        }),
      })

      if (!response.ok) {
        throw new Error('Comment translation failed')
      }

      const data = await response.json()
      const translations = data.translations || []

      const translatedMap: Record<string, string> = {}
      translations.forEach((t: any, i: number) => {
        translatedMap[comments[i].id] = t.translated_text || ''
      })

      setTranslatedComments(prev => ({ ...prev, ...translatedMap }))
    } catch (err: any) {
      // Silent fail for comment translation
      console.error('Comment translation failed:', err)
    } finally {
      setTranslatingComments(false)
    }
  }, [accessToken, targetLanguage])

  return {
    translatedContent,
    showingOriginal,
    translating,
    translatePost,
    toggleOriginal,
    clearTranslation,
    translatedListPosts,
    translatingList,
    translatePostList,
    translatedComments,
    translatingComments,
    translateComments,
    translationCache,
  }
}
