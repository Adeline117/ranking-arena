import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import {
  bindApiKey,
  disconnectApiKey,
  isDisconnectableAccountExchange,
  revokeApiKey,
} from '../api-key-binder'
import { validateExchangeApiKey } from '@/lib/validators/api-key-validator'
import { encryptAuthorizationCredential } from '@/lib/exchange/authorization-credentials'

jest.mock('@/lib/validators/api-key-validator', () => ({
  validateExchangeApiKey: jest.fn(),
}))

jest.mock('@/lib/exchange/authorization-credentials', () => ({
  encryptAuthorizationCredential: jest.fn((value: string) => `encrypted:${value}`),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}))

const mockValidateExchangeApiKey = validateExchangeApiKey as jest.MockedFunction<
  typeof validateExchangeApiKey
>
const mockEncryptAuthorizationCredential = encryptAuthorizationCredential as jest.MockedFunction<
  typeof encryptAuthorizationCredential
>

const AUTHORIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function createSupabaseFixture(
  result: { data: unknown; error: { code?: string; message?: string } | null } = {
    data: AUTHORIZATION_ID,
    error: null,
  }
) {
  const rpc = jest.fn().mockResolvedValue(result)

  return {
    client: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
  }
}

describe('bindApiKey first-party account connection contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockValidateExchangeApiKey.mockResolvedValue({
      isValid: true,
      traderId: 'exchange-uid-42',
      permissions: ['read'],
    })
  })

  it.each(['binance', 'bybit', 'bitget'])(
    'stores V1 base platform %s through exactly one atomic RPC',
    async (platform) => {
      const { client, rpc } = createSupabaseFixture()

      await expect(
        bindApiKey(client, '11111111-1111-4111-8111-111111111111', {
          platform,
          apiKey: 'api-key',
          apiSecret: 'api-secret',
          passphrase: platform === 'bitget' ? 'passphrase' : undefined,
        })
      ).resolves.toMatchObject({
        success: true,
        authorizationId: AUTHORIZATION_ID,
        traderId: 'exchange-uid-42',
      })

      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc).toHaveBeenCalledWith('bind_trader_account_connection_v1', {
        p_user_id: '11111111-1111-4111-8111-111111111111',
        p_platform: platform,
        p_trader_id: 'exchange-uid-42',
        p_encrypted_api_key: 'encrypted:api-key',
        p_encrypted_api_secret: 'encrypted:api-secret',
        p_encrypted_passphrase: platform === 'bitget' ? 'encrypted:passphrase' : null,
        p_permissions: ['read'],
        p_verified_at: expect.any(String),
        p_label: null,
        p_sync_frequency: 'realtime',
      })
      expect(mockEncryptAuthorizationCredential).toHaveBeenCalledWith('api-key')
    }
  )

  it('fails closed on an RPC error without attempting a compensating table write', async () => {
    const { client, rpc } = createSupabaseFixture({
      data: null,
      error: { code: 'XX000', message: 'atomic projection rolled back' },
    })

    await expect(
      bindApiKey(client, '11111111-1111-4111-8111-111111111111', {
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    ).resolves.toEqual({
      success: false,
      error: 'Failed to store API key binding. Please try again.',
      errorCode: 'storage_failed',
    })

    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic RPC does not return an authorization id', async () => {
    const { client, rpc } = createSupabaseFixture({ data: null, error: null })

    await expect(
      bindApiKey(client, '11111111-1111-4111-8111-111111111111', {
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    ).resolves.toEqual({
      success: false,
      error: 'Failed to store API key binding. Please try again.',
      errorCode: 'storage_failed',
    })

    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed instead of inventing a read permission when evidence is empty', async () => {
    mockValidateExchangeApiKey.mockResolvedValue({
      isValid: true,
      traderId: 'exchange-uid-42',
      permissions: [],
    })
    const { client, rpc } = createSupabaseFixture()

    await expect(
      bindApiKey(client, '11111111-1111-4111-8111-111111111111', {
        platform: ' Binance ',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
        label: ' Primary ',
        syncFrequency: '5min',
      })
    ).resolves.toEqual({
      success: false,
      error: 'Exchange did not return auditable read-only permission evidence.',
      errorCode: 'validation_failed',
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    'binance_spot',
    'binance_futures',
    'bybit_spot',
    'okx',
    'okx_spot',
    'okx_futures',
    'bitget_spot',
    'bitget_futures',
    'gateio',
  ])('does not call the validator or database for non-V1 source %s', async (platform) => {
    const { client, rpc } = createSupabaseFixture()

    await expect(
      bindApiKey(client, '11111111-1111-4111-8111-111111111111', {
        platform,
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    ).resolves.toMatchObject({ success: false })

    expect(mockValidateExchangeApiKey).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('API key account lifecycle revocation contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('revokes by authorization ID through exactly one atomic RPC', async () => {
    const { client, rpc } = createSupabaseFixture({ data: true, error: null })

    await expect(
      revokeApiKey(
        client,
        '11111111-1111-4111-8111-111111111111',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      )
    ).resolves.toEqual({ success: true })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('revoke_trader_account_connection_v1', {
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_authorization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      p_exchange: null,
    })
  })

  it('disconnects by canonical exchange through exactly one atomic RPC', async () => {
    const { client, rpc } = createSupabaseFixture({ data: true, error: null })

    await expect(
      disconnectApiKey(client, '11111111-1111-4111-8111-111111111111', 'binance')
    ).resolves.toEqual({ success: true })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('revoke_trader_account_connection_v1', {
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_authorization_id: null,
      p_exchange: 'binance',
    })
  })

  it.each([
    'binance_futures',
    'binance_spot',
    'bybit_spot',
    'okx_futures',
    'okx_spot',
    'bitget_futures',
    'bitget_spot',
    'mexc',
    'htx',
    'weex',
    'coinex',
  ])('keeps the proven historical %s account key safely disconnectable', async (exchange) => {
    const { client, rpc } = createSupabaseFixture({ data: true, error: null })

    await expect(
      disconnectApiKey(client, '11111111-1111-4111-8111-111111111111', ` ${exchange} `)
    ).resolves.toEqual({ success: true })
    expect(rpc).toHaveBeenCalledWith('revoke_trader_account_connection_v1', {
      p_user_id: '11111111-1111-4111-8111-111111111111',
      p_authorization_id: null,
      p_exchange: exchange,
    })
  })

  it.each(['gmx', 'gate', 'gateio', 'kucoin', 'mexc_spot', 'bybit_futures', ''])(
    'rejects non-account or guessed historical key %j before invoking the RPC',
    async (exchange) => {
      const { client, rpc } = createSupabaseFixture({ data: true, error: null })

      await expect(
        disconnectApiKey(client, '11111111-1111-4111-8111-111111111111', exchange)
      ).resolves.toEqual({
        success: false,
        error: 'Account connection not found',
        errorCode: 'not_found',
      })
      expect(rpc).not.toHaveBeenCalled()
      expect(isDisconnectableAccountExchange(exchange)).toBe(false)
    }
  )

  it('maps a false RPC result to a non-enumerating not-found result', async () => {
    const { client } = createSupabaseFixture({ data: false, error: null })

    await expect(
      revokeApiKey(
        client,
        '11111111-1111-4111-8111-111111111111',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      )
    ).resolves.toEqual({
      success: false,
      error: 'Account connection not found',
      errorCode: 'not_found',
    })
  })

  it('fails closed on an atomic revocation RPC error', async () => {
    const { client, rpc } = createSupabaseFixture({
      data: null,
      error: { code: 'XX000', message: 'forced rollback' },
    })

    await expect(
      disconnectApiKey(client, '11111111-1111-4111-8111-111111111111', 'bybit')
    ).resolves.toEqual({
      success: false,
      error: 'Failed to revoke API key',
      errorCode: 'storage_failed',
    })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the RPC client throws', async () => {
    const rpc = jest.fn().mockRejectedValue(new Error('transport failed'))
    const client = { rpc } as unknown as SupabaseClient<Database>

    await expect(
      disconnectApiKey(client, '11111111-1111-4111-8111-111111111111', 'bitget')
    ).resolves.toEqual({
      success: false,
      error: 'Failed to revoke API key',
      errorCode: 'storage_failed',
    })
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
