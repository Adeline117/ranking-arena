import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/lib/supabase/database.types'
import {
  AtomicCreatePostAckSchema,
  PostCreateRequestSchema,
  type AtomicCreatePostAck,
} from '@/lib/posts/post-create-contract'
import { sanitizeInput, sanitizeText } from '@/lib/utils/sanitize'
import { detectPostLanguage } from '@/lib/data/posts'
import { extractHashtags } from '@/lib/data/hashtags'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { del as cacheDel } from '@/lib/cache'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { extractMentionHandles } from '@/lib/posts/mentions'
import { schedulePostMentionNotifications } from '@/lib/posts/post-mention-notifications'

const MAX_DERIVED_TERMS = 50
const AUTHORITY_UNAVAILABLE_CODES = new Set([
  'PGRST202',
  'PGRST205',
  '42883',
  '42P01',
  '42703',
  '55P03',
  '57014',
])
const FAILURE_STATUSES = new Set([
  'invalid',
  'account_inactive',
  'group_not_found',
  'group_unavailable',
  'membership_required',
  'group_banned',
  'group_muted',
  'entitlement_required',
  'operation_conflict',
])
const logger = createLogger('post-create')

type PostCreateRpcClient = SupabaseClient<Database>

export type PreparedPostCreate = {
  operationId: string
  title: string
  content: string
  groupId: string | null
  visibility: 'public' | 'followers' | 'group'
  images: string[]
  isSensitive: boolean
  contentWarning: string | null
  language: 'zh' | 'en' | 'ja' | 'ko'
  pollEnabled: boolean
  pollOptions: string[] | null
  pollType: 'single' | 'multiple' | null
  pollDurationHours: number | null
  mentionHandles: string[]
  hashtagTags: string[]
}

export type PostCreateExecutionResult =
  | { status: 'created' | 'replayed'; acknowledgement: AtomicCreatePostAck }
  | {
      status:
        | 'invalid'
        | 'account_inactive'
        | 'group_not_found'
        | 'group_unavailable'
        | 'membership_required'
        | 'group_banned'
        | 'group_muted'
        | 'entitlement_required'
        | 'operation_conflict'
    }
  | { status: 'authority_unavailable' | 'failed' | 'invalid_ack'; error?: unknown }

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readFailureStatus(value: unknown): PostCreateExecutionResult | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.status !== 'string') {
    return null
  }
  if (!FAILURE_STATUSES.has(value.status)) return null
  return { status: value.status } as PostCreateExecutionResult
}

function isAuthorityUnavailable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    AUTHORITY_UNAVAILABLE_CODES.has(error.code ?? '') ||
    Boolean(error.message?.includes('Could not find the function')) ||
    Boolean(error.message?.includes('schema cache'))
  )
}

export { extractMentionHandles } from '@/lib/posts/mentions'

export function preparePostCreate(value: unknown): PreparedPostCreate | null {
  const parsed = PostCreateRequestSchema.safeParse(value)
  if (!parsed.success) return null

  const title = sanitizeInput(parsed.data.title)
  const content = sanitizeText(parsed.data.content, { preserveNewlines: true })
  const contentWarning = parsed.data.content_warning
    ? sanitizeInput(parsed.data.content_warning)
    : null
  if (
    !title ||
    title.length > 200 ||
    !content ||
    content.length > 10_000 ||
    (parsed.data.content_warning && !contentWarning) ||
    (contentWarning?.length ?? 0) > 200
  ) {
    return null
  }

  const derivedText = `${title} ${content}`
  const detectedLanguage = detectPostLanguage(derivedText)
  if (!['zh', 'en', 'ja', 'ko'].includes(detectedLanguage)) return null

  return {
    operationId: parsed.data.operation_id ?? randomUUID(),
    title,
    content,
    groupId: parsed.data.group_id ?? null,
    visibility: parsed.data.visibility,
    images: parsed.data.images,
    isSensitive: parsed.data.is_sensitive,
    contentWarning,
    language: detectedLanguage as PreparedPostCreate['language'],
    pollEnabled: parsed.data.poll_enabled,
    pollOptions: parsed.data.poll_options ?? null,
    pollType: parsed.data.poll_options ? (parsed.data.poll_type ?? null) : null,
    pollDurationHours: parsed.data.poll_options ? (parsed.data.poll_duration_hours ?? null) : null,
    mentionHandles: extractMentionHandles(derivedText),
    hashtagTags: extractHashtags(derivedText).slice(0, MAX_DERIVED_TERMS).sort(),
  }
}

