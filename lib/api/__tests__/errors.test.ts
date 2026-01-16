/**
 * API 错误处理测试
 */

import {
  ErrorCode,
  ErrorCodeToHttpStatus,
  ErrorMessages,
  ApiError,
  httpStatusToErrorCode,
} from '../errors'

describe('API errors', () => {
  describe('ErrorCode', () => {
    it('应该包含所有错误码', () => {
      expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED')
      expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND')
      expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR')
      expect(ErrorCode.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMIT_EXCEEDED')
    })
  })

  describe('ErrorCodeToHttpStatus', () => {
    it('应该正确映射认证错误', () => {
      expect(ErrorCodeToHttpStatus[ErrorCode.UNAUTHORIZED]).toBe(401)
      expect(ErrorCodeToHttpStatus[ErrorCode.FORBIDDEN]).toBe(403)
    })

    it('应该正确映射资源错误', () => {
      expect(ErrorCodeToHttpStatus[ErrorCode.NOT_FOUND]).toBe(404)
      expect(ErrorCodeToHttpStatus[ErrorCode.RESOURCE_EXISTS]).toBe(409)
    })

    it('应该正确映射验证错误', () => {
      expect(ErrorCodeToHttpStatus[ErrorCode.VALIDATION_ERROR]).toBe(400)
    })

    it('应该正确映射限流错误', () => {
      expect(ErrorCodeToHttpStatus[ErrorCode.RATE_LIMIT_EXCEEDED]).toBe(429)
    })

    it('应该正确映射服务器错误', () => {
      expect(ErrorCodeToHttpStatus[ErrorCode.INTERNAL_ERROR]).toBe(500)
      expect(ErrorCodeToHttpStatus[ErrorCode.DATABASE_ERROR]).toBe(500)
    })
  })

  describe('ErrorMessages', () => {
    it('应该包含中英文消息', () => {
      const message = ErrorMessages[ErrorCode.UNAUTHORIZED]
      expect(message.zh).toBeTruthy()
      expect(message.en).toBeTruthy()
    })

    it('应该为所有错误码提供消息', () => {
      Object.values(ErrorCode).forEach(code => {
        expect(ErrorMessages[code]).toBeDefined()
        expect(ErrorMessages[code].zh).toBeTruthy()
        expect(ErrorMessages[code].en).toBeTruthy()
      })
    })
  })

  describe('ApiError', () => {
    describe('constructor', () => {
      it('应该创建基本错误', () => {
        const error = new ApiError('Test error')
        expect(error.message).toBe('Test error')
        expect(error.name).toBe('ApiError')
        expect(error.code).toBe(ErrorCode.UNKNOWN_ERROR)
        expect(error.statusCode).toBe(500)
        expect(error.timestamp).toBeTruthy()
      })

      it('应该支持自定义错误码', () => {
        const error = new ApiError('Not found', { code: ErrorCode.NOT_FOUND })
        expect(error.code).toBe(ErrorCode.NOT_FOUND)
        expect(error.statusCode).toBe(404)
      })

      it('应该支持自定义状态码', () => {
        const error = new ApiError('Custom', { statusCode: 418 })
        expect(error.statusCode).toBe(418)
      })

      it('应该支持详情信息', () => {
        const error = new ApiError('Validation', {
          code: ErrorCode.VALIDATION_ERROR,
          details: { field: 'email', reason: 'invalid' },
        })
        expect(error.details).toEqual({ field: 'email', reason: 'invalid' })
      })

      it('应该支持原因错误', () => {
        const cause = new Error('Original error')
        const error = new ApiError('Wrapped', { cause })
        expect(error.cause).toBe(cause)
      })
    })

    describe('toJSON', () => {
      it('应该返回正确的 JSON 格式', () => {
        const error = new ApiError('Test error', {
          code: ErrorCode.NOT_FOUND,
          details: { id: '123' },
        })
        
        const json = error.toJSON()
        
        expect(json.success).toBe(false)
        expect(json.error.code).toBe(ErrorCode.NOT_FOUND)
        expect(json.error.message).toBe('Test error')
        expect(json.error.details).toEqual({ id: '123' })
        expect(json.error.timestamp).toBeTruthy()
      })

      it('应该省略空的 details', () => {
        const error = new ApiError('Test error')
        const json = error.toJSON()
        expect(json.error.details).toBeUndefined()
      })
    })

    describe('static factory methods', () => {
      it('unauthorized 应该创建 401 错误', () => {
        const error = ApiError.unauthorized()
        expect(error.code).toBe(ErrorCode.UNAUTHORIZED)
        expect(error.statusCode).toBe(401)
      })

      it('unauthorized 应该支持自定义消息', () => {
        const error = ApiError.unauthorized('Custom message')
        expect(error.message).toBe('Custom message')
      })

      it('forbidden 应该创建 403 错误', () => {
        const error = ApiError.forbidden()
        expect(error.code).toBe(ErrorCode.FORBIDDEN)
        expect(error.statusCode).toBe(403)
      })

      it('notFound 应该创建 404 错误', () => {
        const error = ApiError.notFound()
        expect(error.code).toBe(ErrorCode.NOT_FOUND)
        expect(error.statusCode).toBe(404)
      })

      it('validation 应该创建 400 错误', () => {
        const error = ApiError.validation('Invalid input', { field: 'email' })
        expect(error.code).toBe(ErrorCode.VALIDATION_ERROR)
        expect(error.statusCode).toBe(400)
        expect(error.details).toEqual({ field: 'email' })
      })

      it('rateLimitExceeded 应该创建 429 错误', () => {
        const error = ApiError.rateLimitExceeded(60)
        expect(error.code).toBe(ErrorCode.RATE_LIMIT_EXCEEDED)
        expect(error.statusCode).toBe(429)
        expect(error.details?.retryAfter).toBe(60)
      })

      it('database 应该创建 500 错误', () => {
        const cause = new Error('Connection failed')
        const error = ApiError.database('DB error', cause)
        expect(error.code).toBe(ErrorCode.DATABASE_ERROR)
        expect(error.cause).toBe(cause)
      })

      it('internal 应该创建 500 错误', () => {
        const error = ApiError.internal()
        expect(error.code).toBe(ErrorCode.INTERNAL_ERROR)
        expect(error.statusCode).toBe(500)
      })
    })

    describe('from', () => {
      it('应该直接返回 ApiError', () => {
        const original = ApiError.notFound()
        const result = ApiError.from(original)
        expect(result).toBe(original)
      })

      it('应该转换标准 Error', () => {
        const error = new Error('Standard error')
        const result = ApiError.from(error)
        expect(result.message).toBe('Standard error')
        expect(result.cause).toBe(error)
      })

      it('应该处理带状态码的 Error', () => {
        const error = new Error('Not found') as Error & { statusCode: number }
        error.statusCode = 404
        const result = ApiError.from(error)
        expect(result.statusCode).toBe(404)
      })

      it('应该处理对象', () => {
        const obj = { message: 'Object error', statusCode: 400 }
        const result = ApiError.from(obj)
        expect(result.message).toBe('Object error')
        expect(result.statusCode).toBe(400)
      })

      it('应该处理字符串', () => {
        const result = ApiError.from('String error')
        expect(result.message).toBe('String error')
      })

      it('应该处理 null 和 undefined', () => {
        expect(ApiError.from(null).message).toBe('未知错误')
        expect(ApiError.from(undefined).message).toBe('未知错误')
      })
    })
  })

  describe('httpStatusToErrorCode', () => {
    it('应该正确映射常见状态码', () => {
      expect(httpStatusToErrorCode(400)).toBe(ErrorCode.VALIDATION_ERROR)
      expect(httpStatusToErrorCode(401)).toBe(ErrorCode.UNAUTHORIZED)
      expect(httpStatusToErrorCode(403)).toBe(ErrorCode.FORBIDDEN)
      expect(httpStatusToErrorCode(404)).toBe(ErrorCode.NOT_FOUND)
      expect(httpStatusToErrorCode(429)).toBe(ErrorCode.RATE_LIMIT_EXCEEDED)
      expect(httpStatusToErrorCode(500)).toBe(ErrorCode.INTERNAL_ERROR)
      expect(httpStatusToErrorCode(503)).toBe(ErrorCode.SERVICE_UNAVAILABLE)
    })

    it('应该为未知 5xx 返回 INTERNAL_ERROR', () => {
      expect(httpStatusToErrorCode(501)).toBe(ErrorCode.INTERNAL_ERROR)
      expect(httpStatusToErrorCode(504)).toBe(ErrorCode.INTERNAL_ERROR)
    })

    it('应该为未知 4xx 返回 UNKNOWN_ERROR', () => {
      expect(httpStatusToErrorCode(418)).toBe(ErrorCode.UNKNOWN_ERROR)
    })
  })
})
