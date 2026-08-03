import type { z } from 'zod'
import { getCsrfHeaders } from '@/lib/api/csrf'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import { jwtSubject } from '@/lib/auth/token-subject'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import {
  PostCreateApiSuccessSchema,
  PostCreateRequestSchema,
  type PostCreateApiSuccess,
  type PostCreateRequest,
} from '@/lib/posts/post-create-contract'

type PostCreateRequestInput = z.input<typeof PostCreateRequestSchema>

export type PostCreateIntentInput = Omit<PostCreateRequestInput, 'operation_id'> & {
  operation_id?: never
}

export type PostCreateRequestWithOperation = Omit<PostCreateRequest, 'operation_id'> & {
  operation_id: string
}

export type BoundPostCreateOperation = Readonly<{
  fingerprint: string
  request: Readonly<PostCreateRequestWithOperation>
}>

export type PostCreatePublishResult =
  | {
      status: 'created' | 'replayed'
      data: PostCreateApiSuccess['data']
    }
  | {
      status: 'superseded'
      error: 'Authentication scope changed'
    }
  | {
      status: 'failed'
      httpStatus: number
      error: string
    }
  | {
      status: 'invalid_ack'
      httpStatus: number
      error: 'Invalid post creation acknowledgement'
    }

type PostCreateFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>

type UuidFactory = () => string

const SAFE_ERROR_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

function defaultUuidFactory(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

function hasOwnOperationId(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'operation_id')
  )
}

/**
 * Serialize the server-visible post intent in one fixed field order. Optional
 * nulls are canonicalized because the create authority gives them the same
 * meaning, while image and poll-option order remains significant.
 */
function postCreateFingerprint(intent: PostCreateRequest): string {
  return JSON.stringify([
    'post-create:v1',
    intent.title,
    intent.content,
    intent.group_id ?? null,
    intent.images,
    intent.poll_enabled,
    intent.poll_options ?? null,
    intent.poll_type ?? null,
    intent.poll_duration_hours ?? null,
    intent.visibility,
    intent.is_sensitive,
    intent.content_warning ?? null,
  ])
}

function freezeRequest(request: PostCreateRequestWithOperation): PostCreateRequestWithOperation {
  Object.freeze(request.images)
  if (request.poll_options) Object.freeze(request.poll_options)
  return Object.freeze(request)
}

/**
 * Bind an idempotency key to one immutable, normalized publishing intent.
 * Retrying the same intent reuses the key; changing any server-visible field
 * creates a new operation.
 */
export function bindPostCreateOperation(
  intentWithoutOperation: PostCreateIntentInput,
  previous?: BoundPostCreateOperation | null,
  uuidFactory: UuidFactory = defaultUuidFactory
): BoundPostCreateOperation {
  if (hasOwnOperationId(intentWithoutOperation)) {
    throw new TypeError('Post creation intent must not include operation_id')
  }

  const normalized = PostCreateRequestSchema.parse(intentWithoutOperation)
  const fingerprint = postCreateFingerprint(normalized)
  if (previous?.fingerprint === fingerprint) return previous

  const request = PostCreateRequestSchema.parse({
    ...normalized,
    operation_id: uuidFactory(),
  })
  if (!request.operation_id) throw new TypeError('Post creation operation_id is required')

  const bound = Object.freeze({
    fingerprint,
    request: freezeRequest(request as PostCreateRequestWithOperation),
  })
  return bound
}

function supersededResult(): PostCreatePublishResult {
  return { status: 'superseded', error: 'Authentication scope changed' }
}

function failedResult(httpStatus: number, error: string): PostCreatePublishResult {
  return { status: 'failed', httpStatus, error }
}