function acknowledgementMatchesInput(
  acknowledgement: AtomicCreatePostAck,
  actorId: string,
  input: PreparedPostCreate
): boolean {
  const post = acknowledgement.post
  if (
    acknowledgement.operation_id !== input.operationId ||
    acknowledgement.actor_id !== actorId ||
    post.author_id !== actorId ||
    post.group_id !== input.groupId ||
    post.title !== input.title ||
    post.content !== input.content ||
    !arraysEqual(post.images, input.images) ||
    post.poll_enabled !== input.pollEnabled ||
    post.visibility !== input.visibility ||
    post.is_sensitive !== input.isSensitive ||
    post.content_warning !== input.contentWarning ||
    post.language !== input.language ||
    post.content_version !== 0 ||
    !arraysEqual(post.hashtags, input.hashtagTags)
  ) {
    return false
  }

  const mentionCandidates = new Set(
    input.mentionHandles.map((handle) => handle.toLocaleLowerCase('und'))
  )
  const observedMentions = new Set<string>()
  for (const handle of post.mentions) {
    const key = handle.toLocaleLowerCase('und')
    if (!mentionCandidates.has(key) || observedMentions.has(key)) return false
    observedMentions.add(key)
  }

  if (input.pollOptions === null) {
    return acknowledgement.poll === null && post.poll_id === null
  }
  if (
    acknowledgement.poll === null ||
    post.poll_id !== acknowledgement.poll.id ||
    acknowledgement.poll.type !== input.pollType ||
    acknowledgement.poll.options.length !== input.pollOptions.length
  ) {
    return false
  }
  for (let index = 0; index < input.pollOptions.length; index += 1) {
    const option = acknowledgement.poll.options[index]
    if (option.text !== input.pollOptions[index] || option.index !== index || option.votes !== 0) {
      return false
    }
  }

  if (input.pollDurationHours === 0) return acknowledgement.poll.end_at === null
  if (input.pollDurationHours === null || acknowledgement.poll.end_at === null) return false
  const createdAt = Date.parse(post.created_at)
  const endAt = Date.parse(acknowledgement.poll.end_at)
  const expectedDurationMs = input.pollDurationHours * 60 * 60 * 1000
  return Math.abs(endAt - createdAt - expectedDurationMs) <= 5_000
}

export async function executeAtomicPostCreate(
  supabase: PostCreateRpcClient,
  actorId: string,
  input: PreparedPostCreate
): Promise<PostCreateExecutionResult> {
  let rpcResult
  try {
    rpcResult = await supabase.rpc('create_post_atomic', {
      p_actor_id: actorId,
      p_operation_id: input.operationId,
      p_title: input.title,
      p_content: input.content,
      p_group_id: input.groupId,
      p_visibility: input.visibility,
      p_images: input.images,
      p_is_sensitive: input.isSensitive,
      p_content_warning: input.contentWarning,
      p_language: input.language,
      p_poll_enabled: input.pollEnabled,
      p_poll_option_texts: input.pollOptions,
      p_poll_type: input.pollType,
      p_poll_duration_hours: input.pollDurationHours,
      p_mention_handles: input.mentionHandles,
      p_hashtag_tags: input.hashtagTags,
    })
  } catch (error) {
    return { status: 'authority_unavailable', error }
  }

  if (rpcResult.error) {
    if (isAuthorityUnavailable(rpcResult.error)) {
      return { status: 'authority_unavailable', error: rpcResult.error }
    }
    if (rpcResult.error.code === '42501') return { status: 'account_inactive' }
    if (rpcResult.error.code === '23514' || rpcResult.error.code === '22023') {
      return { status: 'invalid' }
    }
    return { status: 'failed', error: rpcResult.error }
  }

  const failure = readFailureStatus(rpcResult.data)
  if (failure) return failure

  const acknowledgement = AtomicCreatePostAckSchema.safeParse(rpcResult.data)
  if (!acknowledgement.success) return { status: 'invalid_ack' }
  if (!acknowledgementMatchesInput(acknowledgement.data, actorId, input)) {
    return { status: 'invalid_ack' }
  }
  return { status: acknowledgement.data.status, acknowledgement: acknowledgement.data }
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, error: message },
    { status, headers: { 'Cache-Control': 'private, no-store' } }
  )
}

