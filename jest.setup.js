// Jest setup file

// Polyfill for Web APIs (needed for Next.js API routes)
import { TextEncoder, TextDecoder } from 'util'
global.TextEncoder = TextEncoder
global.TextDecoder = TextDecoder

import '@testing-library/jest-dom'

// Node.js 18+ has native fetch, no polyfill needed
// Just ensure globals are set
if (typeof globalThis.fetch === 'undefined') {
  console.warn('Warning: fetch not available, some tests may fail')
}

// Mock Request/Response for API route tests (fallback)
if (typeof Request === 'undefined') {
  global.Request = class Request {
    constructor(url, init = {}) {
      this.url = url
      this.method = init.method || 'GET'
      this.headers = new Map(Object.entries(init.headers || {}))
      this._body = init.body
    }
    async json() {
      return JSON.parse(this._body)
    }
    async formData() {
      return this._body
    }
  }
}

if (typeof Response === 'undefined') {
  global.Response = class Response {
    constructor(body, init = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map(Object.entries(init.headers || {}))
    }
    async json() {
      return JSON.parse(this._body)
    }
  }
}

// Polyfill Response.json static helper — node <20 and the jest Response stub
// don't ship with it, but next/server's NextResponse.json() calls into it.
if (typeof Response !== 'undefined' && typeof Response.json !== 'function') {
  Response.json = (body, init = {}) => new Response(JSON.stringify(body), init)
}

if (typeof Headers === 'undefined') {
  global.Headers = class Headers extends Map {}
}

if (typeof FormData === 'undefined') {
  global.FormData = class FormData {
    constructor() {
      this._data = new Map()
    }
    append(key, value) {
      this._data.set(key, value)
    }
    get(key) {
      return this._data.get(key)
    }
  }
}

// Mock Next.js router
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

// ---------------------------------------------------------------------------
// Global mock: @/lib/utils/logger
// Provides all named exports so that lib/logger.ts re-exports work correctly.
// Individual test files may override this with their own jest.mock() calls.
// ---------------------------------------------------------------------------
const _mockLoggerInstance = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  log: jest.fn(),
  apiError: jest.fn(),
  dbError: jest.fn(),
}
jest.mock('@/lib/utils/logger', () => {
  const inst = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
  return {
    logger: inst,
    apiLogger: inst,
    dataLogger: inst,
    authLogger: inst,
    perfLogger: inst,
    exchangeLogger: inst,
    realtimeLogger: inst,
    createLogger: jest.fn(() => inst),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
    fireAndForget: jest.fn(),
    Logger: jest.fn(() => inst),
  }
})

// Global mock: @/lib/analytics/dual-write
jest.mock('@/lib/analytics/dual-write', () => ({
  syncToClickHouse: jest.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Global mock: @/lib/logger (re-export shim)
// Prevents "Cannot read properties of undefined (reading 'error')" at lib/logger.ts:26
// when lib/supabase/server.ts or other modules import from @/lib/logger.
// ---------------------------------------------------------------------------
jest.mock('@/lib/logger', () => {
  const inst = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
  return {
    __esModule: true,
    default: inst,
    logger: inst,
    apiLogger: inst,
    dataLogger: inst,
    authLogger: inst,
    perfLogger: inst,
    createLogger: jest.fn(() => inst),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
    logInfo: jest.fn(),
    logDebug: jest.fn(),
    logApiError: jest.fn(),
    logDbError: jest.fn(),
    fireAndForget: jest.fn(),
  }
})

// ---------------------------------------------------------------------------
// Proxy-based Supabase chain builder — returns itself for any chained call,
// resolves via .then() so `await` works.  Tests override specific methods.
// ---------------------------------------------------------------------------
function _createSupabaseChain(defaultResult = { data: null, error: null }) {
  const chain = new Proxy({}, {
    get(target, prop) {
      if (prop === 'then') {
        return (resolve) => Promise.resolve(defaultResult).then(resolve)
      }
      if (prop === Symbol.iterator || prop === Symbol.toPrimitive) return undefined
      // Return a jest.fn that returns the chain itself (for chaining), but is
      // also thenable so `await chain.method()` works.
      if (!target[prop]) {
        target[prop] = jest.fn((..._args) => chain)
      }
      return target[prop]
    },
  })
  return chain
}

// Mock Supabase client
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      getUser: jest.fn().mockResolvedValue({ data: { user: null } }),
      onAuthStateChange: jest.fn().mockReturnValue({
        data: { subscription: { unsubscribe: jest.fn() } },
      }),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      filter: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      contains: jest.fn().mockReturnThis(),
      containedBy: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}))

// ---------------------------------------------------------------------------
// Global mock: @/lib/utils/rate-limit
// Prevents Redis connection attempts in tests using withAuth/withApiMiddleware
// ---------------------------------------------------------------------------
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null), // null = not rate limited
  RateLimitPresets: {
    standard: { windowMs: 60000, maxRequests: 100 },
    strict: { windowMs: 60000, maxRequests: 10 },
    lenient: { windowMs: 60000, maxRequests: 1000 },
  },
}))

// ---------------------------------------------------------------------------
// Global mock: @/lib/cache/redis
// Prevents Upstash Redis connection in tests
// ---------------------------------------------------------------------------
jest.mock('@/lib/cache/redis-client', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
  },
  getRedis: jest.fn(),
}))

// Mock localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}
global.localStorage = localStorageMock

// Mock matchMedia (only in browser environment)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  })
}
