'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import {
  requestBatchTranslation,
  requestSingleTranslation,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'
import type { Comment } from './usePostComments'

type Post = {
  id: string
  title?: string | null
  content?: string | null
}

type TranslationScope = {
  accessToken: string
  language: string | undefined
  generation: number
}

type ActiveRequest = {
  key: string
  sequence: number
  scope: TranslationScope
  controller: AbortController
  promise: Promise<void>
}

type CachedTranslation = {
  source: string
  targetLang: TranslationTargetLanguage
  translatedText: string
}

type ListPart = 'title' | 'body'

type ListDescriptor = {
  item: BatchTranslationItem
  postId: string
  part: ListPart
  laneKey: string
}

type CommentDescriptor = {
  item: BatchTranslationItem
  commentId: string
  laneKey: string
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

function laneKey(...parts: string[]): string {
  return JSON.stringify(parts)
}

function appendImages(translatedText: string, images: readonly string[]): string {
  return images.length > 0 ? `${translatedText}\n\n${images.join('\n')}` : translatedText
}

function sameScope(left: TranslationScope, right: TranslationScope): boolean {
  return (
    left.accessToken === right.accessToken &&
    left.language === right.language &&
    left.generation === right.generation
  )
}

export function usePostTranslation({
  accessToken,
  showToast,
  t,
  language,
}: {
  accessToken: string | null
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  t: (key: string) => string
  /** Current UI language. Viewer or language changes invalidate every local result. */
  language?: string
}): PostTranslationState {
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translatedListPosts, setTranslatedListPosts] = useState<
    Record<string, { title?: string; body?: string }>
  >({})
  const [translatingList, setTranslatingList] = useState(false)
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({})
  const [translatingComments, setTranslatingComments] = useState(false)

  const mountedRef = useRef(false)
  const renderScopeRef = useRef({ accessToken, language })
  renderScopeRef.current = { accessToken, language }
  const scopeGenerationRef = useRef(0)
  const previousScopeRef = useRef({ accessToken, language })
  const sequenceRef = useRef(0)

  const translatedListPostsRef = useRef(translatedListPosts)
  translatedListPostsRef.current = translatedListPosts
  const translatedCommentsRef = useRef(translatedComments)
  translatedCommentsRef.current = translatedComments

  const contentCacheRef = useRef(new Map<string, CachedTranslation>())
  const listCacheRef = useRef(new Map<string, CachedTranslation>())
  const commentCacheRef = useRef(new Map<string, CachedTranslation>())
  const activeContentRef = useRef<ActiveRequest | null>(null)
  const activeListRef = useRef<ActiveRequest | null>(null)
  const activeCommentsRef = useRef<ActiveRequest | null>(null)

  const abortActiveRequests = useCallback(() => {
    const reason = new DOMException('Translation scope changed', 'AbortError')
    for (const active of [
      activeContentRef.current,
      activeListRef.current,
      activeCommentsRef.current,
    ]) {
      if (active && !active.controller.signal.aborted) active.controller.abort(reason)
    }
    activeContentRef.current = null
    activeListRef.current = null
    activeCommentsRef.current = null
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      scopeGenerationRef.current += 1
      abortActiveRequests()
    }
  }, [abortActiveRequests])

  useEffect(() => {
    const previous = previousScopeRef.current
    if (previous.accessToken === accessToken && previous.language === language) return

    previousScopeRef.current = { accessToken, language }
    scopeGenerationRef.current += 1
    abortActiveRequests()
    contentCacheRef.current.clear()
    listCacheRef.current.clear()
    commentCacheRef.current.clear()
    translatedListPostsRef.current = {}
    translatedCommentsRef.current = {}
    setTranslatedListPosts({})
    setTranslatedComments({})
    setTranslatedContent(null)
    setShowingOriginal(true)
    setTranslating(false)
    setTranslatingList(false)
    setTranslatingComments(false)
  }, [accessToken, abortActiveRequests, language])

  const captureScope = useCallback((token: string): TranslationScope => {
    return {
      accessToken: token,
      language: renderScopeRef.current.language,
      generation: scopeGenerationRef.current,
    }
  }, [])

  const isScopeCurrent = useCallback((scope: TranslationScope): boolean => {
    const current = renderScopeRef.current
    return (
      mountedRef.current &&
      current.accessToken === scope.accessToken &&
      current.language === scope.language &&
      scopeGenerationRef.current === scope.generation
    )
  }, [])

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
    while ((match = imageRegex.exec(content)) !== null) images.push(match[0])
    return images
  }, [])

  const removeImagesFromContent = useCallback((content: string): string => {
    return content
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }, [])

  const translateContent = useCallback(
    async (postId: string, content: string, targetLang: TranslationTargetLanguage) => {
      const token = accessToken
      if (!token || !postId || !content) return

      const source = removeImagesFromContent(content)
      const images = extractImagesFromContent(content)
      const cacheKey = laneKey(postId, targetLang)
      const requestKey = laneKey(postId, targetLang, source)
      const scope = captureScope(token)
      const existing = activeContentRef.current
      if (existing && existing.key === requestKey && sameScope(existing.scope, scope)) {
        return existing.promise
      }

      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(new DOMException('Translation request superseded', 'AbortError'))
      }
      activeContentRef.current = null
      sequenceRef.current += 1

      if (!source) {
        setTranslatedContent(null)
        setShowingOriginal(true)
        setTranslating(false)
        return
      }

      const cached = contentCacheRef.current.get(cacheKey)
      if (cached && cached.source === source && cached.targetLang === targetLang) {
        setTranslatedContent(appendImages(cached.translatedText, images))
        setShowingOriginal(false)
        setTranslating(false)
        return
      }
      contentCacheRef.current.delete(cacheKey)
      setTranslatedContent(null)
      setTranslating(true)

      const controller = new AbortController()
      const sequence = sequenceRef.current
      const promise = (async () => {
        try {
          const receipt = await requestSingleTranslation(
            {
              text: source,
              targetLang,
              contentType: 'post_content',
              contentId: postId,
            },
            {
              accessToken: token,
              csrfHeaders: getCsrfHeaders(),
              signal: controller.signal,
            }
          )
          const active = activeContentRef.current
          if (!active || active.sequence !== sequence || !isScopeCurrent(scope)) {
            return
          }

          if (receipt.sameLanguage) {
            contentCacheRef.current.delete(cacheKey)
            setTranslatedContent(null)
            setShowingOriginal(true)
            return
          }

          contentCacheRef.current.set(cacheKey, {
            source,
            targetLang,
            translatedText: receipt.translatedText,
          })
          setTranslatedContent(appendImages(receipt.translatedText, images))
          setShowingOriginal(false)
        } catch {
          const active = activeContentRef.current
          if (
            active?.sequence === sequence &&
            isScopeCurrent(scope) &&
            !controller.signal.aborted
          ) {
            setTranslatedContent(null)
            setShowingOriginal(true)
            showToast(t('translationServiceError'), 'error')
          }
        } finally {
          const active = activeContentRef.current
          if (active?.sequence === sequence && isScopeCurrent(scope)) {
            activeContentRef.current = null
            setTranslating(false)
          }
        }
      })()
      activeContentRef.current = { key: requestKey, sequence, scope, controller, promise }
      return promise
    },
    [
      accessToken,
      captureScope,
      extractImagesFromContent,
      isScopeCurrent,
      removeImagesFromContent,
      showToast,
      t,
    ]
  )

  const removeStaleListParts = useCallback((stale: readonly [string, ListPart][]) => {
    if (stale.length === 0) return
    const current = translatedListPostsRef.current
    let next = current
    for (const [postId, part] of stale) {
      if (!next[postId]?.[part]) continue
      if (next === current) next = { ...current }
      const post = { ...next[postId] }
      delete post[part]
      if (post.title || post.body) next[postId] = post
      else delete next[postId]
    }
    if (next !== current) {
      translatedListPostsRef.current = next
      setTranslatedListPosts(next)
    }
  }, [])

  const translateListPosts = useCallback(
    async (postsToTranslate: Post[], targetLang: TranslationTargetLanguage) => {
      const token = accessToken
      if (!token) return

      const descriptors: ListDescriptor[] = []
      const stale: Array<[string, ListPart]> = []
      const seenLanes = new Set<string>()
      const addPart = (
        postId: string,
        part: ListPart,
        source: string,
        needsTranslation: boolean
      ) => {
        const partLaneKey = laneKey(postId, part)
        if (seenLanes.has(partLaneKey)) return
        seenLanes.add(partLaneKey)
        const cached = listCacheRef.current.get(partLaneKey)
        if (
          !needsTranslation ||
          !source ||
          !cached ||
          cached.source !== source ||
          cached.targetLang !== targetLang
        ) {
          if (cached) listCacheRef.current.delete(partLaneKey)
          stale.push([postId, part])
        }
        if (
          needsTranslation &&
          source &&
          (!cached || cached.source !== source || cached.targetLang !== targetLang)
        ) {
          const id = `item-${descriptors.length}`
          descriptors.push({
            item: {
              id,
              text: source,
              contentType: part === 'title' ? 'post_title' : 'post_content',
              contentId: postId,
              targetLang,
            },
            postId,
            part,
            laneKey: partLaneKey,
          })
        }
      }

      for (const post of postsToTranslate.slice(0, 10)) {
        if (!post.id) continue
        if (post.title) {
          const hasChinese = isChineseText(post.title)
          addPart(post.id, 'title', post.title, targetLang === 'en' ? hasChinese : !hasChinese)
        }
        if (post.content) {
          const source = removeImagesFromContent(post.content).slice(0, 200)
          const hasChinese = isChineseText(source)
          addPart(post.id, 'body', source, targetLang === 'en' ? hasChinese : !hasChinese)
        }
      }
      removeStaleListParts(stale)
      if (descriptors.length === 0) return

      const scope = captureScope(token)
      const requestKey = JSON.stringify({
        targetLang,
        items: descriptors.map(({ item, postId, part }) => [item.id, postId, part, item.text]),
      })
      const existing = activeListRef.current
      if (existing && existing.key === requestKey && sameScope(existing.scope, scope)) {
        return existing.promise
      }
      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(new DOMException('Translation request superseded', 'AbortError'))
      }

      const controller = new AbortController()
      const sequence = ++sequenceRef.current
      setTranslatingList(true)
      const promise = (async () => {
        try {
          const receipt = await requestBatchTranslation(
            descriptors.map(({ item }) => item),
            targetLang,
            {
              accessToken: token,
              csrfHeaders: getCsrfHeaders(),
              signal: controller.signal,
            }
          )
          const active = activeListRef.current
          if (!active || active.sequence !== sequence || !isScopeCurrent(scope)) {
            return
          }

          const current = translatedListPostsRef.current
          const next = { ...current }
          for (const descriptor of descriptors) {
            const result = receipt.results[descriptor.item.id]
            if (result.translatedText.trim() === descriptor.item.text.trim()) {
              listCacheRef.current.delete(descriptor.laneKey)
              continue
            }
            listCacheRef.current.set(descriptor.laneKey, {
              source: descriptor.item.text,
              targetLang,
              translatedText: result.translatedText,
            })
            next[descriptor.postId] = {
              ...next[descriptor.postId],
              [descriptor.part]: result.translatedText,
            }
          }
          translatedListPostsRef.current = next
          setTranslatedListPosts(next)
        } catch {
          // Automatic list translation is best-effort; invalid/partial results
          // remain unpublished and must not create a toast loop.
        } finally {
          const active = activeListRef.current
          if (active?.sequence === sequence && isScopeCurrent(scope)) {
            activeListRef.current = null
            setTranslatingList(false)
          }
        }
      })()
      activeListRef.current = { key: requestKey, sequence, scope, controller, promise }
      return promise
    },
    [
      accessToken,
      captureScope,
      isChineseText,
      isScopeCurrent,
      removeImagesFromContent,
      removeStaleListParts,
    ]
  )

  const removeStaleComments = useCallback((commentIds: readonly string[]) => {
    if (commentIds.length === 0) return
    const current = translatedCommentsRef.current
    let next = current
    for (const commentId of commentIds) {
      if (!Object.prototype.hasOwnProperty.call(next, commentId)) continue
      if (next === current) next = { ...current }
      delete next[commentId]
    }
    if (next !== current) {
      translatedCommentsRef.current = next
      setTranslatedComments(next)
    }
  }, [])

  const translateComments = useCallback(
    async (commentsToTranslate: Comment[], targetLang: TranslationTargetLanguage) => {
      const token = accessToken
      if (!token) return

      const candidates: Comment[] = []
      for (const comment of commentsToTranslate) {
        candidates.push(comment)
        if (comment.replies) candidates.push(...comment.replies)
      }

      const descriptors: CommentDescriptor[] = []
      const stale: string[] = []
      const seenIds = new Set<string>()
      for (const comment of candidates) {
        const source = comment.content || ''
        if (!comment.id || !source || seenIds.has(comment.id)) continue
        seenIds.add(comment.id)
        const hasChinese = isChineseText(source)
        const needsTranslation = targetLang === 'en' ? hasChinese : !hasChinese
        const commentLaneKey = laneKey(comment.id)
        const cached = commentCacheRef.current.get(commentLaneKey)
        if (
          !needsTranslation ||
          !cached ||
          cached.source !== source ||
          cached.targetLang !== targetLang
        ) {
          if (cached) commentCacheRef.current.delete(commentLaneKey)
          stale.push(comment.id)
        }
        if (
          needsTranslation &&
          (!cached || cached.source !== source || cached.targetLang !== targetLang) &&
          descriptors.length < 20
        ) {
          const id = `item-${descriptors.length}`
          descriptors.push({
            item: {
              id,
              text: source,
              contentType: 'comment',
              contentId: comment.id,
              targetLang,
            },
            commentId: comment.id,
            laneKey: commentLaneKey,
          })
        }
      }
      removeStaleComments(stale)
      if (descriptors.length === 0) return

      const scope = captureScope(token)
      const requestKey = JSON.stringify({
        targetLang,
        items: descriptors.map(({ item, commentId }) => [item.id, commentId, item.text]),
      })
      const existing = activeCommentsRef.current
      if (existing && existing.key === requestKey && sameScope(existing.scope, scope)) {
        return existing.promise
      }
      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(new DOMException('Translation request superseded', 'AbortError'))
      }

      const controller = new AbortController()
      const sequence = ++sequenceRef.current
      setTranslatingComments(true)
      const promise = (async () => {
        try {
          const receipt = await requestBatchTranslation(
            descriptors.map(({ item }) => item),
            targetLang,
            {
              accessToken: token,
              csrfHeaders: getCsrfHeaders(),
              signal: controller.signal,
            }
          )
          const active = activeCommentsRef.current
          if (!active || active.sequence !== sequence || !isScopeCurrent(scope)) {
            return
          }

          const next = { ...translatedCommentsRef.current }
          for (const descriptor of descriptors) {
            const result = receipt.results[descriptor.item.id]
            if (result.translatedText.trim() === descriptor.item.text.trim()) {
              commentCacheRef.current.delete(descriptor.laneKey)
              continue
            }
            commentCacheRef.current.set(descriptor.laneKey, {
              source: descriptor.item.text,
              targetLang,
              translatedText: result.translatedText,
            })
            next[descriptor.commentId] = result.translatedText
          }
          translatedCommentsRef.current = next
          setTranslatedComments(next)
        } catch {
          // Automatic comment translation follows the same fail-closed policy.
        } finally {
          const active = activeCommentsRef.current
          if (active?.sequence === sequence && isScopeCurrent(scope)) {
            activeCommentsRef.current = null
            setTranslatingComments(false)
          }
        }
      })()
      activeCommentsRef.current = { key: requestKey, sequence, scope, controller, promise }
      return promise
    },
    [accessToken, captureScope, isChineseText, isScopeCurrent, removeStaleComments]
  )

  return {
    translatedContent,
    setTranslatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    translatedListPosts,
    translatingList,
    translatedComments,
    translatingComments,
    isChineseText,
    extractImagesFromContent,
    removeImagesFromContent,
    translateContent,
    translateListPosts,
    translateComments,
  }
}
