import { resolveSiweRequestOrigin } from '../siwe-origin'

const originalNodeEnv = process.env.NODE_ENV

function request(origin: string | null, host: string | null) {
  return {
    headers: {
      get(name: string) {
        if (name === 'origin') return origin
        if (name === 'host') return host
        return null
      },
    },
  } as unknown as import('next/server').NextRequest
}

describe('SIWE request origin authority', () => {
  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: originalNodeEnv,
    })
  })

  it.each([
    ['https://www.arenafi.org', 'www.arenafi.org'],
    ['https://arenafi.org', 'arenafi.org'],
  ])('accepts an exact production tuple: %s', (origin, host) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', writable: true })

    expect(resolveSiweRequestOrigin(request(origin, host))).toEqual({ domain: host, origin })
  })

  it('accepts matching localhost only outside production', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'test', writable: true })

    expect(resolveSiweRequestOrigin(request('http://localhost:3010', 'localhost:3010'))).toEqual({
      domain: 'localhost:3010',
      origin: 'http://localhost:3010',
    })
  })

  it.each([
    ['http://localhost:3000', 'localhost:3000'],
    ['https://www.arenafi.org', 'arenafi.org'],
    ['https://arenafi.org', 'www.arenafi.org'],
    ['https://www.arenafi.org.evil.example', 'www.arenafi.org.evil.example'],
    ['https://evil.example', 'evil.example'],
    [null, 'www.arenafi.org'],
    ['https://www.arenafi.org', null],
  ])('rejects an untrusted production tuple: %s / %s', (origin, host) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', writable: true })

    expect(resolveSiweRequestOrigin(request(origin, host))).toBeNull()
  })
})
