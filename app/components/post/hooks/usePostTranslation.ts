'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { jwtSubject } from '@/lib/auth/token-subject'
import {
  requestBatchTranslation,
  requestSingleTranslation,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'
import {
  TRANSLATION_MAX_BATCH_ITEMS,
  TRANSLATION_MAX_BATCH_TEXT_LENGTH,
} from '@/lib/translations/translation-limits'
import { detectClearTranslationSourceLanguage } from '@/lib/translations/translation-language'
import type { Comment } from './usePostComments'

const MAX_CACHE_ENTRIES = 400
const MAX_SHARED_CACHE_ENTRIES = 400
const MAX_SHARED_CACHE_CHARACTERS = 2_000_000

export type TranslatablePost = {
  id: string
  title?: string | null
  content?: string | null
}

type TranslationScope = {
  accessToken: string
  userId: string
  viewerKey: string
  sessionGeneration: number
  language: TranslationTargetLanguage
  generation: number
  key: string
}

type ActiveRequest = {
  key: string
  sequence: number
  scope: TranslationScope
  resourceKey: string
  controller: AbortController
  promise: Promise<void>
}

type CachedTranslation = {
  source: string
  sourceRevision: string
  targetLang: TranslationTargetLanguage
  translatedText: string
}

type SharedTranslationValue = {
  translatedText: string
  sameLanguage: boolean
}

type SharedPhysicalRequest = {
  controller: AbortController
  subscribers: number
  settled: boolean
  cancellationGeneration: number
}

type SharedPendingTranslation = {
  group: SharedPhysicalRequest
  promise: Promise<SharedTranslationValue>
}

type ListPart = 'title' | 'body'

type ListDescriptor = {
  item: BatchTranslationItem
  postId: string
  part: ListPart
  laneKey: string
  sourceRevision: string
}

type CommentDescriptor = {
  item: BatchTranslationItem
  commentId: string
  laneKey: string
}

export type PostTranslationListBusyLanes = Record<string, { title?: boolean; body?: boolean }>

export type PostTranslationCommentBusyLanes = Record<string, boolean>

export interface PostTranslationState {
  translatedContent: string | null
  setTranslatedContent: (value: string | null) => void
  showingOriginal: boolean
  setShowingOriginal: (value: boolean) => void
  translating: boolean
  translatingContentPostId: string | null
  contentTranslationResolved: boolean
  translatedTitle: string | null
  translatingTitle: boolean
  titleTranslationResolved: boolean
  translatedListPosts: Record<string, { title?: string; body?: string }>
  translatingList: boolean
  translatingListLanes: PostTranslationListBusyLanes
  translatedComments: Record<string, string>
  translatingComments: boolean
  translatingCommentLanes: PostTranslationCommentBusyLanes
  needsTranslation: (text: string, targetLang: TranslationTargetLanguage) => boolean
  extractImagesFromContent: (content: string) => string[]
  removeImagesFromContent: (content: string) => string
  cancelContentTranslation: () => void
  cancelTitleTranslation: () => void
  cancelActivePostTranslations: () => void
  translateTitle: (
    postId: string,
    title: string,
    targetLang: TranslationTargetLanguage
  ) => Promise<void>
  translateContent: (
    postId: string,
    content: string,
    targetLang: TranslationTargetLanguage
  ) => Promise<void>
  translateListPosts: (
    posts: readonly TranslatablePost[],
    targetLang: TranslationTargetLanguage
  ) => Promise<void>
  translateComments: (
    comments: readonly Comment[],
    targetLang: TranslationTargetLanguage
  ) => Promise<void>
}

type HookOptions = {
  accessToken: string | null
  authChecked: boolean
  isLoggedIn: boolean
  userId: string | null
  viewerKey: string
  sessionGeneration: number
  language: TranslationTargetLanguage
  activePost: TranslatablePost | null
  listPosts: readonly TranslatablePost[]
  comments: readonly Comment[]
  showToast: (message: string, type: 'error' | 'success' | 'warning' | 'info') => void
  t: (key: string) => string
}

function laneKey(...parts: string[]): string {
  return JSON.stringify(parts)
}

const sharedTranslationCache = new Map<string, SharedTranslationValue>()
const sharedPendingTranslations = new Map<string, SharedPendingTranslation>()
let sharedTranslationCacheCharacters = 0

function sharedTranslationKey(scope: TranslationScope, item: BatchTranslationItem): string {
  return laneKey(
    'post-translation-v1',
    scope.key,
    item.targetLang,
    item.contentType,
    item.contentId,
    item.text
  )
}

function getSharedCachedTranslation(key: string): SharedTranslationValue | undefined {
  const cached = sharedTranslationCache.get(key)
  if (!cached) return undefined
  sharedTranslationCache.delete(key)
  sharedTranslationCache.set(key, cached)
  return cached
}

function sharedCacheWeight(key: string, value: SharedTranslationValue): number {
  return key.length + value.translatedText.length
}

function putSharedCachedTranslation(key: string, value: SharedTranslationValue): void {
  const existing = sharedTranslationCache.get(key)
  if (existing) sharedTranslationCacheCharacters -= sharedCacheWeight(key, existing)
  sharedTranslationCache.delete(key)
  sharedTranslationCache.set(key, value)
  sharedTranslationCacheCharacters += sharedCacheWeight(key, value)

  while (
    sharedTranslationCache.size > MAX_SHARED_CACHE_ENTRIES ||
    sharedTranslationCacheCharacters > MAX_SHARED_CACHE_CHARACTERS
  ) {
    const oldestKey = sharedTranslationCache.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const oldestValue = sharedTranslationCache.get(oldestKey)
    if (oldestValue) {
      sharedTranslationCacheCharacters -= sharedCacheWeight(oldestKey, oldestValue)
    }
    sharedTranslationCache.delete(oldestKey)
  }
}

function getSharedPendingTranslation(key: string): SharedPendingTranslation | undefined {
  const pending = sharedPendingTranslations.get(key)
  if (!pending) return undefined
  if (pending.group.controller.signal.aborted && !pending.group.settled) {
    if (sharedPendingTranslations.get(key) === pending) sharedPendingTranslations.delete(key)
    return undefined
  }
  return pending
}

function abortSignalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Translation subscriber cancelled', 'AbortError')
}

