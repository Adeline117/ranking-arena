/**
 * multiAccountStore — 多账号切换 + refresh token XOR 加密持久化。
 * 关键安全断言:localStorage 里绝不出现明文 refreshToken。
 */
import { useMultiAccountStore, type StoredAccount } from '../multiAccountStore'

function acct(userId: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    userId,
    email: `${userId}@x.co`,
    handle: userId,
    avatarUrl: null,
    refreshToken: `secret-refresh-${userId}`,
    lastActiveAt: '2026-07-01T00:00:00Z',
    isActive: false,
    ...overrides,
  }
}

beforeEach(() => {
  useMultiAccountStore.getState().clear()
  window.localStorage.removeItem('arena-multi-accounts')
})

describe('账号增删改', () => {
  it('addAccount 新增;同 userId 再 add = 覆盖更新(不重复)', () => {
    useMultiAccountStore.getState().addAccount(acct('u1'))
    useMultiAccountStore.getState().addAccount(acct('u1', { email: 'new@x.co' }))
    const accounts = useMultiAccountStore.getState().accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0].email).toBe('new@x.co')
  })

  it('removeAccount 按 userId 删除', () => {
    useMultiAccountStore.getState().addAccount(acct('u1'))
    useMultiAccountStore.getState().addAccount(acct('u2'))
    useMultiAccountStore.getState().removeAccount('u1')
    expect(useMultiAccountStore.getState().accounts.map((a) => a.userId)).toEqual(['u2'])
  })

  it('setActiveAccount 互斥激活 + 只更新被激活者的 lastActiveAt', () => {
    useMultiAccountStore.getState().addAccount(acct('u1', { isActive: true }))
    useMultiAccountStore.getState().addAccount(acct('u2'))
    useMultiAccountStore.getState().setActiveAccount('u2')
    const [u1, u2] = useMultiAccountStore.getState().accounts
    expect(u1.isActive).toBe(false)
    expect(u2.isActive).toBe(true)
    expect(u1.lastActiveAt).toBe('2026-07-01T00:00:00Z') // 未被动
    expect(u2.lastActiveAt).not.toBe('2026-07-01T00:00:00Z') // 更新为现在
  })

  it('getActiveAccount / getInactiveAccounts', () => {
    useMultiAccountStore.getState().addAccount(acct('u1', { isActive: true }))
    useMultiAccountStore.getState().addAccount(acct('u2'))
    expect(useMultiAccountStore.getState().getActiveAccount()?.userId).toBe('u1')
    expect(
      useMultiAccountStore
        .getState()
        .getInactiveAccounts()
        .map((a) => a.userId)
    ).toEqual(['u2'])
  })
})

describe('持久化安全(XOR 加密)', () => {
  it('localStorage 里不出现明文 refreshToken', async () => {
    useMultiAccountStore.getState().addAccount(acct('u1'))
    // zustand persist 写 localStorage 是同步/微任务级 — flush
    await new Promise((r) => setTimeout(r, 10))
    const raw = window.localStorage.getItem('arena-multi-accounts')
    expect(raw).toBeTruthy()
    expect(raw).not.toContain('secret-refresh-u1') // 明文绝不落 localStorage
  })

  it('store 内存中 token 保持明文可用(编码只在存储边界)', () => {
    useMultiAccountStore.getState().addAccount(acct('u1'))
    expect(useMultiAccountStore.getState().accounts[0].refreshToken).toBe('secret-refresh-u1')
  })
})
