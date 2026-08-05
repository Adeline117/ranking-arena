import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const serviceWorkerPath = resolve(__dirname, '../../public/sw.js')

describe('service worker offline cache contract', () => {
  it('caches only the fallback document and never intercepts ranking APIs', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>()
    const fallback = { kind: 'offline-document' }
    const addAll = jest.fn().mockResolvedValue(undefined)
    const cache = {
      addAll,
      delete: jest.fn(),
      put: jest.fn(),
      match: jest.fn(),
    }
    const caches = {
      open: jest.fn().mockResolvedValue(cache),
      keys: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
      match: jest.fn().mockResolvedValue(fallback),
    }
    const networkFetch = jest.fn().mockRejectedValue(new Error('offline'))
    const self = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener)
      },
      registration: { showNotification: jest.fn() },
      clients: { claim: jest.fn() },
      skipWaiting: jest.fn(),
    }

    vm.runInNewContext(readFileSync(serviceWorkerPath, 'utf8'), {
      self,
      caches,
      clients: { matchAll: jest.fn(), openWindow: jest.fn() },
      fetch: networkFetch,
      Response: class {},
    })

    let pending: Promise<unknown> | undefined
    listeners.get('install')?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise
      },
    })
    await pending

    expect(caches.open).toHaveBeenCalledWith('ranking-arena-v5')
    expect(addAll).toHaveBeenCalledWith(['/offline'])

    const apiRespondWith = jest.fn()
    listeners.get('fetch')?.({
      request: { mode: 'cors', url: 'https://arenafi.org/api/traders' },
      respondWith: apiRespondWith,
    })
    expect(apiRespondWith).not.toHaveBeenCalled()
    expect(networkFetch).not.toHaveBeenCalled()

    let navigationResponse: Promise<unknown> | undefined
    listeners.get('fetch')?.({
      request: { mode: 'navigate', url: 'https://arenafi.org/rankings' },
      respondWith: (response: Promise<unknown>) => {
        navigationResponse = response
      },
    })

    await expect(navigationResponse).resolves.toBe(fallback)
    expect(caches.match).toHaveBeenCalledWith('/offline')
  })
})
