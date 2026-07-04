/**
 * CSRF token helper — cookie 读写 + 幂等性（jsdom document.cookie）。
 */
import { getCsrfHeaders } from '../csrf'

function clearCookies() {
  for (const c of document.cookie.split(';')) {
    const name = c.trim().split('=')[0]
    if (name) document.cookie = `${name}=; path=/; max-age=0`
  }
}

describe('getCsrfHeaders', () => {
  beforeEach(clearCookies)

  it('无 cookie → 生成新 token 并写入 cookie + 返回头', () => {
    const h = getCsrfHeaders()
    expect(h['x-csrf-token']).toBeTruthy()
    expect(document.cookie).toContain('csrf-token=')
  })

  it('token 形态 = base36时间戳.64位hex（熵来自 crypto）', () => {
    const token = getCsrfHeaders()['x-csrf-token']
    expect(token).toMatch(/^[0-9a-z]+\.[0-9a-f]{64}$/)
  })

  it('幂等：已有 cookie → 复用同一 token（不重新生成）', () => {
    const first = getCsrfHeaders()['x-csrf-token']
    const second = getCsrfHeaders()['x-csrf-token']
    expect(second).toBe(first)
  })

  it('已存在的外部 token 被尊重（URI 解码）', () => {
    document.cookie = `csrf-token=${encodeURIComponent('server.issued+token')}; path=/`
    expect(getCsrfHeaders()['x-csrf-token']).toBe('server.issued+token')
  })

  it('两次清空后生成的 token 不同（不可预测）', () => {
    const a = getCsrfHeaders()['x-csrf-token']
    clearCookies()
    const b = getCsrfHeaders()['x-csrf-token']
    expect(a).not.toBe(b)
  })
})
