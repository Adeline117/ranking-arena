/**
 * API Input Validation Utilities
 */

import { z } from 'zod'
import { NextRequest } from 'next/server'
import { ApiError, ErrorCode } from './errors'

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
// Exported types
// ============================================

export type Pagination = z.infer<typeof PaginationSchema>
export type IdParam = z.infer<typeof IdParamSchema>
export type HandleParam = z.infer<typeof HandleParamSchema>
export type Sort = z.infer<typeof SortSchema>
