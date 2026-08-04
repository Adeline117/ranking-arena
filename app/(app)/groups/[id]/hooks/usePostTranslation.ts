'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import {
  requestBatchTranslation,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'
import type { Post } from './useGroupPosts'

type TranslatedPost = { title?: string; content?: string }
type TranslationField = 'title' | 'content'

type TranslationDescriptor = {
  cacheKey: string
  contentId: string
  contentType: 'post_title' | 'post_content'
  field: TranslationField
  id: string
  postId: string
  text: string
}

type TranslationScope = {
  accessToken: string
  descriptors: TranslationDescriptor[]
  key: string
  targetLanguage: TranslationTargetLanguage
}

type ActiveTranslation = {
  controller: AbortController
  key: string
  sequence: number
}

const TRANSLATION_BATCH_SIZE = 20
const MAX_TRANSLATION_CACHE_ENTRIES = 400

function targetLanguage(language: string): TranslationTargetLanguage | null {
  return language === 'zh' || language === 'en' || language === 'ja' || language === 'ko'
    ? language
    : null
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function buildDescriptors(
  posts: readonly Post[],
  ownerKey: string,
  language: TranslationTargetLanguage
): TranslationDescriptor[] | null {
  const seenPostIds = new Set<string>()
  const descriptors: TranslationDescriptor[] = []

  for (const post of posts) {
    if (typeof post.id !== 'string' || !post.id || seenPostIds.has(post.id)) return null
    seenPostIds.add(post.id)

    const fields: Array<{
      field: TranslationField
      text: unknown
      contentType: TranslationDescriptor['contentType']
    }> = [
      { field: 'title', text: post.title, contentType: 'post_title' },
      { field: 'content', text: post.content, contentType: 'post_content' },
    ]

    for (const { field, text, contentType } of fields) {
      if (text === null || text === undefined || text === '') continue
      if (typeof text !== 'string') return null
      if (!text.trim()) continue

      const id = `${post.id}-${field}`
      descriptors.push({
        cacheKey: JSON.stringify([ownerKey, language, post.id, field, text]),
        contentId: post.id,
        contentType,
        field,
        id,
        postId: post.id,
        text,
      })
    }
  }

  return descriptors
}

function pruneCache(cache: Map<string, string>, protectedKeys: ReadonlySet<string>): void {
  if (cache.size <= MAX_TRANSLATION_CACHE_ENTRIES) return

  for (const key of cache.keys()) {
    if (cache.size <= MAX_TRANSLATION_CACHE_ENTRIES) return
    if (!protectedKeys.has(key)) cache.delete(key)
  }
}

interface UsePostTranslationOptions {
  posts: Post[]
  language: string
  ownerKey: string
  translatingEnabled?: boolean
  accessToken?: string | null
}

export function usePostTranslation({
  posts,
  language,
  ownerKey,
  translatingEnabled = true,
  accessToken,
}: UsePostTranslationOptions) {
  const [cacheRevision, setCacheRevision] = useState(0)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const cacheRef = useRef(new Map<string, string>())
  const activeRef = useRef<ActiveTranslation | null>(null)
  const sequenceRef = useRef(0)

  const sourceIdentity = JSON.stringify(
    posts.map((post) => [
      post.id,
      post.content_version,
      post.updated_at,
      post.title,
      post.content ?? null,
    ])
  )

  const scope = useMemo<TranslationScope | null>(() => {
    const target = targetLanguage(language)
    if (
      !translatingEnabled ||
      !target ||
      !ownerKey ||
      typeof accessToken !== 'string' ||
      !accessToken.trim() ||
      posts.length === 0
    ) {
      return null
    }

    const descriptors = buildDescriptors(posts, ownerKey, target)
    if (!descriptors || descriptors.length === 0) return null
    return {
      accessToken,
      descriptors,
      key: JSON.stringify([
        'group-post-translation',
        ownerKey,
        accessToken,
        target,
        descriptors.map(({ cacheKey }) => cacheKey),
      ]),
      targetLanguage: target,
    }
    // sourceIdentity snapshots every source field even when the posts array is reused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, language, ownerKey, sourceIdentity, translatingEnabled])

  const translatedPosts = useMemo<Record<string, TranslatedPost>>(() => {
    if (!scope) return {}
    const translated: Record<string, TranslatedPost> = {}
    for (const descriptor of scope.descriptors) {
      const value = cacheRef.current.get(descriptor.cacheKey)
      if (value === undefined) continue
      translated[descriptor.postId] = {
        ...translated[descriptor.postId],
        [descriptor.field]: value,
      }
    }
    return translated
    // cacheRevision publishes writes made to the bounded ref-backed cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheRevision, scope?.key])

  useEffect(() => {
    if (!scope) {
      const active = activeRef.current
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new DOMException('Group translation scope closed', 'AbortError'))
      }
      activeRef.current = null
      setLoadingKey(null)
      return
    }

    const missing = scope.descriptors.filter(
      (descriptor) => !cacheRef.current.has(descriptor.cacheKey)
    )
    if (missing.length === 0) {
      const active = activeRef.current
      if (active && active.key !== scope.key && !active.controller.signal.aborted) {
        active.controller.abort(
          new DOMException('Group translation cache superseded', 'AbortError')
        )
      }
      activeRef.current = null
      setLoadingKey(null)
      return
    }

    const previous = activeRef.current
    if (previous?.key === scope.key) return
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(new DOMException('Group translation superseded', 'AbortError'))
    }

    const controller = new AbortController()
    const active: ActiveTranslation = {
      controller,
      key: scope.key,
      sequence: ++sequenceRef.current,
    }
    activeRef.current = active
    setLoadingKey(scope.key)
    let live = true

    const ownsActiveRequest = () =>
      live && activeRef.current === active && sequenceRef.current === active.sequence
    const isCurrent = () => ownsActiveRequest() && !controller.signal.aborted

    void (async () => {
      try {
        const chunks: TranslationDescriptor[][] = []
        for (let offset = 0; offset < missing.length; offset += TRANSLATION_BATCH_SIZE) {
          chunks.push(missing.slice(offset, offset + TRANSLATION_BATCH_SIZE))
        }

        const receipts = await Promise.all(
          chunks.map((chunk) => {
            const items: BatchTranslationItem[] = chunk.map((descriptor) => ({
              id: descriptor.id,
              text: descriptor.text,
              contentType: descriptor.contentType,
              contentId: descriptor.contentId,
              targetLang: scope.targetLanguage,
            }))
            return requestBatchTranslation(items, scope.targetLanguage, {
              accessToken: scope.accessToken,
              csrfHeaders: getCsrfHeaders(),
              signal: controller.signal,
            })
          })
        )
        if (!isCurrent()) return

        const staged = new Map<string, string>()
        chunks.forEach((chunk, chunkIndex) => {
          const receipt = receipts[chunkIndex]
          for (const descriptor of chunk) {
            const result = receipt?.results[descriptor.id]
            if (!result) throw new Error('Group translation receipt lost a requested field')
            staged.set(descriptor.cacheKey, result.translatedText)
          }
        })
        if (staged.size !== missing.length || !isCurrent()) return

        for (const [key, value] of staged) cacheRef.current.set(key, value)
        pruneCache(
          cacheRef.current,
          new Set(scope.descriptors.map((descriptor) => descriptor.cacheKey))
        )
        setCacheRevision((revision) => revision + 1)
      } catch (error) {
        if (ownsActiveRequest() && !controller.signal.aborted) {
          controller.abort(new DOMException('Group translation batch failed', 'AbortError'))
        }
        if (ownsActiveRequest() && !isAbortError(error)) {
          logger.warn('Group translation failed:', error)
        }
      } finally {
        if (ownsActiveRequest()) {
          activeRef.current = null
          setLoadingKey(null)
        }
      }
    })()

    return () => {
      live = false
      if (!controller.signal.aborted) {
        controller.abort(new DOMException('Group translation effect closed', 'AbortError'))
      }
      if (activeRef.current === active) activeRef.current = null
    }
  }, [accessToken, scope])

  return {
    translatedPosts,
    translatingPosts: scope !== null && loadingKey === scope.key,
  }
}
