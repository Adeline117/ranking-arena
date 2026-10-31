/**
 * Runtime-neutral access to the active request correlation ID.
 *
 * The API layer owns the Node.js AsyncLocalStorage implementation and installs
 * its reader here. Shared modules such as logging, caching, and Supabase may be
 * bundled for Client or Edge runtimes, so they depend only on this import-free
 * bridge instead of probing a Node-only module with a dynamic require.
 */

export type CorrelationIdReader = () => string | undefined

let correlationIdReader: CorrelationIdReader = () => undefined

/**
 * Register the single runtime owner that can read the active request context.
 * The disposer is primarily for isolated tests and development hot reloads.
 */
export function installCorrelationIdReader(reader: CorrelationIdReader): () => void {
  const previousReader = correlationIdReader
  correlationIdReader = reader

  return () => {
    if (correlationIdReader === reader) {
      correlationIdReader = previousReader
    }
  }
}

/** Read the active correlation ID, or `undefined` outside a bound request. */
export function readCorrelationId(): string | undefined {
  return correlationIdReader()
}
