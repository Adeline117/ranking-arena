/**
 * API 输入校验层 — 把守每个 API 的入口。
 * validateString/Number/Enum/UUID/Boolean/Array + zod HOF(withValidation/
 * withQueryValidation 422 语义) + 全部共享 Schema 的边界。
 */

jest.mock('next/server', () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      __isResponse: true,
      body,
      status: init?.status ?? 200,
    }),
  },
}))
jest.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: jest.fn() }))

import { z } from 'zod'
import {
  validateString,
  validateNumber,
  validateEnum,
  validateUUID,
  validateBoolean,
  validateArray,
  validateWithSchema,
  validateRequestBody,
  validateSearchParams,
  withValidation,
  withQueryValidation,
  PaginationSchema,
  IdParamSchema,
  SortSchema,
  CreatePostBodySchema,
  SearchQuerySchema,
  CreateCommentBodySchema,
  CreateGroupBodySchema,
  LeaderboardQuerySchema,
} from '../validation'
import { ApiError } from '../errors'

const UUID = '123e4567-e89b-42d3-a456-426614174000'

describe('validateString', () => {
  it('required 缺失 → ApiError', () => {
    expect(() => validateString(undefined, { required: true })).toThrow(ApiError)
    expect(() => validateString('', { required: true })).toThrow(ApiError)
  })
  it('可选缺失 → null', () => {
    expect(validateString(null)).toBeNull()
  })
  it('trim + 长度边界', () => {
    expect(validateString('  hi  ')).toBe('hi')
    expect(() => validateString('ab', { minLength: 3 })).toThrow('at least 3')
    expect(() => validateString('abcd', { maxLength: 3 })).toThrow('not exceed 3')
    expect(validateString('abc', { minLength: 3, maxLength: 3 })).toBe('abc')
  })
  it('pattern 不匹配 → throw', () => {
    expect(() => validateString('abc!', { pattern: /^\w+$/ })).toThrow('format is invalid')
    expect(validateString('abc_1', { pattern: /^\w+$/ })).toBe('abc_1')
  })
  it('非字符串被 String() 强转', () => {
    expect(validateString(42)).toBe('42')
  })
})

describe('validateNumber', () => {
  it('required 缺失 → throw;可选 → null', () => {
    expect(() => validateNumber('', { required: true })).toThrow(ApiError)
    expect(validateNumber(undefined)).toBeNull()
  })
  it('NaN → throw', () => {
    expect(() => validateNumber('abc')).toThrow('valid number')
  })
  it('integer 约束', () => {
    expect(() => validateNumber(1.5, { integer: true })).toThrow('integer')
    expect(validateNumber(2, { integer: true })).toBe(2)
  })
  it('min/max 边界(含端点)', () => {
    expect(() => validateNumber(0, { min: 1 })).toThrow('at least 1')
    expect(() => validateNumber(101, { max: 100 })).toThrow('not exceed 100')
    expect(validateNumber(1, { min: 1, max: 1 })).toBe(1)
  })
  it('字符串数字被 Number() 强转', () => {
    expect(validateNumber('3.14')).toBe(3.14)
  })
  it('0 是合法值不是"缺失"', () => {
    expect(validateNumber(0, { required: true })).toBe(0)
  })
})

describe('validateEnum', () => {
  const COLORS = ['red', 'green'] as const
  it('合法值通过,非法 throw', () => {
    expect(validateEnum('red', COLORS)).toBe('red')
    expect(() => validateEnum('blue', COLORS)).toThrow('must be one of: red, green')
  })
  it('required/可选', () => {
    expect(() => validateEnum(null, COLORS, { required: true })).toThrow(ApiError)
    expect(validateEnum(undefined, COLORS)).toBeNull()
  })
})

describe('validateUUID', () => {
  it('合法 UUID(大小写不敏感)', () => {
    expect(validateUUID(UUID)).toBe(UUID)
    expect(validateUUID(UUID.toUpperCase())).toBe(UUID.toUpperCase())
  })
  it('非法格式 → throw', () => {
    expect(() => validateUUID('not-a-uuid')).toThrow('format is invalid')
    expect(() => validateUUID('123e4567e89b42d3a456426614174000')).toThrow() // 无连字符
  })
  it('required/可选', () => {
    expect(() => validateUUID('', { required: true })).toThrow(ApiError)
    expect(validateUUID(null)).toBeNull()
  })
})

