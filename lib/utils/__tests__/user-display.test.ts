import { isDeletedUserHandle, truncateName, resolveUserDisplayName } from '../user-display'

const t = (k: string) => `T[${k}]`

describe('isDeletedUserHandle', () => {
  it('null/undefined → true', () => {
    expect(isDeletedUserHandle(null)).toBe(true)
    expect(isDeletedUserHandle(undefined)).toBe(true)
  })

  it('哨兵字符串（空/null/undefined/deleted/anonymous）→ true', () => {
    expect(isDeletedUserHandle('')).toBe(true)
    expect(isDeletedUserHandle('null')).toBe(true)
    expect(isDeletedUserHandle('undefined')).toBe(true)
    expect(isDeletedUserHandle('deleted')).toBe(true)
    expect(isDeletedUserHandle('anonymous')).toBe(true)
  })

  it('deleted_<id> 墓碑 → true', () => {
    expect(isDeletedUserHandle('deleted_abc123')).toBe(true)
  })

  it('大小写/空白不敏感', () => {
    expect(isDeletedUserHandle('  NULL  ')).toBe(true)
    expect(isDeletedUserHandle('Deleted_99')).toBe(true)
  })

  it('真实 handle → false', () => {
    expect(isDeletedUserHandle('cryptowhale')).toBe(false)
    expect(isDeletedUserHandle('user_123')).toBe(false) // 注意：不是 deleted_ 前缀
  })
})

describe('truncateName', () => {
  it('短名原样（trim）', () => {
    expect(truncateName('Alice')).toBe('Alice')
    expect(truncateName('  Bob  ')).toBe('Bob')
  })

  it('超长（>24）→ 截断加省略号', () => {
    const long = 'a'.repeat(30)
    const out = truncateName(long)
    expect(out.length).toBe(24) // 23 + …
    expect(out.endsWith('…')).toBe(true)
  })

  it('自定义 max', () => {
    expect(truncateName('abcdef', 3)).toBe('ab…')
  })
})

describe('resolveUserDisplayName（锁住"渲染 null"历史 bug）', () => {
  it('有真实 handle → 用 handle，可链接', () => {
    const r = resolveUserDisplayName({ handle: 'whale', displayName: 'The Whale' }, t)
    expect(r).toEqual({ label: 'whale', isDeleted: false, linkHandle: 'whale' })
  })

  it('handle 是墓碑但有真实 displayName → 用 displayName，不可链接', () => {
    const r = resolveUserDisplayName({ handle: 'deleted_9', displayName: '匿名鲸鱼' }, t)
    expect(r.label).toBe('匿名鲸鱼')
    expect(r.isDeleted).toBe(false)
    expect(r.linkHandle).toBeNull()
  })

  it('handle 和 displayName 都无效 → deletedUser 文案，绝不返回 "null"', () => {
    const r = resolveUserDisplayName({ handle: 'null', displayName: 'undefined' }, t)
    expect(r.label).toBe('T[deletedUser]')
    expect(r.isDeleted).toBe(true)
    expect(r.linkHandle).toBeNull()
    expect(r.label).not.toBe('null')
  })

  it('全部缺失（handle/displayName 都 null）→ deletedUser', () => {
    const r = resolveUserDisplayName({ handle: null, displayName: null }, t)
    expect(r.isDeleted).toBe(true)
    expect(r.label).toBe('T[deletedUser]')
  })

  it('handle 超长 → 截断', () => {
    const r = resolveUserDisplayName({ handle: 'x'.repeat(40) }, t)
    expect(r.label.length).toBe(24)
    expect(r.label.endsWith('…')).toBe(true)
  })
})