function observePromise(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined
  )
}

function subscribeToSharedTranslation(
  entry: SharedPendingTranslation,
  signal: AbortSignal
): Promise<SharedTranslationValue> {
  if (signal.aborted) return Promise.reject(abortSignalReason(signal))

  entry.group.subscribers += 1
  entry.group.cancellationGeneration += 1
  return new Promise<SharedTranslationValue>((resolve, reject) => {
    let finished = false
    const release = () => {
      entry.group.subscribers = Math.max(0, entry.group.subscribers - 1)
      if (entry.group.subscribers !== 0) return
      const cancellationGeneration = ++entry.group.cancellationGeneration
      // Resource effects cancel the old subscriber before the replacement
      // effect subscribes. Give that exact-identity handoff one microtask; a
      // truly orphaned request is still physically aborted immediately after.
      queueMicrotask(() => {
        if (
          entry.group.subscribers === 0 &&
          entry.group.cancellationGeneration === cancellationGeneration &&
          !entry.group.settled &&
          !entry.group.controller.signal.aborted
        ) {
          entry.group.controller.abort(
            new DOMException('All translation subscribers cancelled', 'AbortError')
          )
        }
      })
    }
    const finish = (settle: () => void) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      release()
      settle()
    }
    const onAbort = () => finish(() => reject(abortSignalReason(signal)))

    signal.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
  })
}

function registerSharedSingle(item: BatchTranslationItem, scope: TranslationScope): void {
  const key = sharedTranslationKey(scope, item)
  if (sharedTranslationCache.has(key) || getSharedPendingTranslation(key)) return

  const group: SharedPhysicalRequest = {
    controller: new AbortController(),
    subscribers: 0,
    settled: false,
    cancellationGeneration: 0,
  }
  const promise = requestSingleTranslation(
    {
      text: item.text,
      targetLang: item.targetLang,
      contentType: item.contentType,
      contentId: item.contentId,
    },
    {
      accessToken: scope.accessToken,
      csrfHeaders: getCsrfHeaders(),
      signal: group.controller.signal,
    }
  ).then((receipt): SharedTranslationValue => {
    const value = {
      translatedText: receipt.translatedText,
      sameLanguage: receipt.sameLanguage,
    }
    putSharedCachedTranslation(key, value)
    return value
  })
  const entry = { group, promise }
  sharedPendingTranslations.set(key, entry)
  observePromise(
    promise.finally(() => {
      group.settled = true
      if (sharedPendingTranslations.get(key) === entry) sharedPendingTranslations.delete(key)
    })
  )
}

function registerSharedBatch(
  records: readonly { item: BatchTranslationItem; key: string }[],
  scope: TranslationScope
): void {
  if (records.length === 0) return
  const group: SharedPhysicalRequest = {
    controller: new AbortController(),
    subscribers: 0,
    settled: false,
    cancellationGeneration: 0,
  }
  const receiptPromise = requestBatchTranslation(
    records.map(({ item }) => item),
    scope.language,
    {
      accessToken: scope.accessToken,
      csrfHeaders: getCsrfHeaders(),
      signal: group.controller.signal,
    }
  )
  const entries: Array<{ key: string; entry: SharedPendingTranslation }> = []

  for (const { item, key } of records) {
    const promise = receiptPromise.then((receipt): SharedTranslationValue => {
      const result = receipt.results[item.id]
      const value = {
        translatedText: result.translatedText,
        sameLanguage: result.translatedText.trim() === item.text.trim(),
      }
      putSharedCachedTranslation(key, value)
      return value
    })
    const entry = { group, promise }
    entries.push({ key, entry })
    sharedPendingTranslations.set(key, entry)
  }

  observePromise(
    receiptPromise.finally(() => {
      group.settled = true
      for (const { key, entry } of entries) {
        if (sharedPendingTranslations.get(key) === entry) sharedPendingTranslations.delete(key)
      }
    })
  )
}

async function requestSharedTranslations(
  items: readonly BatchTranslationItem[],
  scope: TranslationScope,
  mode: 'single' | 'batch',
  signal: AbortSignal
): Promise<Record<string, SharedTranslationValue>> {
  if (signal.aborted) throw abortSignalReason(signal)
  if (items.length === 0 || (mode === 'single' && items.length !== 1)) {
    throw new Error('Invalid shared translation request')
  }
  if (
    items.some((item) => item.targetLang !== scope.language) ||
    new Set(items.map((item) => item.id)).size !== items.length
  ) {
    throw new Error('Shared translation identity mismatch')
  }

  const records = items.map((item) => ({ item, key: sharedTranslationKey(scope, item) }))
  const missing = new Map<string, { item: BatchTranslationItem; key: string }>()
  for (const record of records) {
    if (!getSharedCachedTranslation(record.key) && !getSharedPendingTranslation(record.key)) {
      missing.set(record.key, record)
    }
  }

  if (mode === 'single') {
    const record = [...missing.values()][0]
    if (record) registerSharedSingle(record.item, scope)
  } else {
    for (const chunk of translationRequestChunks([...missing.values()])) {
      registerSharedBatch(chunk, scope)
    }
  }

  const values = await Promise.all(
    records.map(async ({ item, key }) => {
      const cached = getSharedCachedTranslation(key)
      if (cached) return [item.id, cached] as const
      const pending = getSharedPendingTranslation(key)
      if (!pending) throw new Error('Shared translation request disappeared')
      return [item.id, await subscribeToSharedTranslation(pending, signal)] as const
    })
  )
  return Object.fromEntries(values)
}

/**
 * Detail-title work has a smaller failure domain than the all-or-nothing feed
 * batch. Reuse only completed exact cache entries; never subscribe to a bulk
 * pending request whose unrelated item can fail the current detail view.
 */
