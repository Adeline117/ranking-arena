import { getWebAuthnConfig } from '../webauthn'

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

describe('WebAuthn ceremony origin authority', () => {
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
  ])('accepts an exact production Origin/Host tuple: %s', (origin, host) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', writable: true })

    expect(getWebAuthnConfig(request(origin, host))).toEqual({
      rpID: 'arenafi.org',
      origin,
      rpName: 'Arena',
    })
  })

  it('accepts matching localhost only outside production', () => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'test', writable: true })

    expect(getWebAuthnConfig(request('http://localhost:3210', 'localhost:3210'))).toEqual({
      rpID: 'localhost',
      origin: 'http://localhost:3210',
      rpName: 'Arena',
    })
  })

  it.each([
    ['http://localhost:3000', 'localhost:3000', 'production localhost'],
    ['https://www.arenafi.org', 'arenafi.org', 'Host mismatch'],
    ['https://arenafi.org', 'www.arenafi.org', 'Origin mismatch'],
    ['https://www.arenafi.org.evil.example', 'www.arenafi.org.evil.example', 'suffix attack'],
    ['https://evil.example', 'evil.example', 'unrecognized origin'],
    [null, 'www.arenafi.org', 'missing Origin'],
    ['https://www.arenafi.org', null, 'missing Host'],
  ])('rejects %s (%s / %s)', (origin, host) => {
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', writable: true })

    expect(() => getWebAuthnConfig(request(origin, host))).toThrow('Unrecognized WebAuthn origin')
  })
})
