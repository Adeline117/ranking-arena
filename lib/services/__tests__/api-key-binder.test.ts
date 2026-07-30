const mockValidateExchangeApiKey = jest.fn()
const mockEncrypt = jest.fn((value: string) => `cipher:${value}`)

jest.mock('@/lib/validators/api-key-validator', () => ({
  validateExchangeApiKey: (...args: unknown[]) => mockValidateExchangeApiKey(...args),
}))

jest.mock('@/lib/exchange/authorization-credentials', () => ({
  encryptAuthorizationCredential: (value: string) => mockEncrypt(value),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}))

import { bindApiKey } from '../api-key-binder'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const AUTHORIZATION_ID = '33333333-3333-4333-8333-333333333333'

function boundResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'bound',
    user_id: USER_ID,
    platform: 'binance_futures',
    trader_id: 'exchange-uid',
    connection_id: CONNECTION_ID,
    connection_generation: 1,
    authorization_id: AUTHORIZATION_ID,
    authorization_generation: 1,
    ...overrides,
  }
}

describe('bindApiKey lifecycle authority', () => {
  const rpc = jest.fn()
  const supabase = { rpc } as never

  beforeEach(() => {
    jest.clearAllMocks()
    mockValidateExchangeApiKey.mockResolvedValue({
      isValid: true,
      traderId: 'exchange-uid',
      permissions: ['read_balance'],
      nickname: 'main',
    })
    rpc.mockResolvedValue({ data: boundResult(), error: null })
  })

  it('stores connection proof and authorization through one atomic RPC', async () => {
    const result = await bindApiKey(supabase, USER_ID, {
      platform: 'BINANCE_FUTURES',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      label: ' Main account ',
      syncFrequency: '5min',
    })

    expect(result).toEqual({
      success: true,
      authorizationId: AUTHORIZATION_ID,
      traderId: 'exchange-uid',
      nickname: 'main',
      permissions: ['read_balance'],
    })
    expect(rpc).toHaveBeenCalledWith('bind_trader_authorization_for_active_profile_atomic', {
      p_user_id: USER_ID,
      p_platform: 'binance_futures',
      p_trader_id: 'exchange-uid',
      p_api_key_encrypted: 'cipher:api-key',
      p_api_secret_encrypted: 'cipher:api-secret',
      p_passphrase_encrypted: null,
      p_permissions: ['read_balance'],
      p_label: 'Main account',
      p_sync_frequency: '5min',
    })
  })

  it.each(['suspended', 'missing_account'])('rejects a %s lifecycle result', async (status) => {
    rpc.mockResolvedValue({ data: { status }, error: null })

    const result = await bindApiKey(supabase, USER_ID, {
      platform: 'binance_futures',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
    })

    expect(result).toEqual({
      success: false,
      reason: 'account_unavailable',
      error: 'Account unavailable',
    })
  })

  it('fails closed on a mismatched atomic acknowledgement', async () => {
    rpc.mockResolvedValue({
      data: boundResult({ user_id: '44444444-4444-4444-8444-444444444444' }),
      error: null,
    })

    const result = await bindApiKey(supabase, USER_ID, {
      platform: 'binance_futures',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
    })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('persistence_failed')
  })

  it('does not persist credentials rejected by the exchange validator', async () => {
    mockValidateExchangeApiKey.mockResolvedValue({
      isValid: false,
      error: 'not read-only',
    })

    const result = await bindApiKey(supabase, USER_ID, {
      platform: 'binance',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
    })

    expect(result).toEqual({
      success: false,
      reason: 'validation_failed',
      error: 'not read-only',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic transaction errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '40001' } })

    const result = await bindApiKey(supabase, USER_ID, {
      platform: 'binance',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
    })

    expect(result.success).toBe(false)
    expect(result.reason).toBe('persistence_failed')
  })
})
