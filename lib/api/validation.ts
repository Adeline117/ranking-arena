/**
 * API Input Validation Utilities
 */

import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { ApiError, ErrorCode } from './errors'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { VersionContext } from './versioning'

// ============================================
// Basic validation functions
// ============================================

/**
 * Validate string
 */
export function validateString(
  value: unknown,
  options: {
    required?: boolean
    minLength?: number
    maxLength?: number
    pattern?: RegExp
    fieldName?: string
  } = {}
): string | null {
  const { required = false, minLength, maxLength, pattern, fieldName = 'field' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName} is required`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const str = String(value).trim()

  if (minLength !== undefined && str.length < minLength) {
    throw new ApiError(`${fieldName} must be at least ${minLength} characters`, {
      code: ErrorCode.VALUE_TOO_SHORT,
    })
  }

  if (maxLength !== undefined && str.length > maxLength) {
    throw new ApiError(`${fieldName} must not exceed ${maxLength} characters`, {
      code: ErrorCode.VALUE_TOO_LONG,
    })
  }

  if (pattern && !pattern.test(str)) {
    throw new ApiError(`${fieldName} format is invalid`, { code: ErrorCode.INVALID_FORMAT })
  }

  return str
}

/**
 * Validate number
 */
export function validateNumber(
  value: unknown,
  options: {
    required?: boolean
    min?: number
    max?: number
    integer?: boolean
    fieldName?: string
  } = {}
): number | null {
  const { required = false, min, max, integer = false, fieldName = 'field' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName} is required`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const num = Number(value)

  if (isNaN(num)) {
    throw new ApiError(`${fieldName} must be a valid number`, { code: ErrorCode.INVALID_FORMAT })
  }

  if (integer && !Number.isInteger(num)) {
    throw new ApiError(`${fieldName} must be an integer`, { code: ErrorCode.INVALID_FORMAT })
  }

  if (min !== undefined && num < min) {
    throw new ApiError(`${fieldName} must be at least ${min}`, { code: ErrorCode.VALUE_OUT_OF_RANGE })
  }

  if (max !== undefined && num > max) {
    throw new ApiError(`${fieldName} must not exceed ${max}`, { code: ErrorCode.VALUE_OUT_OF_RANGE })
  }

  return num
}

/**
 * Validate enum value
 */
export function validateEnum<T extends readonly string[]>(
  value: unknown,
  allowedValues: T,
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): T[number] | null {
  const { required = false, fieldName = 'field' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName} is required`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const str = String(value)

  if (!allowedValues.includes(str as T[number])) {
    throw new ApiError(`${fieldName} must be one of: ${allowedValues.join(', ')}`, {
      code: ErrorCode.INVALID_INPUT,
    })
  }

  return str as T[number]
}

/**
 * Validate UUID
 */
export function validateUUID(
  value: unknown,
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): string | null {
  const { required = false, fieldName = 'ID' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName} is required`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const str = String(value).trim()
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuidRegex.test(str)) {
    throw new ApiError(`${fieldName} format is invalid`, { code: ErrorCode.INVALID_FORMAT })
  }

  return str
}

/**
 * Validate boolean
 */