describe('validateBoolean', () => {
  it('原生布尔 + 字符串形态', () => {
    expect(validateBoolean(true)).toBe(true)
    expect(validateBoolean('true')).toBe(true)
    expect(validateBoolean('1')).toBe(true)
    expect(validateBoolean('false')).toBe(false)
    expect(validateBoolean('0')).toBe(false)
  })
  it('其他值 → throw', () => {
    expect(() => validateBoolean('yes')).toThrow('must be a boolean')
    expect(() => validateBoolean(1)).toThrow() // 数字 1 不接受,只有字符串 '1'
  })
  it('可选缺失 → null', () => {
    expect(validateBoolean(undefined)).toBeNull()
  })
})

describe('validateArray', () => {
  const toNum = (v: unknown) => validateNumber(v, { required: true }) as number
  it('非数组 → throw', () => {
    expect(() => validateArray('nope', toNum)).toThrow('must be an array')
  })
  it('长度边界', () => {
    expect(() => validateArray([1], toNum, { minLength: 2 })).toThrow('at least 2')
    expect(() => validateArray([1, 2, 3], toNum, { maxLength: 2 })).toThrow('at most 2')
  })
  it('逐项校验并映射', () => {
    expect(validateArray(['1', '2'], toNum)).toEqual([1, 2])
  })
  it('项校验失败向上抛', () => {
    expect(() => validateArray(['1', 'bad'], toNum)).toThrow('valid number')
  })
  it('required/可选', () => {
    expect(() => validateArray(null, toNum, { required: true })).toThrow(ApiError)
    expect(validateArray(undefined, toNum)).toBeNull()
  })
})

describe('validateWithSchema / validateRequestBody / validateSearchParams', () => {
  const schema = z.object({ name: z.string().min(2) })

  it('通过 → 返回解析数据', () => {
    expect(validateWithSchema(schema, { name: 'ok' })).toEqual({ name: 'ok' })
  })
  it('失败 → ApiError 带 path 细节 + context 前缀', () => {
    expect(() => validateWithSchema(schema, { name: 'x' })).toThrow('Validation failed')
    expect(() => validateWithSchema(schema, { name: 'x' }, { context: 'test-ctx' })).toThrow(
      '[test-ctx]'
    )
  })
  it('validateRequestBody:JSON 解析失败 → ApiError', async () => {
    const badReq = { json: () => Promise.reject(new Error('bad json')) } as never
    await expect(validateRequestBody(badReq, schema)).rejects.toThrow('must be valid JSON')
  })
  it('validateRequestBody:合法 body → 解析', async () => {
    const req = { json: () => Promise.resolve({ name: 'hello' }) } as never
    await expect(validateRequestBody(req, schema)).resolves.toEqual({ name: 'hello' })
  })
  it('validateSearchParams:重复 key 聚成数组', () => {
    const sp = new URLSearchParams('tag=a&tag=b&tag=c&q=x')
    const s = z.object({ tag: z.array(z.string()), q: z.string() })
    expect(validateSearchParams(sp, s)).toEqual({ tag: ['a', 'b', 'c'], q: 'x' })
  })
})

describe('withValidation — body 校验 HOF(422 语义)', () => {
  const schema = z.object({ title: z.string().min(1), count: z.number() })
  const ctx = (jsonImpl: () => Promise<unknown>) =>
    ({ request: { json: jsonImpl }, supabase: {}, version: {} }) as never

  it('非法 JSON → 422 INVALID_FORMAT,handler 不执行', async () => {
    const handler = jest.fn()
    const wrapped = withValidation(schema, handler as never)
    const res = (await wrapped(ctx(() => Promise.reject(new Error('x'))))) as never as {
      status: number
      body: { error: { code: string } }
    }
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_FORMAT')
    expect(handler).not.toHaveBeenCalled()
  })

  it('schema 失败 → 422 + fieldErrors(field/message)', async () => {
    const handler = jest.fn()
    const wrapped = withValidation(schema, handler as never)
    const res = (await wrapped(
      ctx(() => Promise.resolve({ title: '', count: 'nan' }))
    )) as never as {
      status: number
      body: { error: { details: { fieldErrors: Array<{ field: string }> } } }
    }
    expect(res.status).toBe(422)
    const fields = res.body.error.details.fieldErrors.map((f) => f.field)
    expect(fields).toContain('title')
    expect(fields).toContain('count')
    expect(handler).not.toHaveBeenCalled()
  })

  it('错误摘要最多 3 个字段 + "+N more"(不泄漏 schema 全形)', async () => {
    const bigSchema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
    })
    const wrapped = withValidation(bigSchema, jest.fn() as never)
    const res = (await wrapped(ctx(() => Promise.resolve({})))) as never as {
      body: { error: { message: string } }
    }
    expect(res.body.error.message).toContain('(+2 more)')
  })

  it('通过 → handler 收到解析后的 body', async () => {
    const handler = jest.fn().mockResolvedValue('ok')
    const wrapped = withValidation(schema, handler as never)
    const out = await wrapped(ctx(() => Promise.resolve({ title: 't', count: 5 })))
    expect(out).toBe('ok')
    expect(handler.mock.calls[0][0].body).toEqual({ title: 't', count: 5 })
  })
})

