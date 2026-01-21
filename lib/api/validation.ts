/**
 * API 输入验证工具
 * 提供统一的验证函数和 Zod Schema 集成
 */

import { z } from 'zod'
import { NextRequest } from 'next/server'
import { ApiError, ErrorCode } from './errors'

// ============================================
// 基础验证函数
// ============================================

/**
 * 验证字符串
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
  const { required = false, minLength, maxLength, pattern, fieldName = '字段' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName}不能为空`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const str = String(value).trim()

  if (minLength !== undefined && str.length < minLength) {
    throw new ApiError(`${fieldName}长度不能少于 ${minLength} 个字符`, {
      code: ErrorCode.VALUE_TOO_SHORT,
    })
  }

  if (maxLength !== undefined && str.length > maxLength) {
    throw new ApiError(`${fieldName}长度不能超过 ${maxLength} 个字符`, {
      code: ErrorCode.VALUE_TOO_LONG,
    })
  }

  if (pattern && !pattern.test(str)) {
    throw new ApiError(`${fieldName}格式不正确`, { code: ErrorCode.INVALID_FORMAT })
  }

  return str
}

/**
 * 验证数字
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
  const { required = false, min, max, integer = false, fieldName = '字段' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName}不能为空`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const num = Number(value)

  if (isNaN(num)) {
    throw new ApiError(`${fieldName}必须是有效的数字`, { code: ErrorCode.INVALID_FORMAT })
  }

  if (integer && !Number.isInteger(num)) {
    throw new ApiError(`${fieldName}必须是整数`, { code: ErrorCode.INVALID_FORMAT })
  }

  if (min !== undefined && num < min) {
    throw new ApiError(`${fieldName}不能小于 ${min}`, { code: ErrorCode.VALUE_OUT_OF_RANGE })
  }

  if (max !== undefined && num > max) {
    throw new ApiError(`${fieldName}不能大于 ${max}`, { code: ErrorCode.VALUE_OUT_OF_RANGE })
  }

  return num
}

/**
 * 验证枚举值
 */
export function validateEnum<T extends readonly string[]>(
  value: unknown,
  allowedValues: T,
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): T[number] | null {
  const { required = false, fieldName = '字段' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName}不能为空`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const str = String(value)

  if (!allowedValues.includes(str as T[number])) {
    throw new ApiError(`${fieldName}必须是以下值之一: ${allowedValues.join(', ')}`, {
      code: ErrorCode.INVALID_INPUT,
    })
  }

  return str as T[number]
}

/**
 * 验证 UUID
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
      throw new ApiError(`${fieldName}不能为空`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  const str = String(value).trim()
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!uuidRegex.test(str)) {
    throw new ApiError(`${fieldName}格式无效`, { code: ErrorCode.INVALID_FORMAT })
  }

  return str
}

/**
 * 验证布尔值
 */
export function validateBoolean(
  value: unknown,
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): boolean | null {
  const { required = false, fieldName = '字段' } = options

  if (value === null || value === undefined || value === '') {
    if (required) {
      throw new ApiError(`${fieldName}不能为空`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false

  throw new ApiError(`${fieldName}必须是布尔值`, { code: ErrorCode.INVALID_FORMAT })
}

/**
 * 验证数组
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
  const { required = false, minLength, maxLength, fieldName = '数组' } = options

  if (value === null || value === undefined) {
    if (required) {
      throw new ApiError(`${fieldName}不能为空`, { code: ErrorCode.MISSING_FIELD })
    }
    return null
  }

  if (!Array.isArray(value)) {
    throw new ApiError(`${fieldName}必须是数组`, { code: ErrorCode.INVALID_FORMAT })
  }

  if (minLength !== undefined && value.length < minLength) {
    throw new ApiError(`${fieldName}至少需要 ${minLength} 项`, {
      code: ErrorCode.VALUE_TOO_SHORT,
    })
  }

  if (maxLength !== undefined && value.length > maxLength) {
    throw new ApiError(`${fieldName}最多 ${maxLength} 项`, {
      code: ErrorCode.VALUE_TOO_LONG,
    })
  }

  return value.map((item, index) => itemValidator(item, index))
}

// ============================================
// Zod Schema 验证
// ============================================

/**
 * 使用 Zod Schema 验证数据
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
    // Zod v4 使用 issues，v3 使用 errors
    const issues = (result.error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? []
    const errors = issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ')

    throw new ApiError(
      options.context ? `[${options.context}] 验证失败: ${errors}` : `验证失败: ${errors}`,
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
 * 验证请求体
 */
export async function validateRequestBody<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T
): Promise<z.infer<T>> {
  let body: unknown

  try {
    body = await request.json()
  } catch {
    throw new ApiError('请求体格式错误，必须是有效的 JSON', {
      code: ErrorCode.INVALID_FORMAT,
    })
  }

  return validateWithSchema(schema, body)
}

/**
 * 验证查询参数
 */
export function validateSearchParams<T extends z.ZodTypeAny>(
  searchParams: URLSearchParams,
  schema: T
): z.infer<T> {
  const params: Record<string, string | string[]> = {}

  searchParams.forEach((value, key) => {
    if (params[key]) {
      // 同名参数转为数组
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
// 常用 Schema
// ============================================

/** 分页参数 Schema */
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

/** ID 参数 Schema */
export const IdParamSchema = z.object({
  id: z.string().uuid('ID 格式无效'),
})

/** Handle 参数 Schema */
export const HandleParamSchema = z.object({
  handle: z.string().min(1, 'handle 不能为空'),
})

/** 排序参数 Schema */
export const SortSchema = z.object({
  sort_by: z.string().optional(),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
})

// ============================================
// 导出类型
// ============================================

export type Pagination = z.infer<typeof PaginationSchema>
export type IdParam = z.infer<typeof IdParamSchema>
export type HandleParam = z.infer<typeof HandleParamSchema>
export type Sort = z.infer<typeof SortSchema>
