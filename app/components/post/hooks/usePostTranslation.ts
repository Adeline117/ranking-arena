'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import type { Comment } from './usePostComments'

type Post = {
  id: string
  title?: string | null
  content?: string | null
}

export interface PostTranslationState {
  translatedContent: string | null
  setTranslatedContent: (v: string | null) => void
  showingOriginal: boolean
  setShowingOriginal: (v: boolean) => void
  translating: boolean
  translatedListPosts: Record<string, { title?: string; body?: string }>
  translatingList: boolean
  translatedComments: Record<string, string>
  translatingComments: boolean
  isChineseText: (text: string) => boolean
  extractImagesFromContent: (content: string) => string[]
  removeImagesFromContent: (content: string) => string
  translateContent: (postId: string, content: string, targetLang: 'zh' | 'en') => Promise<void>
  translateListPosts: (posts: Post[], targetLang: 'zh' | 'en') => Promise<void>
  translateComments: (comments: Comment[], targetLang: 'zh' | 'en') => Promise<void>
}

export function usePostTranslation({
  accessToken,
  showToast,
  t,
}: {
  accessToken: string | null
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  t: (key: string) => string
}): PostTranslationState {
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({})
  const [translatingComments, setTranslatingComments] = useState(false)

  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1
  }, [])

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
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...getCsrfHeaders() }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: textToTranslate, targetLang, contentType: 'post_content', contentId: postId }),
      })
      const data = await response.json()

      if (response.ok && data.success && data.data?.translatedText) {
        let translated = data.data.translatedText
        if (originalImages.length > 0) translated += '\n\n' + originalImages.join('\n')
        setTranslatedContent(translated)
        setShowingOriginal(false)
        setTranslationCache(prev => ({ ...prev, [cacheKey]: data.data.translatedText }))
      } else {
        showToast(data.error || t('translationFailed'), 'error')
      }
    } catch {
      showToast(t('translationServiceError'), 'error')
    } finally {
      setTranslating(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationCache, showToast, extractImagesFromContent, removeImagesFromContent, accessToken])

  const translateListPosts = useCallback(async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
    if (translatingList) return
    const needsTranslation = postsToTranslate.filter(p => {
      if (translatedListPosts[p.id]?.title && translatedListPosts[p.id]?.body) return false
      const titleIsChinese = p.title ? isChineseText(p.title) : false
      const contentIsChinese = p.content ? isChineseText(p.content) : false
      return (p.title && (targetLang === 'en' ? titleIsChinese : !titleIsChinese)) ||
             (p.content && (targetLang === 'en' ? contentIsChinese : !contentIsChinese))
    })
    if (needsTranslation.length === 0) return

    setTranslatingList(true)
    try {
      const items: Array<{ id: string; text: string; contentType: 'post_title' | 'post_content'; contentId: string }> = []
      for (const post of needsTranslation.slice(0, 10)) {
        if (post.title && !translatedListPosts[post.id]?.title) {
          items.push({ id: `${post.id}_title`, text: post.title, contentType: 'post_title', contentId: post.id })
        }
        if (post.content && !translatedListPosts[post.id]?.body) {
          const contentPreview = removeImagesFromContent(post.content).slice(0, 200)
          if (contentPreview) items.push({ id: `${post.id}_body`, text: contentPreview, contentType: 'post_content', contentId: post.id })
        }
      }
      if (items.length === 0) { setTranslatingList(false); return }

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        setTranslatedListPosts(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            const [postId, type] = id.split('_')
            if (!updated[postId]) updated[postId] = {}
            if (type === 'title') updated[postId].title = result.translatedText
            else if (type === 'body') updated[postId].body = result.translatedText
          }
          return updated
        })
      }
    } catch { /* silent */ }
    finally { setTranslatingList(false) }
  }, [translatingList, translatedListPosts, isChineseText, removeImagesFromContent])

  const translateComments = useCallback(async (commentsToTranslate: Comment[], targetLang: 'zh' | 'en') => {
    if (translatingComments) return
    const allComments: Comment[] = []
    commentsToTranslate.forEach(c => {
      if (!translatedComments[c.id] && c.content) {
        const hasChinese = isChineseText(c.content)
        if ((targetLang === 'en' && hasChinese) || (targetLang === 'zh' && !hasChinese)) allComments.push(c)
      }
      if (c.replies) {
        c.replies.forEach(r => {
          if (!translatedComments[r.id] && r.content) {
            const hasChinese = isChineseText(r.content)
            if ((targetLang === 'en' && hasChinese) || (targetLang === 'zh' && !hasChinese)) allComments.push(r)
          }
        })
      }
    })
    if (allComments.length === 0) return

    setTranslatingComments(true)
    try {
      const items = allComments.slice(0, 20).map(comment => ({
        id: comment.id, text: comment.content || '', contentType: 'comment' as const, contentId: comment.id,
      }))
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        setTranslatedComments(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) updated[id] = result.translatedText
          return updated
        })
      }
    } catch { /* silent */ }
    finally { setTranslatingComments(false) }
  }, [translatingComments, translatedComments, isChineseText])

  return {
    translatedContent, setTranslatedContent, showingOriginal, setShowingOriginal,
    translating, translatedListPosts, translatingList, translatedComments, translatingComments,
    isChineseText, extractImagesFromContent, removeImagesFromContent,
    translateContent, translateListPosts, translateComments,
  }
}
