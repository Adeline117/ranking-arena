jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))
const mockResolve = jest.fn()
jest.mock('../exchange-uid-resolver', () => ({
  resolveExchangeUid: (...args: unknown[]) => mockResolve(...args),
}))

import {
  validateExchangeApiKey,
  hasRequiredPermissions,
  type ApiKeyValidationResult,
} from '../api-key-validator'

const creds = { apiKey: 'k', apiSecret: 's' }
const credsWithPass = { ...creds, passphrase: 'p' }

beforeEach(() => {
  mockResolve.mockReset()
})

describe('validateExchangeApiKey — 路由', () => {
  it('binance 别名都路由到 binance resolver', async () => {
    mockResolve.mockResolvedValue({ success: true, uid: '123', nickname: 'me' })
    for (const p of ['binance', 'binance_futures', 'binance_spot', 'BINANCE']) {
      await validateExchangeApiKey(p, creds)
      expect(mockResolve).toHaveBeenLastCalledWith('binance', creds)
    }
  })

  it('平台名大小写不敏感', async () => {
    mockResolve.mockResolvedValue({ success: true, uid: '1' })
    const r = await validateExchangeApiKey('ByBit', creds)
    expect(mockResolve).toHaveBeenCalledWith('bybit', creds)
    expect(r.isValid).toBe(true)
  })

  it('未支持平台 → error，不调 resolver', async () => {
    const r = await validateExchangeApiKey('ftx', creds)
    expect(r.isValid).toBe(false)
    expect(r.error).toContain('Unsupported platform')
    expect(mockResolve).not.toHaveBeenCalled()
  })
})

describe('passphrase 守卫（OKX/Bitget）', () => {
  it('OKX 缺 passphrase → error，不调 resolver', async () => {
    const r = await validateExchangeApiKey('okx', creds)
    expect(r.isValid).toBe(false)
    expect(r.error).toContain('Passphrase is required for OKX')
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('Bitget 缺 passphrase → error', async () => {
    const r = await validateExchangeApiKey('bitget', creds)
    expect(r.isValid).toBe(false)
    expect(r.error).toContain('Passphrase is required for Bitget')
  })

  it('OKX 带 passphrase → 正常走 resolver', async () => {
    mockResolve.mockResolvedValue({ success: true, uid: 'okx-1' })
    const r = await validateExchangeApiKey('okx', credsWithPass)
    expect(r.isValid).toBe(true)
    expect(r.traderId).toBe('okx-1')
    expect(r.permissions).toContain('read_balance')
  })
})

describe('resolver 结果映射', () => {
  it('成功 → isValid + traderId + nickname', async () => {
    mockResolve.mockResolvedValue({ success: true, uid: 'u9', nickname: 'whale' })
    const r = await validateExchangeApiKey('binance', creds)
    expect(r).toMatchObject({ isValid: true, traderId: 'u9', nickname: 'whale' })
  })

  it('resolver 失败 → isValid false + 透传 error', async () => {
    mockResolve.mockResolvedValue({ success: false, error: 'bad signature' })
    const r = await validateExchangeApiKey('binance', creds)
    expect(r.isValid).toBe(false)
    expect(r.error).toBe('bad signature')
  })

  it('resolver 失败无 error → 兜底 Invalid API key', async () => {
    mockResolve.mockResolvedValue({ success: false })
    const r = await validateExchangeApiKey('bybit', creds)
    expect(r.error).toBe('Invalid API key')
  })

  it('resolver 抛异常 → 捕获，不泄漏，返回通用 error', async () => {
    mockResolve.mockRejectedValue(new Error('network boom'))
    const r = await validateExchangeApiKey('binance', creds)
    expect(r.isValid).toBe(false)
    expect(r.error).toBe('Failed to validate API key') // 不透传内部异常细节
  })
})

describe('hasRequiredPermissions', () => {
  const ok = (perms: string[]): ApiKeyValidationResult => ({ isValid: true, permissions: perms })

  it('拥有全部所需权限 → true', () => {
    expect(hasRequiredPermissions(ok(['read', 'trade']), ['read'])).toBe(true)
    expect(hasRequiredPermissions(ok(['read', 'trade']), ['read', 'trade'])).toBe(true)
  })

  it('缺任一所需权限 → false', () => {
    expect(hasRequiredPermissions(ok(['read']), ['read', 'trade'])).toBe(false)
  })

  it('结果无效 → false（即使传了权限）', () => {
    expect(hasRequiredPermissions({ isValid: false, permissions: ['read'] }, ['read'])).toBe(false)
  })

  it('无 permissions 字段 → false', () => {
    expect(hasRequiredPermissions({ isValid: true }, ['read'])).toBe(false)
  })

  it('空 required → true（无要求即满足）', () => {
    expect(hasRequiredPermissions(ok(['read']), [])).toBe(true)
  })
})
