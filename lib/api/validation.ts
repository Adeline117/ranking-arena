/**
 * API 输入验证辅助函数
 */

/**
 * 验证字符串
 */
export function validateString(
  value: unknown,
  options: {
    required?: boolean
    minLength?: number
    maxLength?: number
    fieldName?: string
  } = {}
): string | null {
  const { required = false, minLength, maxLength, fieldName = '字段' } = options
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName}不能为空`)
    }
    return null
  }
  
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName}必须是字符串`)
  }
  
  const trimmed = value.trim()
  
  if (required && trimmed.length === 0) {
    throw new ValidationError(`${fieldName}不能为空`)
  }
  
  if (minLength !== undefined && trimmed.length < minLength) {
    throw new ValidationError(`${fieldName}至少需要${minLength}个字符`)
  }
  
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new ValidationError(`${fieldName}不能超过${maxLength}个字符`)
  }
  
  return trimmed
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
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName}不能为空`)
    }
    return null
  }
  
  const num = typeof value === 'string' ? parseFloat(value) : value
  
  if (typeof num !== 'number' || isNaN(num)) {
    throw new ValidationError(`${fieldName}必须是有效数字`)
  }
  
  if (integer && !Number.isInteger(num)) {
    throw new ValidationError(`${fieldName}必须是整数`)
  }
  
  if (min !== undefined && num < min) {
    throw new ValidationError(`${fieldName}不能小于${min}`)
  }
  
  if (max !== undefined && num > max) {
    throw new ValidationError(`${fieldName}不能大于${max}`)
  }
  
  return num
}

/**
 * 验证枚举值
 */
export function validateEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): T | null {
  const { required = false, fieldName = '字段' } = options
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName}不能为空`)
    }
    return null
  }
  
  if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
    throw new ValidationError(`${fieldName}必须是以下值之一: ${allowedValues.join(', ')}`)
  }
  
  return value as T
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
  const { required = false, fieldName = '字段' } = options
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName}不能为空`)
    }
    return null
  }
  
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName}格式无效`)
  }
  
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(value)) {
    throw new ValidationError(`${fieldName}格式无效`)
  }
  
  return value
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
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName}不能为空`)
    }
    return null
  }
  
  if (typeof value === 'boolean') {
    return value
  }
  
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  
  throw new ValidationError(`${fieldName}必须是布尔值`)
}

/**
 * 验证邮箱
 */
export function validateEmail(
  value: unknown,
  options: {
    required?: boolean
    fieldName?: string
  } = {}
): string | null {
  const { required = false, fieldName = '邮箱' } = options
  
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ValidationError(`${fieldName}不能为空`)
    }
    return null
  }
  
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName}格式无效`)
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(value)) {
    throw new ValidationError(`${fieldName}格式无效`)
  }
  
  return value.toLowerCase()
}

/**
 * 验证错误类
 */
export class ValidationError extends Error {
  readonly statusCode = 400
  readonly code = 'VALIDATION_ERROR'
  
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * 批量验证辅助函数
 */
export function validate<T extends Record<string, unknown>>(
  body: unknown,
  schema: {
    [K in keyof T]: (value: unknown) => T[K]
  }
): T {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('请求体无效')
  }
  
  const result: Partial<T> = {}
  const bodyObj = body as Record<string, unknown>
  
  for (const key of Object.keys(schema)) {
    const validator = schema[key as keyof T]
    result[key as keyof T] = validator(bodyObj[key])
  }
  
  return result as T
}

