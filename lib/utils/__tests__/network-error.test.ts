import {
  isNetworkError,
  isOffline,
  getNetworkErrorMessage,
  isRetryableError,
} from '../network-error'

const t = (k: string) => k

// 控制 navigator.onLine
function setOnline(online: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  })
}

afterEach(() => setOnline(true)) // 复位

describe('isNetworkError', () => {
  it('TypeError 且消息含 fetch → true', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('TypeError 但消息不含 fetch → false', () => {
    expect(isNetworkError(new TypeError('x is not a function'))).toBe(false)
  })

  it('DOMException AbortError → true', () => {
    expect(isNetworkError(new DOMException('aborted', 'AbortError'))).toBe(true)
  })

  it('DOMException NetworkError → true', () => {
    expect(isNetworkError(new DOMException('net', 'NetworkError'))).toBe(true)
  })

  it('普通 Error / 其他 → false', () => {
    expect(isNetworkError(new Error('boom'))).toBe(false)
    expect(isNetworkError('string error')).toBe(false)
    expect(isNetworkError(null)).toBe(false)
  })
})

describe('isOffline', () => {
  it('navigator.onLine=false → true', () => {
    setOnline(false)
    expect(isOffline()).toBe(true)
  })

  it('navigator.onLine=true → false', () => {
    setOnline(true)
    expect(isOffline()).toBe(false)
  })
})

describe('getNetworkErrorMessage — 优先级', () => {
  it('离线优先于一切', () => {
    setOnline(false)
    // 即便是超时错误，离线时也先报离线
    expect(getNetworkErrorMessage(new DOMException('t', 'AbortError'), t)).toBe('offlineError')
  })

  it('在线 + 超时 → requestTimeout', () => {
    setOnline(true)
    expect(getNetworkErrorMessage(new DOMException('t', 'AbortError'), t)).toBe('requestTimeout')
  })

  it('在线 + 网络错误 → networkError', () => {
    setOnline(true)
    expect(getNetworkErrorMessage(new TypeError('Failed to fetch'), t)).toBe('networkError')
  })

  it('在线 + 未知错误 → unknownError', () => {
    setOnline(true)
    expect(getNetworkErrorMessage(new Error('weird'), t)).toBe('unknownError')
  })
})

describe('isRetryableError', () => {
  it('网络错误 → 可重试', () => {
    setOnline(true)
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('离线 → 可重试（即便错误本身非网络类）', () => {
    setOnline(false)
    expect(isRetryableError(new Error('anything'))).toBe(true)
  })

  it('在线 + 非网络错误 → 不可重试', () => {
    setOnline(true)
    expect(isRetryableError(new Error('logic error'))).toBe(false)
  })
})
