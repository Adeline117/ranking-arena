/**
 * ClickHouse client lifecycle tests. The package is a virtual in-memory mock,
 * so configured tests verify behavior without DNS, HTTP, or socket access.
 */

const mockCreateClient = jest.fn()
const mockModuleLoad = jest.fn()
const mockLoggerInfo = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}))

jest.mock(
  '@clickhouse/client',
  () => {
    mockModuleLoad()
    return { createClient: mockCreateClient }
  },
  { virtual: true }
)

type ClickHouseModule = typeof import('../clickhouse')

async function loadClickHouseModule(): Promise<ClickHouseModule> {
  let module!: ClickHouseModule
  await jest.isolateModulesAsync(async () => {
    module = await import('../clickhouse')
  })
  return module
}

function createClientDouble() {
  const json = jest.fn().mockResolvedValue([{ id: 'row-1' }])
  return {
    client: {
      insert: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({
        json,
        text: jest.fn().mockResolvedValue(''),
      }),
      close: jest.fn().mockResolvedValue(undefined),
    },
    json,
  }
}

describe('ClickHouse client lifecycle', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    delete process.env.CLICKHOUSE_URL
    delete process.env.CLICKHOUSE_DATABASE
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('is a true no-op and does not load the package without CLICKHOUSE_URL', async () => {
    const clickhouse = await loadClickHouseModule()

    await expect(clickhouse.getClickHouseClient()).resolves.toBeNull()
    await expect(clickhouse.insertBatch('metrics', [{ id: '1' }])).resolves.toBe(0)
    await expect(clickhouse.query('SELECT 1')).resolves.toBeNull()

    expect(mockModuleLoad).not.toHaveBeenCalled()
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('loads once lazily and reuses the configured client', async () => {
    process.env.CLICKHOUSE_URL = 'https://clickhouse.invalid'
    process.env.CLICKHOUSE_DATABASE = 'arena_test'
    const { client, json } = createClientDouble()
    mockCreateClient.mockReturnValue(client)
    const clickhouse = await loadClickHouseModule()

    await expect(clickhouse.insertBatch('metrics', [{ id: '1' }])).resolves.toBe(1)
    await expect(clickhouse.query<{ id: string }>('SELECT id FROM metrics')).resolves.toEqual([
      { id: 'row-1' },
    ])

    expect(mockModuleLoad).toHaveBeenCalledTimes(1)
    expect(mockCreateClient).toHaveBeenCalledTimes(1)
    expect(client.insert).toHaveBeenCalledWith({
      table: 'metrics',
      values: [{ id: '1' }],
      format: 'JSONEachRow',
    })
    expect(json).toHaveBeenCalledTimes(1)
  })

  it('surfaces and caches a configured initialization failure', async () => {
    process.env.CLICKHOUSE_URL = 'https://clickhouse.invalid'
    process.env.CLICKHOUSE_DATABASE = 'arena_test'
    const cause = new Error('invalid client configuration')
    mockCreateClient.mockImplementation(() => {
      throw cause
    })
    const clickhouse = await loadClickHouseModule()

    const firstAttempt = clickhouse.getClickHouseClient()
    await expect(firstAttempt).rejects.toMatchObject({
      name: 'ClickHouseInitializationError',
      code: 'CLICKHOUSE_INITIALIZATION_FAILED',
      cause,
    })
    await expect(clickhouse.getClickHouseClient()).rejects.toBeInstanceOf(
      clickhouse.ClickHouseInitializationError
    )

    expect(mockCreateClient).toHaveBeenCalledTimes(1)
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[ClickHouse] Client initialization failed:',
      'ClickHouse is configured but the client could not be initialized'
    )
  })

  it('propagates a configured insert failure to the dual-write boundary', async () => {
    process.env.CLICKHOUSE_URL = 'https://clickhouse.invalid'
    process.env.CLICKHOUSE_DATABASE = 'arena_test'
    const insertError = new Error('insert rejected')
    const { client } = createClientDouble()
    client.insert.mockRejectedValueOnce(insertError)
    mockCreateClient.mockReturnValue(client)
    const clickhouse = await loadClickHouseModule()

    await expect(clickhouse.insertBatch('metrics', [{ id: '1' }])).rejects.toBe(insertError)
  })
})