describe('withQueryValidation — query 校验 HOF', () => {
  const schema = z.object({ q: z.string(), tags: z.array(z.string()).optional() })
  const ctx = (qs: string) =>
    ({
      request: { nextUrl: new URL(`https://x.test/api?${qs}`) },
      supabase: {},
      version: {},
    }) as never

  it('通过 → handler 收到 query;重复 key 成数组', async () => {
    const handler = jest.fn().mockResolvedValue('ok')
    const wrapped = withQueryValidation(schema, handler as never)
    await wrapped(ctx('q=hello&tags=a&tags=b'))
    expect(handler.mock.calls[0][0].query).toEqual({ q: 'hello', tags: ['a', 'b'] })
  })

  it('失败 → 422,handler 不执行', async () => {
    const handler = jest.fn()
    const wrapped = withQueryValidation(schema, handler as never)
    const res = (await wrapped(ctx('tags=a'))) as never as { status: number }
    expect(res.status).toBe(422)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('共享 Schema 边界', () => {
  it('PaginationSchema:默认 20/0;越界 throw(不静默 clamp)', () => {
    expect(PaginationSchema.parse({})).toEqual({ limit: 20, offset: 0 })
    expect(PaginationSchema.parse({ limit: '50', offset: '10' })).toEqual({
      limit: 50,
      offset: 10,
    })
    expect(() => PaginationSchema.parse({ limit: '999' })).toThrow() // max 100
    expect(() => PaginationSchema.parse({ offset: '-1' })).toThrow()
  })

  it('IdParamSchema:UUID 强制', () => {
    expect(IdParamSchema.parse({ id: UUID }).id).toBe(UUID)
    expect(() => IdParamSchema.parse({ id: 'abc' })).toThrow()
  })

  it('SortSchema:sort_order 默认 desc,枚举强制', () => {
    expect(SortSchema.parse({}).sort_order).toBe('desc')
    expect(() => SortSchema.parse({ sort_order: 'sideways' })).toThrow()
  })

  it('CreatePostBodySchema:默认值 + 长度上限', () => {
    const min = { title: 't', content: 'c' }
    const parsed = CreatePostBodySchema.parse(min)
    expect(parsed.visibility).toBe('public')
    expect(parsed.poll_enabled).toBe(false)
    expect(() => CreatePostBodySchema.parse({ ...min, title: 'x'.repeat(201) })).toThrow()
    expect(() => CreatePostBodySchema.parse({ ...min, content: 'x'.repeat(10_001) })).toThrow()
    expect(() => CreatePostBodySchema.parse({ ...min, group_id: 'not-uuid' })).toThrow()
  })

  it('SearchQuerySchema:limit 越界 catch 回退 5(不报错)', () => {
    expect(SearchQuerySchema.parse({ limit: '999' }).limit).toBe(5) // .catch(5)
    expect(SearchQuerySchema.parse({ limit: 'abc' }).limit).toBe(5)
    expect(SearchQuerySchema.parse({ limit: '30' }).limit).toBe(30)
  })

  it('CreateCommentBodySchema:post_id UUID 必填,parent 可空', () => {
    expect(() => CreateCommentBodySchema.parse({ post_id: 'x', content: 'hi' })).toThrow()
    const ok = CreateCommentBodySchema.parse({ post_id: UUID, content: 'hi', parent_id: null })
    expect(ok.parent_id).toBeNull()
    expect(() =>
      CreateCommentBodySchema.parse({ post_id: UUID, content: 'x'.repeat(5001) })
    ).toThrow()
  })

  it('CreateGroupBodySchema:名字 2-50、avatar 必须 URL', () => {
    expect(() => CreateGroupBodySchema.parse({ name: 'x' })).toThrow() // <2
    expect(() => CreateGroupBodySchema.parse({ name: 'ok', avatar_url: 'nope' })).toThrow()
    expect(CreateGroupBodySchema.parse({ name: 'ok' }).is_private).toBe(false)
  })

  it('LeaderboardQuerySchema:全默认 + catch 回退', () => {
    const d = LeaderboardQuerySchema.parse({})
    expect(d).toMatchObject({
      period: '90D',
      limit: 50,
      offset: 0,
      sort_by: 'arena_score',
      sort_order: 'desc',
    })
    expect(LeaderboardQuerySchema.parse({ limit: '9999' }).limit).toBe(50) // catch
    expect(() => LeaderboardQuerySchema.parse({ period: '1Y' })).toThrow()
  })
})
