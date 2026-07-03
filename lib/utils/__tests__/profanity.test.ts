import { sanitizeDisplayName, containsProfanity } from '../profanity'

describe('sanitizeDisplayName', () => {
  it('null/undefined/空 → 空字符串', () => {
    expect(sanitizeDisplayName(null)).toBe('')
    expect(sanitizeDisplayName(undefined)).toBe('')
    expect(sanitizeDisplayName('')).toBe('')
  })

  it('占位名（unnamed/test/请输入昵称等）→ 空字符串（调用方回退到地址）', () => {
    expect(sanitizeDisplayName('unnamed')).toBe('')
    expect(sanitizeDisplayName('Test')).toBe('') // 大小写不敏感
    expect(sanitizeDisplayName('  Trader  ')).toBe('') // trim
    expect(sanitizeDisplayName('请输入昵称')).toBe('')
  })

  it('正常名 → 原样返回', () => {
    expect(sanitizeDisplayName('CryptoWhale')).toBe('CryptoWhale')
    expect(sanitizeDisplayName('聪明的交易员')).toBe('聪明的交易员')
  })

  it('脏词 → 首尾保留、中间打码（len>2）', () => {
    // fuck → f**k
    expect(sanitizeDisplayName('fuck')).toBe('f**k')
    // bitch → b***h
    expect(sanitizeDisplayName('bitch')).toBe('b***h')
  })

  it('短脏词（len≤2）→ 全打码', () => {
    // ass 是 3 字母 → a*s；但边界 \b 需要独立词
    expect(sanitizeDisplayName('ass')).toBe('a*s')
  })

  it('脏词嵌在正常文本中 → 只打码脏词部分', () => {
    expect(sanitizeDisplayName('you fuck man')).toBe('you f**k man')
  })

  it('非独立词的子串不误伤（\\b 边界，如 "assassin" 不含独立 ass）', () => {
    expect(sanitizeDisplayName('assassin')).toBe('assassin')
  })
})

describe('containsProfanity（幂等性——防 global regex lastIndex 有状态 bug）', () => {
  it('同一脏词连续多次调用结果一致（不能 true/false 交替）', () => {
    expect(containsProfanity('fuck')).toBe(true)
    expect(containsProfanity('fuck')).toBe(true) // 若 global regex 有状态，这里会变 false
    expect(containsProfanity('fuck')).toBe(true)
  })

  it('干净名连续调用都 false', () => {
    expect(containsProfanity('CryptoWhale')).toBe(false)
    expect(containsProfanity('CryptoWhale')).toBe(false)
  })

  it('脏词 → true，干净词 → false（交替调用不串味）', () => {
    expect(containsProfanity('shit')).toBe(true)
    expect(containsProfanity('hello')).toBe(false)
    expect(containsProfanity('bitch')).toBe(true)
    expect(containsProfanity('world')).toBe(false)
  })
})
