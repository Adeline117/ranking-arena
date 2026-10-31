import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

class MockResponse {
  constructor(private readonly body: string) {}

  async json() {
    return JSON.parse(this.body)
  }
}

describe('service worker push viewer isolation', () => {
  it('shows account-scoped pushes only for the persisted active viewer', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>()
    const stored = new Map<string, string>()
    const showNotification = jest.fn().mockResolvedValue(undefined)
    const cache = {
      addAll: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(async (key: string) => stored.delete(key)),
      put: jest.fn(async (key: string, response: MockResponse) => {
        stored.set(key, JSON.stringify(await response.json()))
      }),
      match: jest.fn(async (key: string) => {
        const body = stored.get(key)
        return body ? new MockResponse(body) : undefined
      }),
    }
    const caches = {
      open: jest.fn().mockResolvedValue(cache),
      keys: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(true),
      match: jest.fn().mockResolvedValue(undefined),
    }
    const self = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners.set(type, listener)
      },
      registration: { showNotification },
      clients: { claim: jest.fn() },
      skipWaiting: jest.fn(),
    }

    vm.runInNewContext(readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8'), {
      self,
      caches,
      clients: { matchAll: jest.fn(), openWindow: jest.fn() },
      fetch: jest.fn(),
      Response: MockResponse,
    })

    let pending: Promise<unknown> | undefined
    listeners.get('message')?.({
      data: { type: 'SET_ACTIVE_PUSH_VIEWER', userId: 'user-a' },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise
      },
    })
    await pending

    const dispatchPush = async (recipientUserId: string) => {
      listeners.get('push')?.({
        data: {
          json: () => ({
            type: 'rank_change',
            title: 'Private alert',
            body: 'body',
            recipientUserId,
          }),
        },
        waitUntil: (promise: Promise<unknown>) => {
          pending = promise
        },
      })
      await pending
    }

    await dispatchPush('user-b')
    expect(showNotification).not.toHaveBeenCalled()

    await dispatchPush('user-a')
    expect(showNotification).toHaveBeenCalledTimes(1)
  })
})
