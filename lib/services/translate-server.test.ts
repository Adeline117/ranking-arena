import { translateText, translateWithGoogle } from './translate-server'

describe('server translation request cancellation', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('passes a composed caller signal to the translation request', async () => {
    const controller = new AbortController()
    const fetchMock = jest.fn().mockImplementation(async (_url, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal).not.toBe(controller.signal)
      return {
        ok: true,
        json: async () => [[['比特币上涨', 'Bitcoin rises']]],
      }
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(
      translateText('Bitcoin rises', 'zh', 'en', 4_000, controller.signal)
    ).resolves.toBe('比特币上涨')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels through an already-aborted caller signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = jest.fn().mockImplementation(async (_url, init: RequestInit) => {
      if ((init.signal as AbortSignal).aborted) {
        throw new DOMException('aborted', 'AbortError')
      }
      throw new Error('expected an aborted request signal')
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(
      translateWithGoogle('Bitcoin rises', 'zh', 'en', 4_000, controller.signal)
    ).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