export function validateBoolean(
  value: unknown,
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): boolean | null {
  const { required = false, fieldName = 'field' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName} is required`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false

  throw new ApiError(`${fieldName} must be a boolean`, { code: ErrorCode.INVALID_FORMAT })
}

/**
 * Validate array
 */
export function validateArray<T>(
  value: unknown,
  itemValidator: (item: unknown, index: number) => T,
  options: {
    required?: boolean
    minLength?: number
    maxLength?: number
    fieldName?: string
  } = {}
): T[] | null {
  const { required = false, minLength, maxLength, fieldName = 'array' } = options

  if (value === null || value === undefined) {
    if (required) {
      throw new ApiError(`${fieldName} is required`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  if (!Array.isArray(value)) {
    throw new ApiError(`${fieldName} must be an array`, { code: ErrorCode.INVALID_FORMAT })
  }

  if (minLength !== undefined && value.length < minLength) {
    throw new ApiError(`${fieldName} must have at least ${minLength} items`, {
      code: ErrorCode.VALUE_TOO_SHORT,
    })
  }

  if (maxLength !== undefined && value.length > maxLength) {
    throw new ApiError(`${fieldName} must have at most ${maxLength} items`, {
      code: ErrorCode.VALUE_TOO_LONG,
    })
  }

  return value.map((item, index) => itemValidator(item, index))
}

// ============================================
// Zod Schema validation
// ============================================

/**
 * Validate data with Zod Schema
 */
export function validateWithSchema<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  options: {
    context?: string
  } = {}
): z.infer<T> {
  const result = schema.safeParse(data)

  if (!result.success) {
    const issues = (result.error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? []
    const errors = issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')

    throw new ApiError(
      options.context ? `[${options.context}] Validation failed: ${errors}` : `Validation failed: ${errors}`,
      {
        code: ErrorCode.VALIDATION_ERROR,
        details: {
          errors: issues.map((e) => ({
            path: e.path,
            message: e.message,
          })),
        },
      }
    )
  }

  return result.data
}

/**
 * Validate request body
 */
export async function validateRequestBody<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T
): Promise<z.infer<T>> {
  let body: unknown

  try {
    body = await request.json()
  } catch (_err) {
    throw new ApiError('Request body must be valid JSON', {
      code: ErrorCode.INVALID_FORMAT,
    })
  }

  return validateWithSchema(schema, body)
}

/**
 * Validate search params
 */
export function validateSearchParams<T extends z.ZodTypeAny>(
  searchParams: URLSearchParams,
  schema: T
): z.infer<T> {
  const params: Record<string, string | string[]> = {}

  searchParams.forEach((value, key) => {
    if (params[key]) {
      if (Array.isArray(params[key])) {
        (params[key] as string[]).push(value)
      } else {
        params[key] = [params[key] as string, value]
      }
    } else {
      params[key] = value
    }
  })

  return validateWithSchema(schema, params)
}

// ============================================
// Common Schemas
// ============================================

/** Pagination params Schema */
export const PaginationSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 20))
    .pipe(z.number().int().min(1).max(100)),
  offset: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 0))
    .pipe(z.number().int().min(0)),
})

/** ID param Schema */
export const IdParamSchema = z.object({
  id: z.string().uuid('Invalid ID format'),
})

/** Handle param Schema */
export const HandleParamSchema = z.object({
  handle: z.string().min(1, 'handle is required'),
})

/** Sort params Schema */
export const SortSchema = z.object({
  sort_by: z.string().optional(),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
})

// ============================================
// Middleware wrappers — Zod-based request validation
// ============================================

/**
 * Context passed to validated handlers (mirrors ApiContext from middleware.ts)
 */
interface ValidatedApiContext {
  user?: User | null
  supabase: ReturnType<typeof getSupabaseAdmin>
  request: NextRequest
  version: VersionContext
}

/**
 * Format Zod errors into clean, field-level error objects.
 * Never leaks internals (no stack traces, no schema details).
 */
function formatZodErrors(error: z.ZodError): {
  message: string
  fieldErrors: Array<{ field: string; message: string }>
} {
  const fieldErrors = error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '_root',
    message: issue.message,
  }))

  // Build a human-readable summary (max 3 fields to avoid leaking schema shape)
  const summary = fieldErrors
    .slice(0, 3)
    .map((e) => `${e.field}: ${e.message}`)
    .join('; ')
  const extra = fieldErrors.length > 3 ? ` (+${fieldErrors.length - 3} more)` : ''

  return {
    message: `Validation failed: ${summary}${extra}`,
    fieldErrors,
  }
}

/**
 * Create a 422 Unprocessable Entity response with field-level errors.
 */
function validationErrorResponse(zodError: z.ZodError): NextResponse {
  const { message, fieldErrors } = formatZodErrors(zodError)
  return NextResponse.json(
    {
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message,
        details: { fieldErrors },
        timestamp: new Date().toISOString(),
      },
    },
    { status: 422 }
  )
}

/**
 * Middleware wrapper: validates JSON request body against a Zod schema.
 *
 * On validation failure, returns 422 with field-level errors immediately
 * (the handler is never called). On success, passes the validated data
 * as `body` in the handler context.
 *
 * Composes with `withApiMiddleware` — use it *inside* the handler:
 *
 * @example
 * ```ts
 * import { withApiMiddleware } from '@/lib/api/middleware'
 * import { withValidation, CreatePostBodySchema } from '@/lib/api/validation'
 *
 * export const POST = withApiMiddleware(
 *   withValidation(CreatePostBodySchema, async ({ body, user, supabase }) => {
 *     // body is fully typed and validated
 *     const post = await createPost(supabase, user!.id, body.title, body.content)
 *     return { post }
 *   }),
 *   { requireAuth: true, rateLimit: 'write' }
 * )
 * ```
 */
export function withValidation<T extends z.ZodTypeAny>(
  schema: T,
  handler: (ctx: ValidatedApiContext & { body: z.infer<T> }) => Promise<NextResponse | unknown>
): (ctx: ValidatedApiContext) => Promise<NextResponse | unknown> {
  return async (ctx) => {
    let rawBody: unknown
    try {
      rawBody = await ctx.request.json()
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: ErrorCode.INVALID_FORMAT,
            message: 'Request body must be valid JSON',
            timestamp: new Date().toISOString(),
          },
        },
        { status: 422 }
      )
    }

    const result = schema.safeParse(rawBody)
    if (!result.success) {
      return validationErrorResponse(result.error as z.ZodError)
    }

    return handler({ ...ctx, body: result.data })
  }
}

/**
 * Middleware wrapper: validates URL query/search params against a Zod schema.
 *
 * Parses `request.nextUrl.searchParams` into a plain object and validates
 * against the provided schema. On failure, returns 422 with field-level errors.
 *
 * @example
 * ```ts
 * import { withApiMiddleware } from '@/lib/api/middleware'
 * import { withQueryValidation, SearchQuerySchema } from '@/lib/api/validation'
 *
 * export const GET = withApiMiddleware(
 *   withQueryValidation(SearchQuerySchema, async ({ query, supabase }) => {
 *     // query is fully typed and validated
 *     const results = await search(supabase, query.q, query.limit)
 *     return { results }
 *   }),
 *   { rateLimit: 'public' }
 * )
 * ```
 */
export function withQueryValidation<T extends z.ZodTypeAny>(
  schema: T,
  handler: (ctx: ValidatedApiContext & { query: z.infer<T> }) => Promise<NextResponse | unknown>
): (ctx: ValidatedApiContext) => Promise<NextResponse | unknown> {
  return async (ctx) => {
    const rawParams: Record<string, string | string[]> = {}

    ctx.request.nextUrl.searchParams.forEach((value, key) => {
      const existing = rawParams[key]
      if (existing !== undefined) {
        if (Array.isArray(existing)) {
          existing.push(value)
        } else {
          rawParams[key] = [existing, value]
        }
      } else {
        rawParams[key] = value
      }
    })

    const result = schema.safeParse(rawParams)
    if (!result.success) {
      return validationErrorResponse(result.error as z.ZodError)
    }

    return handler({ ...ctx, query: result.data })
  }
}

// ============================================
// Common API Schemas (reusable across routes)
// ============================================

/**
 * POST /api/posts — create a new post
 */
export const CreatePostBodySchema = z.object({
  title: z
    .string()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters'),
  content: z
    .string()
    .min(1, 'Content is required')
    .max(10_000, 'Content must be at most 10,000 characters'),
  group_id: z.string().uuid('Invalid group ID').optional().nullable(),
  poll_enabled: z.boolean().optional().default(false),
  visibility: z.enum(['public', 'followers', 'group']).optional().default('public'),
  is_sensitive: z.boolean().optional().default(false),
  content_warning: z.string().max(200, 'Content warning too long').optional().nullable(),
})

/**
 * GET /api/search — unified search query params
 */
export const SearchQuerySchema = z.object({
  q: z.string().max(200, 'Query too long').optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'Limit must be at least 1')
    .max(50, 'Limit must be at most 50')
    .catch(5),
  type: z.enum(['trending', 'hot', 'click']).optional(),
  platform: z.string().max(50, 'Platform name too long').optional(),
  id: z.string().max(200).optional(),
  rtype: z.string().max(20).optional(),
})

/**
 * POST /api/comments — create a comment
 */
export const CreateCommentBodySchema = z.object({
  post_id: z.string().uuid('Invalid post ID'),
  content: z
    .string()
    .min(1, 'Comment cannot be empty')
    .max(5_000, 'Comment must be at most 5,000 characters'),
  parent_id: z.string().uuid('Invalid parent comment ID').optional().nullable(),
})

/**
 * POST /api/groups — create a group
 */
export const CreateGroupBodySchema = z.object({
  name: z
    .string()
    .min(2, 'Group name must be at least 2 characters')
    .max(50, 'Group name must be at most 50 characters'),
  name_en: z
    .string()
    .max(50, 'English name must be at most 50 characters')
    .optional()
    .nullable(),
  description: z
    .string()
    .max(500, 'Description must be at most 500 characters')
    .optional()
    .nullable(),
  avatar_url: z.string().url('Invalid avatar URL').optional().nullable(),
  is_private: z.boolean().optional().default(false),
})

/**
 * GET /api/traders — leaderboard query params
 */
export const LeaderboardQuerySchema = z.object({
  period: z.enum(['7D', '30D', '90D']).optional().default('90D'),
  platform: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
  sort_by: z.enum(['arena_score', 'roi', 'pnl', 'rank']).optional().default('arena_score'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
})

// ============================================
// Exported types
// ============================================

export type Pagination = z.infer<typeof PaginationSchema>
export type IdParam = z.infer<typeof IdParamSchema>
export type HandleParam = z.infer<typeof HandleParamSchema>
export type Sort = z.infer<typeof SortSchema>
export type CreatePostBody = z.infer<typeof CreatePostBodySchema>
export type SearchQuery = z.infer<typeof SearchQuerySchema>
export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>
export type CreateGroupBody = z.infer<typeof CreateGroupBodySchema>
export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>