function readSafeError(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as Record<string, unknown>).error
  const candidate =
    typeof error === 'string'
      ? error
      : error !== null && typeof error === 'object' && !Array.isArray(error)
        ? (error as Record<string, unknown>).message
        : null
  if (typeof candidate !== 'string') return null

  const normalized = candidate.trim().normalize('NFC')
  if (!normalized || normalized.length > 200 || SAFE_ERROR_CONTROL_PATTERN.test(normalized)) {
    return null
  }
  return normalized
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function acknowledgementMatchesRequest(
  acknowledgement: PostCreateApiSuccess,
  request: PostCreateRequestWithOperation,
  actorId: string
): boolean {
  const { operation, post, poll } = acknowledgement.data
  if (
    operation.operation_id !== request.operation_id ||
    post.author_id !== actorId ||
    post.group_id !== (request.group_id ?? null) ||
    post.visibility !== request.visibility ||
    !arraysEqual(post.images, request.images) ||
    post.poll_enabled !== request.poll_enabled ||
    post.is_sensitive !== request.is_sensitive ||
    post.content_warning !== (request.content_warning ?? null)
  ) {
    return false
  }

  if (!request.poll_enabled || request.poll_options === undefined) {
    return poll === null && post.poll_id === null
  }
  if (
    poll === null ||
    post.poll_id !== poll.id ||
    poll.type !== request.poll_type ||
    poll.options.length !== request.poll_options.length
  ) {
    return false
  }

  for (let index = 0; index < request.poll_options.length; index += 1) {
    const option = poll.options[index]
    if (
      option.text !== request.poll_options[index] ||
      option.index !== index ||
      option.votes !== 0
    ) {
      return false
    }
  }

  return request.poll_duration_hours === 0 ? poll.end_at === null : poll.end_at !== null
}

/**
 * Publish through the authenticated API authority and accept success only
 * while the captured viewer still owns the request and every response echo.
 */
export async function publishPostAtomic(
  inputWithRequiredOperationId: PostCreateRequestWithOperation,
  capturedViewerScope: ViewerScope,
  fetchImpl: PostCreateFetch = fetch
): Promise<PostCreatePublishResult> {
  const parsed = PostCreateRequestSchema.safeParse(inputWithRequiredOperationId)
  if (!parsed.success || !parsed.data.operation_id) {
    return failedResult(0, 'Invalid post creation request')
  }
  const request = parsed.data as PostCreateRequestWithOperation

  if (!capturedViewerScope.userId || !isViewerScopeCurrent(capturedViewerScope)) {
    return supersededResult()
  }

  let accessToken: string | null
  try {
    accessToken = await tokenRefreshCoordinator.getValidToken({
      expectedUserId: capturedViewerScope.userId,
      sessionGeneration: capturedViewerScope.sessionGeneration,
    })
  } catch {
    return isViewerScopeCurrent(capturedViewerScope)
      ? failedResult(401, 'Authentication is unavailable')
      : supersededResult()
  }

  if (
    !accessToken ||
    jwtSubject(accessToken) !== capturedViewerScope.userId ||
    !isViewerScopeCurrent(capturedViewerScope)
  ) {
    return supersededResult()
  }

  let response: Pick<Response, 'json' | 'ok' | 'status'>
  let payload: unknown
  try {
    response = await fetchImpl('/api/posts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        ...getCsrfHeaders(),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(request),
    })
    payload = await response.json().catch(() => null)
  } catch {
    return isViewerScopeCurrent(capturedViewerScope)
      ? failedResult(0, 'Post publishing failed')
      : supersededResult()
  }

  if (!isViewerScopeCurrent(capturedViewerScope)) return supersededResult()

  const isSuccessfulStatus = response.ok && response.status >= 200 && response.status < 300
  if (!isSuccessfulStatus) {
    return failedResult(response.status, readSafeError(payload) ?? 'Post publishing failed')
  }

  const acknowledgement = PostCreateApiSuccessSchema.safeParse(payload)
  if (!acknowledgement.success) {
    return {
      status: 'invalid_ack',
      httpStatus: response.status,
      error: 'Invalid post creation acknowledgement',
    }
  }

  const operationStatus = acknowledgement.data.data.operation.status
  const expectedHttpStatus = operationStatus === 'created' ? 201 : 200
  if (
    response.status !== expectedHttpStatus ||
    !acknowledgementMatchesRequest(acknowledgement.data, request, capturedViewerScope.userId)
  ) {
    return {
      status: 'invalid_ack',
      httpStatus: response.status,
      error: 'Invalid post creation acknowledgement',
    }
  }

  return { status: operationStatus, data: acknowledgement.data.data }
}
