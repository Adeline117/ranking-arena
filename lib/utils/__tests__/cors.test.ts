import { isAllowedOrigin, getCorsOrigin, getCorsHeaders } from '../cors'

describe('isAllowedOrigin — 白名单', () => {
  it('生产域名精确匹配 → true', () => {
    expect(isAllowedOrigin('https://www.arenafi.org')).toBe(true)
    expect(isAllowedOrigin('https://arenafi.org')).toBe(true)
  })

  it('Vercel preview（ranking-arena-*.vercel.app）→ true', () => {
    expect(isAllowedOrigin('https://ranking-arena-abc123.vercel.app')).toBe(true)
  })

  it('null origin → false', () => {
    expect(isAllowedOrigin(null)).toBe(false)
  })

  it('安全：子域后缀攻击不匹配（精确比对）', () => {
    // 攻击者控制的 arenafi.org.evil.com 不能通过
    expect(isAllowedOrigin('https://www.arenafi.org.evil.com')).toBe(false)
    expect(isAllowedOrigin('https://evil.com/https://www.arenafi.org')).toBe(false)
    // http（非 https）生产域名不匹配
    expect(isAllowedOrigin('http://www.arenafi.org')).toBe(false)
  })

  it('安全：preview 正则要求 $ 结尾 .vercel.app（后缀攻击不匹配）', () => {
    expect(isAllowedOrigin('https://ranking-arena-x.vercel.app.evil.com')).toBe(false)
  })

  it('完全无关的域名 → false', () => {
    expect(isAllowedOrigin('https://google.com')).toBe(false)
  })
})

describe('getCorsOrigin', () => {
  it('允许的 origin → 原样返回（回显）', () => {
    expect(getCorsOrigin('https://arenafi.org')).toBe('https://arenafi.org')
  })

  it('不允许/null → 回退到主生产域名（不回显攻击者 origin）', () => {
    expect(getCorsOrigin('https://evil.com')).toBe('https://www.arenafi.org')
    expect(getCorsOrigin(null)).toBe('https://www.arenafi.org')
  })
})

describe('getCorsHeaders', () => {
  it('含标准 CORS 头', () => {
    const h = getCorsHeaders('https://www.arenafi.org')
    expect(h['Access-Control-Allow-Origin']).toBe('https://www.arenafi.org')
    expect(h['Access-Control-Allow-Methods']).toContain('POST')
    expect(h['Access-Control-Allow-Headers']).toContain('Authorization')
    expect(h['Access-Control-Max-Age']).toBe('86400')
  })

  it('不允许的 origin → Allow-Origin 回退主域名（不回显）', () => {
    expect(getCorsHeaders('https://evil.com')['Access-Control-Allow-Origin']).toBe(
      'https://www.arenafi.org'
    )
  })
})
