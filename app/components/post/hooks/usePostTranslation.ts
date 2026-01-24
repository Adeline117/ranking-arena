'use client'

import { useState, useCallback, useEffect } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'

type Comment = {
  id: string
  content: string
  replies?: Comment[]
  [key: string]: unknown
}

interface UsePostTranslationOptions {
  language: string
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
}

export function isChineseText(text: string): boolean {
  if (!text) return false
  const chineseRegex = /[\u4e00-\u9fa5]/g
  const chineseMatches = text.match(chineseRegex)
  const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
  return chineseRatio > 0.1
}

export function usePostTranslation({ language, showToast }: UsePostTranslationOptions) {
  // Single post content translation
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})

  // List post title translations
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)

  // Comment translations
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({})
  const [translatingComments, setTranslatingComments] = useState(false)

  const extractImagesFromContent = useCallback((content: string): string[] => {
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
    const images: string[] = []
    let match
    while ((match = imageRegex.exec(content)) !== null) {
      images.push(match[0])
    }
    return images
  }, [])

  const removeImagesFromContent = useCallback((content: string): string => {
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '').replace(/\n{3,}/g, '\n\n').trim()
  }, [])

  // Translate a single post's content
  const translateContent = useCallback(async (postId: string, content: string, targetLang: 'zh' | 'en') => {
    const cacheKey = `${postId}-content-${targetLang}`
    const originalImages = extractImagesFromContent(content)

    if (translationCache[cacheKey]) {
      let cachedWithImages = translationCache[cacheKey]
      if (originalImages.length > 0 && !cachedWithImages.includes('![')) {
        cachedWithImages += '\n\n' + originalImages.join('\n')
      }
      setTranslatedContent(cachedWithImages)
      setShowingOriginal(false)
      return
    }

    setTranslating(true)
    try {
      const textToTranslate = removeImagesFromContent(content)

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          text: textToTranslate,
          targetLang,
          contentType: 'post_content',
          contentId: postId,
        }),
      })
      const data = await response.json()

      if (response.ok && data.success && data.data?.translatedText) {
        let translated = data.data.translatedText
        if (originalImages.length > 0) {
          translated += '\n\n' + originalImages.join('\n')
        }
        setTranslatedContent(translated)
        setShowingOriginal(false)
        setTranslationCache(prev => ({ ...prev, [cacheKey]: data.data.translatedText }))
      } else {
        showToast(data.error || '翻译失败', 'error')
      }
    } catch {
      showToast('翻译服务出错', 'error')
    } finally {
      setTranslating(false)
    }
  }, [translationCache, showToast, extractImagesFromContent, removeImagesFromContent])

  // Batch translate post titles
  const translateListPosts = useCallback(async (posts: Array<{ id: string; title?: string }>, targetLang: 'zh' | 'en') => {
    if (translatingList) return

    const needsTranslation = posts.filter(p => {
      if (translatedListPosts[p.id]?.title) return false
      if (!p.title) return false
      const titleIsChinese = isChineseText(p.title)
      return targetLang === 'en' ? titleIsChinese : !titleIsChinese
    })

    if (needsTranslation.length === 0) return

    setTranslatingList(true)

    try {
      const items = needsTranslation.slice(0, 20).map(post => ({
        id: post.id,
        text: post.title || '',
        contentType: 'post_title' as const,
        contentId: post.id,
      }))

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()

      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string }>
        setTranslatedListPosts(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = { title: result.translatedText }
          }
          return updated
        })
      }
    } catch {
      // Silent fail for batch translation
    } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts])

  // Batch translate comments
  const translateComments = useCallback(async (commentsToTranslate: Comment[], targetLang: 'zh' | 'en') => {
    if (translatingComments) return

    const allComments: Comment[] = []

    commentsToTranslate.forEach(c => {
      if (!translatedComments[c.id] && c.content) {
        const hasChinese = isChineseText(c.content)
        if ((targetLang === 'en' && hasChinese) || (targetLang === 'zh' && !hasChinese)) {
          allComments.push(c)
        }
      }
      if (c.replies) {
        c.replies.forEach(r => {
          if (!translatedComments[r.id] && r.content) {
            const hasChinese = isChineseText(r.content)
            if ((targetLang === 'en' && hasChinese) || (targetLang === 'zh' && !hasChinese)) {
              allComments.push(r)
            }
          }
        })
      }
    })

    if (allComments.length === 0) return

    setTranslatingComments(true)

    try {
      const items = allComments.slice(0, 20).map(comment => ({
        id: comment.id,
        text: comment.content || '',
        contentType: 'comment' as const,
        contentId: comment.id,
      }))

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()

      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string }>
        setTranslatedComments(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = result.translatedText
          }
          return updated
        })
      }
    } catch {
      // Silent fail for comment translation
    } finally {
      setTranslatingComments(false)
    }
  }, [translatingComments, translatedComments])

  // Reset translation state when opening a new post
  const resetTranslation = useCallback(() => {
    setTranslatedContent(null)
    setShowingOriginal(true)
    setTranslating(false)
  }, [])

  return {
    // Single content
    translatedContent,
    setTranslatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    translateContent,
    resetTranslation,
    // List
    translatedListPosts,
    translatingList,
    translateListPosts,
    // Comments
    translatedComments,
    translatingComments,
    translateComments,
    // Utilities
    isChineseText,
  }
}

// Auto-translate hook for list posts
export function useAutoTranslateList(
  posts: Array<{ id: string; title?: string }>,
  language: string,
  translateListPosts: (posts: Array<{ id: string; title?: string }>, targetLang: 'zh' | 'en') => Promise<void>
) {
  useEffect(() => {
    if (posts.length > 0) {
      translateListPosts(posts, language as 'zh' | 'en')
    }
  }, [language, posts, translateListPosts])
}

// Auto-translate hook for comments
export function useAutoTranslateComments(
  comments: Comment[],
  language: string,
  isOpen: boolean,
  translateComments: (comments: Comment[], targetLang: 'zh' | 'en') => Promise<void>
) {
  useEffect(() => {
    if (comments.length > 0 && isOpen) {
      const targetLang = language === 'en' ? 'en' : 'zh'
      translateComments(comments, targetLang)
    }
  }, [comments, language, isOpen, translateComments])
}