function sendMentionNotificationsAfterCreate(
  supabase: PostCreateRpcClient,
  acknowledgement: AtomicCreatePostAck
): void {
  schedulePostMentionNotifications(
    supabase,
    {
      actorId: acknowledgement.actor_id,
      actorHandle: acknowledgement.post.author_handle,
      postId: acknowledgement.post.id,
      title: acknowledgement.post.title,
      content: acknowledgement.post.content,
      mentionHandles: acknowledgement.post.mentions,
    },
    'Resolve and deliver mention notifications after post create'
  )
}

export async function handleAtomicPostCreateHttp(options: {
  request: NextRequest
  supabase: PostCreateRpcClient
  actorId: string
}): Promise<NextResponse> {
  let body: unknown
  try {
    body = await options.request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const input = preparePostCreate(body)
  if (!input) return errorResponse('Invalid post creation request', 400)

  const result = await executeAtomicPostCreate(options.supabase, options.actorId, input)
  if (result.status === 'operation_conflict') {
    return errorResponse('This publish operation was already used for different content', 409)
  }
  if (result.status === 'group_not_found') return errorResponse('Group not found', 404)
  if (
    result.status === 'account_inactive' ||
    result.status === 'group_unavailable' ||
    result.status === 'membership_required' ||
    result.status === 'group_banned' ||
    result.status === 'group_muted' ||
    result.status === 'entitlement_required'
  ) {
    return errorResponse('No permission to publish this post', 403)
  }
  if (result.status === 'invalid') return errorResponse('Invalid post creation request', 400)
  if (result.status === 'authority_unavailable') {
    logger.error('Atomic post creation authority unavailable', {
      actorId: options.actorId,
      error: result.error,
    })
    return errorResponse('Post publishing is temporarily unavailable', 503)
  }
  if (result.status === 'failed' || result.status === 'invalid_ack') {
    logger.error('Atomic post creation failed closed', {
      actorId: options.actorId,
      status: result.status,
      error: result.error,
    })
    return errorResponse('Post publishing failed', 500)
  }
  if (result.status !== 'created' && result.status !== 'replayed') {
    logger.error('Atomic post creation returned an unmapped status', {
      actorId: options.actorId,
      status: result.status,
    })
    return errorResponse('Post publishing failed', 500)
  }

  const acknowledgement = result.acknowledgement
  deleteServerCacheByPrefix('posts:')
  fireAndForget(cacheDel('hot_posts:top50'), 'delete-hot-posts-cache')
  sendMentionNotificationsAfterCreate(options.supabase, acknowledgement)

  return NextResponse.json(
    {
      success: true,
      data: {
        post: acknowledgement.post,
        poll: acknowledgement.poll,
        operation: {
          status: acknowledgement.status,
          applied: acknowledgement.applied,
          operation_id: acknowledgement.operation_id,
        },
      },
    },
    {
      status: acknowledgement.applied ? 201 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    }
  )
}
