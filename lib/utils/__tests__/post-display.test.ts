import { normalizePostTitle, resolvePostDisplayTitle } from '../post-display'

describe('normalizePostTitle（锁住 "Untitled" 不一致历史 bug）', () => {
  it('null/空/纯空白 → 空字符串', () => {
    expect(normalizePostTitle(null)).toBe('')
    expect(normalizePostTitle(undefined)).toBe('')
    expect(normalizePostTitle('   ')).toBe('')
  })

  it('legacy "Untitled" 占位（大小写不敏感）→ 空字符串', () => {
    expect(normalizePostTitle('Untitled')).toBe('')
    expect(normalizePostTitle('untitled')).toBe('')
    expect(normalizePostTitle('  UNTITLED  ')).toBe('')
  })

  it('真实标题 → trim 后返回', () => {
    expect(normalizePostTitle('  My Post  ')).toBe('My Post')
    expect(normalizePostTitle('未命名的想法')).toBe('未命名的想法') // 非字面 "Untitled" 不误伤
  })
})

describe('resolvePostDisplayTitle', () => {
  it('有真实标题 → 用标题', () => {
    expect(resolvePostDisplayTitle('Real Title', 'body text')).toBe('Real Title')
  })

  it('标题是占位但有正文 → 用正文摘要', () => {
    expect(resolvePostDisplayTitle('Untitled', 'This is the body')).toBe('This is the body')
  })

  it('正文超长 → 截断加省略号', () => {
    const longBody = 'x'.repeat(100)
    const out = resolvePostDisplayTitle(null, longBody)
    expect(out.length).toBe(81) // 80 + …
    expect(out.endsWith('…')).toBe(true)
  })

  it('标题和正文都空 → 空字符串（调用方在渲染点补 t(noTitle)）', () => {
    expect(resolvePostDisplayTitle('Untitled', '')).toBe('')
    expect(resolvePostDisplayTitle(null, null)).toBe('')
  })

  it('自定义 maxLen', () => {
    expect(resolvePostDisplayTitle(null, 'abcdefghij', 5)).toBe('abcde…')
  })
})
