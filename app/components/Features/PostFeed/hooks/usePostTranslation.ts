'use client'

import { useState, useCallback } from 'react'
import { isChineseText } from '../utils'

type Comment = {
  id: string
  content: string
  replies?: Comment[]
}

interface TranslationState {
  translatedContent: string | null
  showingOriginal: boolean
  translating: boolean
  translationCache: Record<string, string>
  translatedListPosts: Record<string, { title?: string; body?: string }>
  translatingList: boolean
  translatedComments: Record<string, string>
  translatingComments: boolean
}

interface UsePostTranslationReturn extends TranslationState {
  setShowingOriginal: (value: boolean) => void
  translateContent: (postId: string, content: string, targetLang: 'zh' | 'en') => Promise<void>
  translateListPosts: (posts: Array<{ id: string; title?: string }>, targetLang: 'zh' | 'en') => Promise<void>
  translateComments: (comments: Comment[], targetLang: 'zh' | 'en') => Promise<void>
}

export function usePostTranslation(
  showToast: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void
): UsePostTranslationReturn {
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({})
  const [translatingComments, setTranslatingComments] = useState(false)

  // 翻译帖子内容（带缓存）
  const translateContent = useCallback(async (
    postId: string,
    content: string,
    targetLang: 'zh' | 'en'
  ) => {
    const cacheKey = `${postId}-content-${targetLang}`
    
    // 检查本地缓存
    if (translationCache[cacheKey]) {
      setTranslatedContent(translationCache[cacheKey])
      setShowingOriginal(false)
      return
    }

    setTranslating(true)
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: content,
          targetLang,
          contentType: 'post_content',
          contentId: postId,
        }),
      })
      const data = await response.json()
      
      if (response.ok && data.success && data.data?.translatedText) {
        const translated = data.data.translatedText
        setTranslatedContent(translated)
        setShowingOriginal(false)
        setTranslationCache(prev => ({ ...prev, [cacheKey]: translated }))
      } else {
        showToast(data.error || '翻译失败', 'error')
      }
    } catch (err) {
      showToast('翻译服务出错', 'error')
    } finally {
      setTranslating(false)
    }
  }, [translationCache, showToast])

  // 批量翻译帖子标题
  const translateListPosts = useCallback(async (
    postsToTranslate: Array<{ id: string; title?: string }>,
    targetLang: 'zh' | 'en'
  ) => {
    if (translatingList) return
    
    // 过滤出需要翻译的帖子
    const needsTranslation = postsToTranslate.filter(p => {
      const alreadyTranslated = translatedListPosts[p.id]?.title
      if (alreadyTranslated) return false
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()
      
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        
        setTranslatedListPosts(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = { title: result.translatedText }
          }
          return updated
        })
      }
    } catch (err) {
      // Silent fail for list translation
    } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts])

  // 批量翻译评论
  const translateComments = useCallback(async (
    commentsToTranslate: Comment[],
    targetLang: 'zh' | 'en'
  ) => {
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
        text: comment.content,
        contentType: 'comment' as const,
        contentId: comment.id,
      }))

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()
      
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        
        setTranslatedComments(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = result.translatedText
          }
          return updated
        })
      }
    } catch (err) {
      // Silent fail for comment translation
    } finally {
      setTranslatingComments(false)
    }
  }, [translatingComments, translatedComments])

  return {
    translatedContent,
    showingOriginal,
    translating,
    translationCache,
    translatedListPosts,
    translatingList,
    translatedComments,
    translatingComments,
    setShowingOriginal,
    translateContent,
    translateListPosts,
    translateComments,
  }
}