async function requestIsolatedTitleTranslation(
  item: BatchTranslationItem,
  scope: TranslationScope,
  signal: AbortSignal
): Promise<SharedTranslationValue> {
  if (signal.aborted) throw abortSignalReason(signal)
  const key = sharedTranslationKey(scope, item)
  const cached = getSharedCachedTranslation(key)
  if (cached) return cached

  const receipt = await requestSingleTranslation(
    {
      text: item.text,
      targetLang: item.targetLang,
      contentType: item.contentType,
      contentId: item.contentId,
    },
    {
      accessToken: scope.accessToken,
      csrfHeaders: getCsrfHeaders(),
      signal,
    }
  )
  if (signal.aborted) throw abortSignalReason(signal)
  const value = {
    translatedText: receipt.translatedText,
    sameLanguage: receipt.sameLanguage,
  }
  putSharedCachedTranslation(key, value)
  return value
}

/** Test-only reset for the module-level, owner-bound request coordinator. */
export function resetPostTranslationCoordinatorForTests(): void {
  const groups = new Set([...sharedPendingTranslations.values()].map((entry) => entry.group))
  for (const group of groups) {
    if (!group.controller.signal.aborted) {
      group.controller.abort(new DOMException('Translation test reset', 'AbortError'))
    }
  }
  sharedPendingTranslations.clear()
  sharedTranslationCache.clear()
  sharedTranslationCacheCharacters = 0
}

function isTranslationTargetLanguage(value: string): value is TranslationTargetLanguage {
  return value === 'zh' || value === 'en' || value === 'ja' || value === 'ko'
}

function strictScopeKey(options: {
  accessToken: string | null
  authChecked: boolean
  isLoggedIn: boolean
  userId: string | null
  viewerKey: string
  sessionGeneration: number
  language: string
}): string | null {
  const { accessToken, authChecked, isLoggedIn, userId, viewerKey, sessionGeneration, language } =
    options
  if (
    !authChecked ||
    !isLoggedIn ||
    !accessToken ||
    !userId ||
    userId.trim() !== userId ||
    viewerKey !== `user:${userId}` ||
    !Number.isSafeInteger(sessionGeneration) ||
    sessionGeneration < 0 ||
    !isTranslationTargetLanguage(language) ||
    jwtSubject(accessToken) !== userId
  ) {
    return null
  }
  return laneKey(viewerKey, String(sessionGeneration), userId, accessToken, language)
}

function appendImages(translatedText: string, images: readonly string[]): string {
  return images.length > 0 ? `${translatedText}\n\n${images.join('\n')}` : translatedText
}

function shouldTranslate(text: string, targetLang: TranslationTargetLanguage): boolean {
  return text.trim().length > 0 && detectClearTranslationSourceLanguage(text) !== targetLang
}

function activePostResourceKey(post: TranslatablePost | null): string {
  if (!post) return laneKey('closed')
  return laneKey('post', post.id, post.title ?? '', post.content ?? '')
}

function listResourceKey(posts: readonly TranslatablePost[]): string {
  return JSON.stringify(posts.map((post) => [post.id, post.title ?? '', post.content ?? '']))
}

function flattenComments(comments: readonly Comment[]): Comment[] | null {
  const flattened: Comment[] = []
  const seen = new Set<string>()
  const visit = (comment: Comment): boolean => {
    if (!comment.id || seen.has(comment.id)) return false
    seen.add(comment.id)
    flattened.push(comment)
    for (const reply of comment.replies ?? []) {
      if (!visit(reply)) return false
    }
    return true
  }
  for (const comment of comments) {
    if (!visit(comment)) return null
  }
  return flattened
}

function commentsResourceKey(
  comments: readonly Comment[],
  activePostId: string | null | undefined
): string {
  const flattened = flattenComments(comments)
  if (!flattened) return laneKey('comments', activePostId ?? 'closed', 'invalid-comments')
  return laneKey(
    'comments',
    activePostId ?? 'closed',
    JSON.stringify(flattened.map((comment) => [comment.id, comment.content]))
  )
}

function sameScope(left: TranslationScope, right: TranslationScope): boolean {
  return left.key === right.key && left.generation === right.generation
}

function putBounded<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries = MAX_CACHE_ENTRIES
): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as K | undefined
    if (oldest === undefined) return
    cache.delete(oldest)
  }
}

