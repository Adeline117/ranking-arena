import { parsePaginationParams, buildPaginationMeta } from '../pagination'

const sp = (q: string) => new URLSearchParams(q)

describe('parsePaginationParams', () => {
  it('无参数 → 默认 limit=20 offset=0', () => {
    expect(parsePaginationParams(sp(''))).toEqual({ limit: 20, offset: 0 })
  })

  it('正常值原样解析', () => {
    expect(parsePaginationParams(sp('limit=50&offset=100'))).toEqual({ limit: 50, offset: 100 })
  })

  it('limit clamp 到 [1, 200]', () => {
    expect(parsePaginationParams(sp('limit=0')).limit).toBe(1)
    expect(parsePaginationParams(sp('limit=-5')).limit).toBe(1)
    expect(parsePaginationParams(sp('limit=9999')).limit).toBe(200)
  })

  it('offset 负数 → 0', () => {
    expect(parsePaginationParams(sp('offset=-10')).offset).toBe(0)
  })

  it('非数字垃圾 → 回退默认（不 NaN 传染）', () => {
    const r = parsePaginationParams(sp('limit=abc&offset=xyz'))
    expect(r).toEqual({ limit: 20, offset: 0 })
  })

  it('自定义 defaultLimit/maxLimit', () => {
    expect(parsePaginationParams(sp(''), { defaultLimit: 10 }).limit).toBe(10)
    expect(parsePaginationParams(sp('limit=150'), { maxLimit: 100 }).limit).toBe(100)
  })

  it('小数被 parseInt 截断', () => {
    expect(parsePaginationParams(sp('limit=25.9')).limit).toBe(25)
  })
})

describe('buildPaginationMeta', () => {
  it('resultCount >= limit → has_more true', () => {
    expect(buildPaginationMeta({ limit: 20, offset: 0, resultCount: 20 }).has_more).toBe(true)
  })

  it('resultCount < limit → has_more false（最后一页）', () => {
    expect(buildPaginationMeta({ limit: 20, offset: 40, resultCount: 7 }).has_more).toBe(false)
  })

  it('total 传了才出现在 meta', () => {
    expect(buildPaginationMeta({ limit: 20, offset: 0, resultCount: 5 })).not.toHaveProperty(
      'total'
    )
    expect(buildPaginationMeta({ limit: 20, offset: 0, resultCount: 5, total: 123 }).total).toBe(
      123
    )
  })

  it('total=0（空表）也保留而不是被当 falsy 丢掉', () => {
    expect(buildPaginationMeta({ limit: 20, offset: 0, resultCount: 0, total: 0 }).total).toBe(0)
  })
})
