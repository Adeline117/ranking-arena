/**
 * Jest mock for isomorphic-dompurify
 * Avoids jsdom/undici ReadableStream issue in test environment.
 * Returns input unchanged — DOMPurify behavior is trusted.
 */

const DOMPurify = {
  sanitize: (dirty: string, _config?: Record<string, unknown>) => dirty,
  setConfig: () => {},
  addHook: () => {},
}

export default DOMPurify