function translationRequestChunks<T extends { item: BatchTranslationItem }>(
  records: readonly T[]
): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let currentCharacters = 0

  for (const record of records) {
    const nextCharacters = currentCharacters + record.item.text.length
    if (
      current.length > 0 &&
      (current.length >= TRANSLATION_MAX_BATCH_ITEMS ||
        nextCharacters > TRANSLATION_MAX_BATCH_TEXT_LENGTH)
    ) {
      chunks.push(current)
      current = []
      currentCharacters = 0
    }
    current.push(record)
    currentCharacters += record.item.text.length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function listBusyLanes(descriptors: readonly ListDescriptor[]): PostTranslationListBusyLanes {
  const lanes: PostTranslationListBusyLanes = {}
  for (const descriptor of descriptors) {
    lanes[descriptor.postId] = {
      ...lanes[descriptor.postId],
      [descriptor.part]: true,
    }
  }
  return lanes
}

function commentBusyLanes(
  descriptors: readonly CommentDescriptor[]
): PostTranslationCommentBusyLanes {
  return Object.fromEntries(descriptors.map((descriptor) => [descriptor.commentId, true]))
}

export function usePostTranslation({
  accessToken,
  authChecked,
  isLoggedIn,
  userId,
  viewerKey,
  sessionGeneration,
  language,
  activePost,
  listPosts,
  comments,
  showToast,
  t,
}: HookOptions): PostTranslationState {
  const [translatedContentState, setTranslatedContentState] = useState<string | null>(null)
  const [showingOriginalState, setShowingOriginalState] = useState(true)
  const [translatingState, setTranslatingState] = useState(false)
  const [translatingContentPostIdState, setTranslatingContentPostIdState] = useState<string | null>(
    null
  )
  const [contentTranslationResolvedState, setContentTranslationResolvedState] = useState(false)
  const [translatedTitleState, setTranslatedTitleState] = useState<string | null>(null)
  const [translatingTitleState, setTranslatingTitleState] = useState(false)
  const [titleTranslationResolvedState, setTitleTranslationResolvedState] = useState(false)
  const [translatedListPostsState, setTranslatedListPostsState] = useState<
    Record<string, { title?: string; body?: string }>
  >({})
  const [translatingListLanesState, setTranslatingListLanesState] =
    useState<PostTranslationListBusyLanes>({})
  const [translatedCommentsState, setTranslatedCommentsState] = useState<Record<string, string>>({})
  const [translatingCommentLanesState, setTranslatingCommentLanesState] =
    useState<PostTranslationCommentBusyLanes>({})

  const renderScopeKey = strictScopeKey({
    accessToken,
    authChecked,
    isLoggedIn,
    userId,
    viewerKey,
    sessionGeneration,
    language,
  })
  const renderActiveResourceKey = activePostResourceKey(activePost)
  const renderListResourceKey = listResourceKey(listPosts)
  const renderCommentsResourceKey = commentsResourceKey(comments, activePost?.id)

  const mountedRef = useRef(false)
  const scopeGenerationRef = useRef(0)
  const previousScopeKeyRef = useRef(renderScopeKey)
  const previousActiveResourceKeyRef = useRef(renderActiveResourceKey)
  const previousListResourceKeyRef = useRef(renderListResourceKey)
  const previousCommentsResourceKeyRef = useRef(renderCommentsResourceKey)
  const sequenceRef = useRef(0)
  const displayPreferenceRef = useRef<'auto' | 'original' | 'translated'>('auto')
  const renderRef = useRef({
    scopeKey: renderScopeKey,
    accessToken,
    userId,
    viewerKey,
    sessionGeneration,
    language,
    activePost,
    activeResourceKey: renderActiveResourceKey,
    listResourceKey: renderListResourceKey,
    commentsResourceKey: renderCommentsResourceKey,
  })
  renderRef.current = {
    scopeKey: renderScopeKey,
    accessToken,
    userId,
    viewerKey,
    sessionGeneration,
    language,
    activePost,
    activeResourceKey: renderActiveResourceKey,
    listResourceKey: renderListResourceKey,
    commentsResourceKey: renderCommentsResourceKey,
  }

  const contentOwnerScopeRef = useRef<string | null>(renderScopeKey)
  const contentOwnerResourceRef = useRef(renderActiveResourceKey)
  const titleOwnerScopeRef = useRef<string | null>(renderScopeKey)
  const titleOwnerResourceRef = useRef(renderActiveResourceKey)
  const listOwnerScopeRef = useRef<string | null>(renderScopeKey)
  const listOwnerResourceRef = useRef(renderListResourceKey)
  const commentsOwnerScopeRef = useRef<string | null>(renderScopeKey)
  const commentsOwnerResourceRef = useRef(renderCommentsResourceKey)

  const contentCacheRef = useRef(new Map<string, CachedTranslation>())
  const titleCacheRef = useRef(new Map<string, CachedTranslation>())
  const listCacheRef = useRef(new Map<string, CachedTranslation>())
  const commentCacheRef = useRef(new Map<string, CachedTranslation>())
  const activeContentRef = useRef<ActiveRequest | null>(null)
  const activeTitleRef = useRef<ActiveRequest | null>(null)
  const activeListRef = useRef<ActiveRequest | null>(null)
  const activeCommentsRef = useRef<ActiveRequest | null>(null)

  const abortRequest = useCallback((request: ActiveRequest | null, message: string) => {
    if (request && !request.controller.signal.aborted) {
      request.controller.abort(new DOMException(message, 'AbortError'))
    }
  }, [])

  const clearContentState = useCallback((resourceKey = renderRef.current.activeResourceKey) => {
    contentOwnerScopeRef.current = renderRef.current.scopeKey
    contentOwnerResourceRef.current = resourceKey
    displayPreferenceRef.current = 'auto'
    setTranslatedContentState(null)
    setShowingOriginalState(true)
    setTranslatingState(false)
    setTranslatingContentPostIdState(null)
    setContentTranslationResolvedState(false)
  }, [])

  const cancelContentTranslation = useCallback(() => {
    abortRequest(activeContentRef.current, 'Content translation cancelled')
    activeContentRef.current = null
    clearContentState()
  }, [abortRequest, clearContentState])

  const clearTitleState = useCallback((resourceKey = renderRef.current.activeResourceKey) => {
    titleOwnerScopeRef.current = renderRef.current.scopeKey
    titleOwnerResourceRef.current = resourceKey
    setTranslatedTitleState(null)
    setTranslatingTitleState(false)
    setTitleTranslationResolvedState(false)
  }, [])

  const cancelTitleTranslation = useCallback(() => {
    abortRequest(activeTitleRef.current, 'Title translation cancelled')
    activeTitleRef.current = null
    clearTitleState()
  }, [abortRequest, clearTitleState])

  const cancelListTranslation = useCallback(
    (resourceKey = renderRef.current.listResourceKey) => {
      abortRequest(activeListRef.current, 'List translation cancelled')
      activeListRef.current = null
      listOwnerScopeRef.current = renderRef.current.scopeKey
      listOwnerResourceRef.current = resourceKey
      setTranslatedListPostsState({})
      setTranslatingListLanesState({})
    },
    [abortRequest]
  )

  const cancelCommentTranslation = useCallback(
    (resourceKey = renderRef.current.commentsResourceKey) => {
      abortRequest(activeCommentsRef.current, 'Comment translation cancelled')
      activeCommentsRef.current = null
      commentsOwnerScopeRef.current = renderRef.current.scopeKey
      commentsOwnerResourceRef.current = resourceKey
      setTranslatedCommentsState({})
      setTranslatingCommentLanesState({})
    },
    [abortRequest]
  )

  const cancelActivePostTranslations = useCallback(() => {
    cancelTitleTranslation()
    cancelContentTranslation()
    cancelCommentTranslation()
  }, [cancelCommentTranslation, cancelContentTranslation, cancelTitleTranslation])

  const abortAll = useCallback(() => {
    abortRequest(activeContentRef.current, 'Translation scope changed')
    abortRequest(activeTitleRef.current, 'Translation scope changed')
    abortRequest(activeListRef.current, 'Translation scope changed')
    abortRequest(activeCommentsRef.current, 'Translation scope changed')
    activeContentRef.current = null
    activeTitleRef.current = null
    activeListRef.current = null
    activeCommentsRef.current = null
  }, [abortRequest])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      scopeGenerationRef.current += 1
      abortAll()
    }
  }, [abortAll])

  useEffect(() => {
    if (previousScopeKeyRef.current === renderScopeKey) return
    previousScopeKeyRef.current = renderScopeKey
    scopeGenerationRef.current += 1
    abortAll()
    contentCacheRef.current.clear()
    titleCacheRef.current.clear()
    listCacheRef.current.clear()
    commentCacheRef.current.clear()
    clearContentState(renderActiveResourceKey)
    clearTitleState(renderActiveResourceKey)
    cancelListTranslation(renderListResourceKey)
    cancelCommentTranslation(renderCommentsResourceKey)
  }, [
    abortAll,
    cancelCommentTranslation,
    cancelListTranslation,
    clearContentState,
    clearTitleState,
    renderActiveResourceKey,
    renderCommentsResourceKey,
    renderListResourceKey,
    renderScopeKey,
  ])

  useEffect(() => {
    if (previousActiveResourceKeyRef.current === renderActiveResourceKey) return
    previousActiveResourceKeyRef.current = renderActiveResourceKey
    cancelTitleTranslation()
    cancelContentTranslation()
  }, [cancelContentTranslation, cancelTitleTranslation, renderActiveResourceKey])

  useEffect(() => {
    if (previousListResourceKeyRef.current === renderListResourceKey) return
    previousListResourceKeyRef.current = renderListResourceKey
    cancelListTranslation(renderListResourceKey)
  }, [cancelListTranslation, renderListResourceKey])

  useEffect(() => {
    if (previousCommentsResourceKeyRef.current === renderCommentsResourceKey) return
    previousCommentsResourceKeyRef.current = renderCommentsResourceKey
    cancelCommentTranslation(renderCommentsResourceKey)
  }, [cancelCommentTranslation, renderCommentsResourceKey])

  const captureScope = useCallback((): TranslationScope | null => {
    const current = renderRef.current
    if (
      !current.scopeKey ||
      !current.accessToken ||
      !current.userId ||
      !isTranslationTargetLanguage(current.language)
    ) {
      return null
    }
    return {
      accessToken: current.accessToken,
      userId: current.userId,
      viewerKey: current.viewerKey,
      sessionGeneration: current.sessionGeneration,
      language: current.language,
      generation: scopeGenerationRef.current,
      key: current.scopeKey,
    }
  }, [])

  const isScopeCurrent = useCallback((scope: TranslationScope): boolean => {
    const current = renderRef.current
    return (
      mountedRef.current &&
      current.scopeKey === scope.key &&
      current.accessToken === scope.accessToken &&
      current.userId === scope.userId &&
      current.viewerKey === scope.viewerKey &&
      current.sessionGeneration === scope.sessionGeneration &&
      current.language === scope.language &&
      scopeGenerationRef.current === scope.generation
    )
  }, [])

  const needsTranslation = useCallback(
    (text: string, targetLang: TranslationTargetLanguage) => shouldTranslate(text, targetLang),
    []
  )

  const extractImagesFromContent = useCallback((content: string): string[] => {
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
    const images: string[] = []
    let match: RegExpExecArray | null
    while ((match = imageRegex.exec(content)) !== null) images.push(match[0])
    return images
  }, [])

  const removeImagesFromContent = useCallback((content: string): string => {
    return content
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }, [])

  const setTranslatedContent = useCallback((value: string | null) => {
    contentOwnerScopeRef.current = renderRef.current.scopeKey
    contentOwnerResourceRef.current = renderRef.current.activeResourceKey
    setTranslatedContentState(value)
    setContentTranslationResolvedState(value !== null)
  }, [])

  const setShowingOriginal = useCallback((value: boolean) => {
    contentOwnerScopeRef.current = renderRef.current.scopeKey
    contentOwnerResourceRef.current = renderRef.current.activeResourceKey
    displayPreferenceRef.current = value ? 'original' : 'translated'
    setShowingOriginalState(value)
  }, [])

  const revealAutomaticTranslation = useCallback(() => {
    if (displayPreferenceRef.current === 'auto') setShowingOriginalState(false)
  }, [])

  const translateTitle = useCallback(
    async (postId: string, title: string, targetLang: TranslationTargetLanguage) => {
      const scope = captureScope()
      const current = renderRef.current
      const activeMatches =
        current.activePost?.id === postId &&
        (current.activePost.title ?? '') === title &&
        current.activeResourceKey === activePostResourceKey(current.activePost)

      if (!scope || targetLang !== scope.language || !activeMatches) {
        cancelTitleTranslation()
        return
      }

      const source = title
      const resourceKey = current.activeResourceKey
      if (!source.trim() || !shouldTranslate(source, targetLang)) {
        cancelTitleTranslation()
        titleOwnerScopeRef.current = scope.key
        titleOwnerResourceRef.current = resourceKey
        setTitleTranslationResolvedState(true)
        return
      }

      const cacheKey = laneKey(postId, targetLang)
      const requestKey = laneKey(scope.key, resourceKey, targetLang, source)
      const existing = activeTitleRef.current
      if (
        existing &&
        existing.key === requestKey &&
        existing.resourceKey === resourceKey &&
        sameScope(existing.scope, scope)
      ) {
        return existing.promise
      }

      abortRequest(existing, 'Title translation superseded')
      activeTitleRef.current = null

      const cached = titleCacheRef.current.get(cacheKey)
      if (
        cached &&
        cached.source === source &&
        cached.sourceRevision === title &&
        cached.targetLang === targetLang
      ) {
        titleOwnerScopeRef.current = scope.key
        titleOwnerResourceRef.current = resourceKey
        setTranslatedTitleState(cached.translatedText)
        setTranslatingTitleState(false)
        setTitleTranslationResolvedState(true)
        revealAutomaticTranslation()
        return
      }

      titleCacheRef.current.delete(cacheKey)
      titleOwnerScopeRef.current = scope.key
      titleOwnerResourceRef.current = resourceKey
      setTranslatedTitleState(null)
      setTranslatingTitleState(true)
      setTitleTranslationResolvedState(false)

      const controller = new AbortController()
      const sequence = ++sequenceRef.current
      const promise = (async () => {
        try {
          const receipt = await requestIsolatedTitleTranslation(
            {
              id: 'title',
              text: source,
              targetLang,
              contentType: 'post_title',
              contentId: postId,
            },
            scope,
            controller.signal
          )
          const active = activeTitleRef.current
          if (
            !active ||
            active.sequence !== sequence ||
            active.resourceKey !== renderRef.current.activeResourceKey ||
            renderRef.current.activeResourceKey !== resourceKey ||
            !isScopeCurrent(scope)
          ) {
            return
          }

          if (receipt.sameLanguage) {
            titleCacheRef.current.delete(cacheKey)
            setTranslatedTitleState(null)
            setTitleTranslationResolvedState(true)
            return
          }

          putBounded(titleCacheRef.current, cacheKey, {
            source,
            sourceRevision: title,
            targetLang,
            translatedText: receipt.translatedText,
          })
          titleOwnerScopeRef.current = scope.key
          titleOwnerResourceRef.current = resourceKey
          setTranslatedTitleState(receipt.translatedText)
          setTitleTranslationResolvedState(true)
          revealAutomaticTranslation()
        } catch {
          const active = activeTitleRef.current
          if (
            active?.sequence === sequence &&
            active.resourceKey === renderRef.current.activeResourceKey &&
            isScopeCurrent(scope) &&
            !controller.signal.aborted
          ) {
            setTranslatedTitleState(null)
            setTitleTranslationResolvedState(false)
            showToast(t('translationServiceError'), 'error')
          }
        } finally {
          const active = activeTitleRef.current
          if (
            active?.sequence === sequence &&
            active.resourceKey === renderRef.current.activeResourceKey &&
            isScopeCurrent(scope)
          ) {
            activeTitleRef.current = null
            setTranslatingTitleState(false)
          }
        }
      })()
      activeTitleRef.current = {
        key: requestKey,
        sequence,
        scope,
        resourceKey,
        controller,
        promise,
      }
      return promise
    },
    [
      abortRequest,
      cancelTitleTranslation,
      captureScope,
      isScopeCurrent,
      revealAutomaticTranslation,
      showToast,
      t,
    ]
  )

  const translateContent = useCallback(
    async (postId: string, content: string, targetLang: TranslationTargetLanguage) => {
      const scope = captureScope()
      const current = renderRef.current
      const expectedResourceKey = activePostResourceKey({ id: postId, content })
      const activeMatches =
        current.activePost?.id === postId &&
        (current.activePost.content ?? '') === content &&
        current.activeResourceKey === activePostResourceKey(current.activePost)

      if (!scope || targetLang !== scope.language || !activeMatches) {
        cancelContentTranslation()
        return
      }

      const source = removeImagesFromContent(content)
      const resourceKey = current.activeResourceKey
      if (!source || !shouldTranslate(source, targetLang)) {
        abortRequest(activeContentRef.current, 'Content translation settled as source')
        activeContentRef.current = null
        contentOwnerScopeRef.current = scope.key
        contentOwnerResourceRef.current = resourceKey
        setTranslatedContentState(null)
        setTranslatingState(false)
        setTranslatingContentPostIdState(null)
        setContentTranslationResolvedState(true)
        return
      }

      const images = extractImagesFromContent(content)
      const cacheKey = laneKey(postId, targetLang)
      const requestKey = laneKey(scope.key, resourceKey, expectedResourceKey, targetLang, source)
      const existing = activeContentRef.current
      if (
        existing &&
        existing.key === requestKey &&
        existing.resourceKey === resourceKey &&
        sameScope(existing.scope, scope)
      ) {
        return existing.promise
      }

      abortRequest(existing, 'Content translation superseded')
      activeContentRef.current = null

      const cached = contentCacheRef.current.get(cacheKey)
      if (
        cached &&
        cached.source === source &&
        cached.sourceRevision === content &&
        cached.targetLang === targetLang
      ) {
        contentOwnerScopeRef.current = scope.key
        contentOwnerResourceRef.current = resourceKey
        setTranslatedContentState(appendImages(cached.translatedText, images))
        setTranslatingState(false)
        setTranslatingContentPostIdState(null)
        setContentTranslationResolvedState(true)
        revealAutomaticTranslation()
        return
      }
      contentCacheRef.current.delete(cacheKey)
      contentOwnerScopeRef.current = scope.key
      contentOwnerResourceRef.current = resourceKey
      setTranslatedContentState(null)
      setTranslatingState(true)
      setTranslatingContentPostIdState(postId)
      setContentTranslationResolvedState(false)

      const controller = new AbortController()
      const sequence = ++sequenceRef.current
      const promise = (async () => {
        try {
          const receipt = (
            await requestSharedTranslations(
              [
                {
                  id: 'content',
                  text: source,
                  targetLang,
                  contentType: 'post_content',
                  contentId: postId,
                },
              ],
              scope,
              'single',
              controller.signal
            )
          ).content
          const active = activeContentRef.current
          if (
            !active ||
            active.sequence !== sequence ||
            active.resourceKey !== renderRef.current.activeResourceKey ||
            renderRef.current.activeResourceKey !== resourceKey ||
            !isScopeCurrent(scope)
          ) {
            return
          }

          if (receipt.sameLanguage) {
            contentCacheRef.current.delete(cacheKey)
            setTranslatedContentState(null)
            setContentTranslationResolvedState(true)
            return
          }

          putBounded(contentCacheRef.current, cacheKey, {
            source,
            sourceRevision: content,
            targetLang,
            translatedText: receipt.translatedText,
          })
          contentOwnerScopeRef.current = scope.key
          contentOwnerResourceRef.current = resourceKey
          setTranslatedContentState(appendImages(receipt.translatedText, images))
          setContentTranslationResolvedState(true)
          revealAutomaticTranslation()
        } catch {
          const active = activeContentRef.current
          if (
            active?.sequence === sequence &&
            active.resourceKey === renderRef.current.activeResourceKey &&
            isScopeCurrent(scope) &&
            !controller.signal.aborted
          ) {
            setTranslatedContentState(null)
            setContentTranslationResolvedState(false)
            showToast(t('translationServiceError'), 'error')
          }
        } finally {
          const active = activeContentRef.current
          if (
            active?.sequence === sequence &&
            active.resourceKey === renderRef.current.activeResourceKey &&
            isScopeCurrent(scope)
          ) {
            activeContentRef.current = null
            setTranslatingState(false)
            setTranslatingContentPostIdState(null)
          }
        }
      })()
      activeContentRef.current = {
        key: requestKey,
        sequence,
        scope,
        resourceKey,
        controller,
        promise,
      }
      return promise
    },
    [
      abortRequest,
      cancelContentTranslation,
      captureScope,
      extractImagesFromContent,
      isScopeCurrent,
      removeImagesFromContent,
      revealAutomaticTranslation,
      showToast,
      t,
    ]
  )

  const translateListPosts = useCallback(
    async (
      postsToTranslate: readonly TranslatablePost[],
      targetLang: TranslationTargetLanguage
    ) => {
      const scope = captureScope()
      const resourceKey = listResourceKey(postsToTranslate)
      if (
        !scope ||
        targetLang !== scope.language ||
        resourceKey !== renderRef.current.listResourceKey
      ) {
        cancelListTranslation()
        return
      }

      const seenPostIds = new Set<string>()
      const descriptors: ListDescriptor[] = []
      const base: Record<string, { title?: string; body?: string }> = {}

      const addPart = (postId: string, part: ListPart, source: string, sourceRevision: string) => {
        const partLaneKey = laneKey(postId, part)
        const cached = listCacheRef.current.get(partLaneKey)
        if (!source || !shouldTranslate(source, targetLang)) {
          listCacheRef.current.delete(partLaneKey)
          return
        }
        if (
          cached &&
          cached.source === source &&
          cached.sourceRevision === sourceRevision &&
          cached.targetLang === targetLang
        ) {
          base[postId] = { ...base[postId], [part]: cached.translatedText }
          return
        }
        listCacheRef.current.delete(partLaneKey)
        descriptors.push({
          item: {
            id: `item-${descriptors.length}`,
            text: source,
            contentType: part === 'title' ? 'post_title' : 'post_content',
            contentId: postId,
            targetLang,
          },
          postId,
          part,
          laneKey: partLaneKey,
          sourceRevision,
        })
      }

      for (const post of postsToTranslate) {
        if (!post.id || seenPostIds.has(post.id)) {
          cancelListTranslation(resourceKey)
          return
        }
        seenPostIds.add(post.id)
        const title = post.title ?? ''
        const content = post.content ?? ''
        addPart(post.id, 'title', title, title)
        addPart(post.id, 'body', removeImagesFromContent(content), content)
      }

      const requestKey = JSON.stringify({
        scope: scope.key,
        resourceKey,
        targetLang,
        items: descriptors.map((descriptor) => [
          descriptor.item.id,
          descriptor.postId,
          descriptor.part,
          descriptor.item.text,
          descriptor.sourceRevision,
        ]),
      })
      const existing = activeListRef.current
      if (
        descriptors.length > 0 &&
        existing &&
        existing.key === requestKey &&
        existing.resourceKey === resourceKey &&
        sameScope(existing.scope, scope)
      ) {
        return existing.promise
      }

      abortRequest(existing, 'List translation superseded')
      activeListRef.current = null
      listOwnerScopeRef.current = scope.key
      listOwnerResourceRef.current = resourceKey
      setTranslatedListPostsState(base)

      if (descriptors.length === 0) {
        setTranslatingListLanesState({})
        return
      }

      setTranslatingListLanesState(listBusyLanes(descriptors))
      const controller = new AbortController()
      const sequence = ++sequenceRef.current
      const promise = (async () => {
        try {
          const receipt = await requestSharedTranslations(
            descriptors.map((descriptor) => descriptor.item),
            scope,
            'batch',
            controller.signal
          )
          const active = activeListRef.current
          if (
            !active ||
            active.sequence !== sequence ||
            active.resourceKey !== renderRef.current.listResourceKey ||
            renderRef.current.listResourceKey !== resourceKey ||
            !isScopeCurrent(scope)
          ) {
            return
          }

          const staged = { ...base }
          const stagedCache: Array<[string, CachedTranslation]> = []
          for (const descriptor of descriptors) {
            const result = receipt[descriptor.item.id]
            if (result.sameLanguage) continue
            staged[descriptor.postId] = {
              ...staged[descriptor.postId],
              [descriptor.part]: result.translatedText,
            }
            stagedCache.push([
              descriptor.laneKey,
              {
                source: descriptor.item.text,
                sourceRevision: descriptor.sourceRevision,
                targetLang,
                translatedText: result.translatedText,
              },
            ])
          }
          for (const [key, value] of stagedCache) putBounded(listCacheRef.current, key, value)
          listOwnerScopeRef.current = scope.key
          listOwnerResourceRef.current = resourceKey
          setTranslatedListPostsState(staged)
        } catch {
          if (!controller.signal.aborted) {
            controller.abort(new DOMException('Atomic list translation failed', 'AbortError'))
          }
          // All chunks stage locally. A failure publishes none of their new results.
        } finally {
          const active = activeListRef.current
          if (
            active?.sequence === sequence &&
            active.resourceKey === renderRef.current.listResourceKey &&
            isScopeCurrent(scope)
          ) {
            activeListRef.current = null
            setTranslatingListLanesState({})
          }
        }
      })()
      activeListRef.current = {
        key: requestKey,
        sequence,
        scope,
        resourceKey,
        controller,
        promise,
      }
      return promise
    },
    [abortRequest, cancelListTranslation, captureScope, isScopeCurrent, removeImagesFromContent]
  )

  const translateComments = useCallback(
    async (commentsToTranslate: readonly Comment[], targetLang: TranslationTargetLanguage) => {
      const scope = captureScope()
      const activePostId = renderRef.current.activePost?.id
      const resourceKey = commentsResourceKey(commentsToTranslate, activePostId)
      if (
        !scope ||
        targetLang !== scope.language ||
        resourceKey !== renderRef.current.commentsResourceKey
      ) {
        cancelCommentTranslation()
        return
      }

      const candidates = flattenComments(commentsToTranslate)
      if (!candidates) {
        cancelCommentTranslation(resourceKey)
        return
      }
      const descriptors: CommentDescriptor[] = []
      const base: Record<string, string> = {}
      for (const comment of candidates) {
        const source = comment.content ?? ''
        const commentLaneKey = laneKey(activePostId ?? 'closed', comment.id)
        const cached = commentCacheRef.current.get(commentLaneKey)
        if (!source || !shouldTranslate(source, targetLang)) {
          commentCacheRef.current.delete(commentLaneKey)
          continue
        }
        if (
          cached &&
          cached.source === source &&
          cached.sourceRevision === source &&
          cached.targetLang === targetLang
        ) {
          base[comment.id] = cached.translatedText
          continue
        }
        commentCacheRef.current.delete(commentLaneKey)
        descriptors.push({
          item: {
            id: `item-${descriptors.length}`,
            text: source,
            contentType: 'comment',
            contentId: comment.id,
            targetLang,
          },
          commentId: comment.id,
          laneKey: commentLaneKey,
        })
      }

      const requestKey = JSON.stringify({
        scope: scope.key,
        resourceKey,
        targetLang,
        items: descriptors.map((descriptor) => [
          descriptor.item.id,
          descriptor.commentId,
          descriptor.item.text,
        ]),
      })
      const existing = activeCommentsRef.current
      if (
        descriptors.length > 0 &&
        existing &&
        existing.key === requestKey &&
        existing.resourceKey === resourceKey &&
        sameScope(existing.scope, scope)
      ) {
        return existing.promise
      }

      abortRequest(existing, 'Comment translation superseded')
      activeCommentsRef.current = null
      commentsOwnerScopeRef.current = scope.key
      commentsOwnerResourceRef.current = resourceKey
      setTranslatedCommentsState(base)

      if (descriptors.length === 0) {
        setTranslatingCommentLanesState({})
        return
      }

      setTranslatingCommentLanesState(commentBusyLanes(descriptors))
      const controller = new AbortController()
      const sequence = ++sequenceRef.current
      const promise = (async () => {
        try {
          const receipt = await requestSharedTranslations(
            descriptors.map((descriptor) => descriptor.item),
            scope,
            'batch',
            controller.signal
          )
          const active = activeCommentsRef.current
          if (
            !active ||
            active.sequence !== sequence ||
            active.resourceKey !== renderRef.current.commentsResourceKey ||
            renderRef.current.commentsResourceKey !== resourceKey ||
            !isScopeCurrent(scope)
          ) {
            return
          }

          const staged = { ...base }
          const stagedCache: Array<[string, CachedTranslation]> = []
          for (const descriptor of descriptors) {
            const result = receipt[descriptor.item.id]
            if (result.sameLanguage) continue
            staged[descriptor.commentId] = result.translatedText
            stagedCache.push([
              descriptor.laneKey,
              {
                source: descriptor.item.text,
                sourceRevision: descriptor.item.text,
                targetLang,
                translatedText: result.translatedText,
              },
            ])
          }
          for (const [key, value] of stagedCache) putBounded(commentCacheRef.current, key, value)
          commentsOwnerScopeRef.current = scope.key
          commentsOwnerResourceRef.current = resourceKey
          setTranslatedCommentsState(staged)
        } catch {
          if (!controller.signal.aborted) {
            controller.abort(new DOMException('Atomic comment translation failed', 'AbortError'))
          }
          // All chunks stage locally. A failure publishes none of their new results.
        } finally {
          const active = activeCommentsRef.current
          if (
            active?.sequence === sequence &&
            active.resourceKey === renderRef.current.commentsResourceKey &&
            isScopeCurrent(scope)
          ) {
            activeCommentsRef.current = null
            setTranslatingCommentLanesState({})
          }
        }
      })()
      activeCommentsRef.current = {
        key: requestKey,
        sequence,
        scope,
        resourceKey,
        controller,
        promise,
      }
      return promise
    },
    [abortRequest, cancelCommentTranslation, captureScope, isScopeCurrent]
  )

  const contentIsCurrent =
    contentOwnerScopeRef.current === renderScopeKey &&
    contentOwnerResourceRef.current === renderActiveResourceKey
  const titleIsCurrent =
    titleOwnerScopeRef.current === renderScopeKey &&
    titleOwnerResourceRef.current === renderActiveResourceKey
  const listIsCurrent =
    listOwnerScopeRef.current === renderScopeKey &&
    listOwnerResourceRef.current === renderListResourceKey
  const commentsAreCurrent =
    commentsOwnerScopeRef.current === renderScopeKey &&
    commentsOwnerResourceRef.current === renderCommentsResourceKey

  const translatedContent = contentIsCurrent ? translatedContentState : null
  const showingOriginal = contentIsCurrent ? showingOriginalState : true
  const translating = contentIsCurrent ? translatingState : false
  const translatingContentPostId = contentIsCurrent ? translatingContentPostIdState : null
  const contentTranslationResolved = contentIsCurrent ? contentTranslationResolvedState : false
  const translatedTitle = titleIsCurrent ? translatedTitleState : null
  const translatingTitle = titleIsCurrent ? translatingTitleState : false
  const titleTranslationResolved = titleIsCurrent ? titleTranslationResolvedState : false
  const translatedListPosts = listIsCurrent ? translatedListPostsState : {}
  const translatingListLanes = listIsCurrent ? translatingListLanesState : {}
  const translatedComments = commentsAreCurrent ? translatedCommentsState : {}
  const translatingCommentLanes = commentsAreCurrent ? translatingCommentLanesState : {}

  return {
    translatedContent,
    setTranslatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    translatingContentPostId,
    contentTranslationResolved,
    translatedTitle,
    translatingTitle,
    titleTranslationResolved,
    translatedListPosts,
    translatingList: Object.keys(translatingListLanes).length > 0,
    translatingListLanes,
    translatedComments,
    translatingComments: Object.keys(translatingCommentLanes).length > 0,
    translatingCommentLanes,
    needsTranslation,
    extractImagesFromContent,
    removeImagesFromContent,
    cancelContentTranslation,
    cancelTitleTranslation,
    cancelActivePostTranslations,
    translateTitle,
    translateContent,
    translateListPosts,
    translateComments,
  }
}
