/**
 * @jest-environment node
 */

const COPY_TRADING_ENV_KEYS = [
  'NEXT_PUBLIC_COPY_TRADING_ENABLED',
  'NEXT_PUBLIC_COPY_TRADING_BASE',
  'NEXT_PUBLIC_COPY_TRADING_BASE_SEPOLIA',
  'NEXT_PUBLIC_COPY_TRADING_ARBITRUM',
  'NEXT_PUBLIC_COPY_TRADING_OPTIMISM',
] as const

const VALID_TEST_ADDRESS = '0xa5cc3c03994DB5b0d9A5eEdD10CabaB0813678AC'
const VALID_TEST_ADDRESS_LOWERCASE = VALID_TEST_ADDRESS.toLowerCase()
const QUARANTINED_BASE_V1 = '0x84AfC435aF5a2d4C8535F8AA677Dc1501B0A9195'

type CopyTradingModules = {
  copyTrading: typeof import('../copy-trading')
  multiChain: typeof import('../multi-chain')
}

const originalEnv = Object.fromEntries(
  COPY_TRADING_ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof COPY_TRADING_ENV_KEYS)[number], string | undefined>

function clearCopyTradingEnv() {
  for (const key of COPY_TRADING_ENV_KEYS) delete process.env[key]
}

async function loadModules(env: Partial<Record<(typeof COPY_TRADING_ENV_KEYS)[number], string>>) {
  clearCopyTradingEnv()
  Object.assign(process.env, env)
  jest.resetModules()

  const copyTrading = await import('../copy-trading')
  const multiChain = await import('../multi-chain')
  return { copyTrading, multiChain } satisfies CopyTradingModules
}

describe('copy-trading product quarantine', () => {
  afterAll(() => {
    clearCopyTradingEnv()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) process.env[key] = value
    }
    jest.resetModules()
  })

  it('fails closed by default in both public configuration surfaces', async () => {
    const { copyTrading, multiChain } = await loadModules({})

    expect(copyTrading.COPY_TRADING_ADDRESSES[8453]).toBeUndefined()
    expect(copyTrading.isCopyTradingAvailable(8453)).toBe(false)
    expect(copyTrading.getCopyTradingAddress(8453)).toBeNull()
    expect(
      multiChain.CHAIN_CONFIGS[multiChain.CHAIN_IDS.BASE].contracts.copyTrading
    ).toBeUndefined()
  })

  it.each([undefined, '', 'false', 'TRUE', '1', ' true '])(
    'does not expose an address when the flag is %p',
    async (flag) => {
      const env: Partial<Record<(typeof COPY_TRADING_ENV_KEYS)[number], string>> = {
        NEXT_PUBLIC_COPY_TRADING_BASE: VALID_TEST_ADDRESS,
        NEXT_PUBLIC_COPY_TRADING_BASE_SEPOLIA: VALID_TEST_ADDRESS,
        NEXT_PUBLIC_COPY_TRADING_ARBITRUM: VALID_TEST_ADDRESS,
        NEXT_PUBLIC_COPY_TRADING_OPTIMISM: VALID_TEST_ADDRESS,
      }
      if (flag !== undefined) env.NEXT_PUBLIC_COPY_TRADING_ENABLED = flag

      const { copyTrading, multiChain } = await loadModules(env)

      const configuredChainIds = [
        multiChain.CHAIN_IDS.BASE,
        multiChain.CHAIN_IDS.BASE_SEPOLIA,
        multiChain.CHAIN_IDS.ARBITRUM,
        multiChain.CHAIN_IDS.OPTIMISM,
      ] as const

      for (const chainId of configuredChainIds) {
        expect(copyTrading.isCopyTradingAvailable(chainId)).toBe(false)
        expect(copyTrading.getCopyTradingAddress(chainId)).toBeNull()
        expect(multiChain.CHAIN_CONFIGS[chainId].contracts.copyTrading).toBeUndefined()
      }
    }
  )

  it.each([
    '0x_address',
    '0xa5cc3c03994db5b0d9a5eEdD10Cabab0813678ac',
    '0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000001',
    '0x1111111111111111111111111111111111111111',
    '0x1212121212121212121212121212121212121212',
    '0x1234567890123456789012345678901234567890',
    '0x000000000000000000000000000000000000dEaD',
  ])('rejects invalid or placeholder address %s even when enabled', async (address) => {
    const { copyTrading, multiChain } = await loadModules({
      NEXT_PUBLIC_COPY_TRADING_ENABLED: 'true',
      NEXT_PUBLIC_COPY_TRADING_BASE: address,
    })

    expect(copyTrading.isCopyTradingAvailable(8453)).toBe(false)
    expect(copyTrading.getCopyTradingAddress(8453)).toBeNull()
    expect(
      multiChain.CHAIN_CONFIGS[multiChain.CHAIN_IDS.BASE].contracts.copyTrading
    ).toBeUndefined()
  })

  it.each([QUARANTINED_BASE_V1, QUARANTINED_BASE_V1.toLowerCase()])(
    'permanently rejects the quarantined Base v1 address variant %s',
    async (address) => {
      const { copyTrading, multiChain } = await loadModules({
        NEXT_PUBLIC_COPY_TRADING_ENABLED: 'true',
        NEXT_PUBLIC_COPY_TRADING_BASE: address,
      })

      expect(copyTrading.isCopyTradingAvailable(8453)).toBe(false)
      expect(copyTrading.getCopyTradingAddress(8453)).toBeNull()
      expect(
        multiChain.CHAIN_CONFIGS[multiChain.CHAIN_IDS.BASE].contracts.copyTrading
      ).toBeUndefined()
    }
  )

  it('normalizes a valid non-placeholder address only behind the exact true flag', async () => {
    const { copyTrading, multiChain } = await loadModules({
      NEXT_PUBLIC_COPY_TRADING_ENABLED: 'true',
      NEXT_PUBLIC_COPY_TRADING_BASE: `  ${VALID_TEST_ADDRESS_LOWERCASE}  `,
    })

    expect(copyTrading.isCopyTradingAvailable(8453)).toBe(true)
    expect(copyTrading.getCopyTradingAddress(8453)).toBe(VALID_TEST_ADDRESS)
    expect(copyTrading.getCopyTradingAddress(84532)).toBeNull()
    expect(multiChain.CHAIN_CONFIGS[multiChain.CHAIN_IDS.BASE].contracts.copyTrading).toBe(
      VALID_TEST_ADDRESS
    )
    expect(
      multiChain.CHAIN_CONFIGS[multiChain.CHAIN_IDS.BASE_SEPOLIA].contracts.copyTrading
    ).toBeUndefined()
  })
})
