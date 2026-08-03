import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { Database } from '@/lib/supabase/database.types'
import { sanitizeInput, sanitizeText, sanitizeUrl } from '@/lib/utils/sanitize'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { createLogger } from '@/lib/utils/logger'
import { success } from '@/lib/api/response'
import { readPostEditRpcAcknowledgement, type PostEditPost } from '@/lib/posts/post-edit-contract'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TITLE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/
const CONTENT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const URL_CONTROL_OR_SPACE_PATTERN = /[\u0000-\u001f\u007f\s]/
const logger = createLogger('post-edit')

const ImageUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value === value.trim())
  .refine((value) => !URL_CONTROL_OR_SPACE_PATTERN.test(value))
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  })

const PostEditRequestSchema = z
  .object({
    title: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !TITLE_CONTROL_PATTERN.test(value)),
    content: z
      .string()
      .max(50000)
      .refine((value) => !CONTENT_CONTROL_PATTERN.test(value)),
    images: z.array(ImageUrlSchema).max(9).optional(),
    expected_version: z
      .number()
      .int()
      .nonnegative()
      .refine((value) => Number.isSafeInteger(value)),
  })
  .strict()
  .refine(
    (value) => value.images === undefined || new Set(value.images).size === value.images.length,
    { message: 'Duplicate images are not allowed', path: ['images'] }
  )

export type PreparedPostEdit = {
  title: string
  content: string
  images?: string[]
  expectedVersion: number
}

type PostEditRpcClient = Pick<SupabaseClient<Database>, 'rpc'>

export type PostEditExecutionResult =
  | { status: 'updated' | 'unchanged'; post: PostEditPost }
  | { status: 'invalid' | 'account_inactive' | 'not_found' | 'forbidden' | 'conflict' }
  | { status: 'authority_unavailable' | 'failed' | 'invalid_ack'; error?: unknown }

export function isPostId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

export function preparePostEdit(value: unknown): PreparedPostEdit | null {
  const parsed = PostEditRequestSchema.safeParse(value)
  if (!parsed.success) return null

  const title = sanitizeInput(parsed.data.title.trim(), { maxLength: 200 })
  if (!title || title.length > 200) return null

  const content = sanitizeText(parsed.data.content, {
    preserveNewlines: true,
    maxLength: 50000,
  })
  const images = parsed.data.images?.map(sanitizeUrl)
  if (
    images?.some((url) => !url) ||
    (images !== undefined && new Set(images).size !== images.length)
  ) {
    return null
  }

  return {
    title,
    content,
    ...(images !== undefined ? { images } : {}),
    expectedVersion: parsed.data.expected_version,
  }
}

function isAuthorityUnavailable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return (
    ['PGRST202', 'PGRST205', '42883', '42P01', '42703', '55P03', '57014'].includes(
      error.code ?? ''
    ) ||
    Boolean(error.message?.includes('Could not find the function')) ||
    Boolean(error.message?.includes('schema cache'))
  )
}

export async function executeAtomicPostEdit(
  supabase: PostEditRpcClient,
  actorId: string,
  postId: string,
  input: PreparedPostEdit
): Promise<PostEditExecutionResult> {
  let rpcResult
  try {
    rpcResult = await supabase.rpc('edit_post_atomic', {
      p_actor_id: actorId,
      p_post_id: postId,
      p_expected_version: input.expectedVersion,
      p_title: input.title,
      p_content: input.content,
      p_update_images: input.images !== undefined,
      p_images: input.images ?? null,
    })
  } catch (error) {
    return { status: 'authority_unavailable', error }
  }

  if (rpcResult.error) {
    if (isAuthorityUnavailable(rpcResult.error)) {
      return { status: 'authority_unavailable', error: rpcResult.error }
    }
    if (rpcResult.error.code === '42501') {
      return { status: 'forbidden' }
    }
    if (rpcResult.error.code === '40001') {
      return { status: 'conflict' }
    }
    return { status: 'failed', error: rpcResult.error }
  }

  const acknowledgement = readPostEditRpcAcknowledgement(rpcResult.data)
  if (!acknowledgement) return { status: 'invalid_ack' }
  if (acknowledgement.status !== 'updated' && acknowledgement.status !== 'unchanged') {
    return acknowledgement
  }

  const expectedImagesMatch =
    input.images === undefined ||
    (acknowledgement.post.images !== null &&
      acknowledgement.post.images.length === input.images.length &&
      acknowledgement.post.images.every((url, index) => url === input.images?.[index]))
  const expectedVersionMatches =
    acknowledgement.status === 'updated'
      ? acknowledgement.post.content_version === input.expectedVersion + 1
      : acknowledgement.post.content_version >= input.expectedVersion

  if (
    acknowledgement.actorId !== actorId ||
    acknowledgement.post.id !== postId ||
    acknowledgement.post.author_id !== actorId ||
    acknowledgement.post.title !== input.title ||
    acknowledgement.post.content !== input.content ||
    !expectedImagesMatch ||
    !expectedVersionMatches
  ) {
    return { status: 'invalid_ack' }
  }

  return { status: acknowledgement.status, post: acknowledgement.post }
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    { success: false, error: message },
    { status, headers: { 'Cache-Control': 'private, no-store' } }
  )
}

export async function handleAtomicPostEditHttp(options: {
  request: NextRequest
  supabase: PostEditRpcClient
  actorId: string
  postId: string
  envelope: 'direct' | 'standard'
}): Promise<NextResponse> {
  if (!isPostId(options.postId)) return errorResponse('Post not found', 404)

  let body: unknown
  try {
    body = await options.request.json()
  } catch {
    return errorResponse('Invalid JSON body', 400)
  }

  const input = preparePostEdit(body)
  if (!input) return errorResponse('Invalid post edit request', 400)

  const result = await executeAtomicPostEdit(
    options.supabase,
    options.actorId,
    options.postId,
    input
  )

  if (result.status === 'conflict') {
    return errorResponse('Post changed. Reload and retry.', 409)
  }
  if (result.status === 'not_found') return errorResponse('Post not found', 404)
  if (result.status === 'forbidden') return errorResponse('No permission to edit this post', 403)
  if (result.status === 'account_inactive') return errorResponse('Account is unavailable', 403)
  if (result.status === 'authority_unavailable') {
    logger.error('Atomic post edit authority unavailable', {
      error: result.error,
      actorId: options.actorId,
      postId: options.postId,
    })
    return errorResponse('Post editing is temporarily unavailable', 503)
  }
  if (
    result.status === 'invalid' ||
    result.status === 'invalid_ack' ||
    result.status === 'failed'
  ) {
    logger.error('Atomic post edit failed closed', {
      status: result.status,
      error: 'error' in result ? result.error : undefined,
      actorId: options.actorId,
      postId: options.postId,
    })
    return errorResponse('Post update failed', 500)
  }

  if (result.status !== 'updated' && result.status !== 'unchanged') {
    return errorResponse('Post update failed', 500)
  }

  if (result.status === 'updated') deleteServerCacheByPrefix('posts:')
  if (options.envelope === 'standard') {
    const response = success({ post: result.post })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
  return NextResponse.json(
    { success: true, post: result.post },
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}
