import { extractMentionHandles, findMentionTokens, getMentionQuery } from './mentions'

describe('post mentions', () => {
  it('finds ASCII, dotted legacy, Chinese, Japanese, and Korean handles', () => {
    const text = 'Hi @alice_1 @legacy.name @测试用户 @ユーザー @사용자'
    expect(findMentionTokens(text).map((token) => token.handle)).toEqual([
      'alice_1',
      'legacy.name',
      '测试用户',
      'ユーザー',
      '사용자',
    ])
  })

  it('does not turn email suffixes or overlong handles into mentions', () => {
    const overlong = 'a'.repeat(31)
    const text = `mail@example.com @${overlong} ok @alice`
    const start = text.lastIndexOf('@alice')

    expect(findMentionTokens(text)).toEqual([
      { start, end: start + '@alice'.length, handle: 'alice' },
    ])
  })

  it('deduplicates case-insensitively, normalizes, caps, and sorts server input', () => {
    expect(extractMentionHandles('@bob @Alice @alice @测试 @carol', 3)).toEqual([
      'Alice',
      'bob',
      '测试',
    ])
  })

  it('rejects invalid extraction limits', () => {
    expect(extractMentionHandles('@alice', 0)).toEqual([])
    expect(extractMentionHandles('@alice', Number.NaN)).toEqual([])
  })

  it('extracts a Unicode autocomplete query at the cursor', () => {
    expect(getMentionQuery('hello @测试用', 10)).toEqual({ query: '测试用', start: 6 })
    expect(getMentionQuery('hello @', 7, true)).toEqual({ query: '', start: 6 })
    expect(getMentionQuery('hello @', 7)).toBeNull()
  })

  it('closes autocomplete across whitespace, email text, invalid chars, and bad cursors', () => {
    expect(getMentionQuery('hello @alice now', 16, true)).toBeNull()
    expect(getMentionQuery('mail@example', 12, true)).toBeNull()
    expect(getMentionQuery('hello @alice-', 13, true)).toBeNull()
    expect(getMentionQuery('hello', 99, true)).toBeNull()
  })
})
