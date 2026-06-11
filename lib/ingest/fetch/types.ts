/**
 * Fetch-layer contracts. The implementations (fetcher.ts, capture.ts) touch
 * Playwright and must only ever be imported by the worker — app/** code may
 * import THIS types-only module but nothing else under lib/ingest/fetch/.
 */

export interface ReplayRequestTemplate {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  /** POST body template (JSON-serializable). */
  body?: unknown
}

export interface EndpointCapture {
  /** Resolves with the first captured request matching the matcher. */
  first(timeoutMs?: number): Promise<CapturedExchange>
  /** All captured exchanges so far. */
  all(): CapturedExchange[]
  /** Stop listening. */
  dispose(): void
}

export interface CapturedExchange {
  template: ReplayRequestTemplate
  /** The response payload of the captured exchange (already JSON-parsed). */
  responseJson: unknown
  status: number
}

/**
 * One source-scoped fetch session: a persistent Playwright context (local
 * or remote region-pinned), always created with timezoneId 'UTC' and a
 * pinned locale (spec §5.9), plus an APIRequestContext for JSON-endpoint
 * replay that egresses through the same IP as the page session (spec §2.2).
 */
export interface FetchSession {
  readonly sourceSlug: string

  /** Lazily open (or return) the session's page. */
  page(): Promise<import('playwright').Page>

  /** APIRequestContext bound to the browser context (same cookies + IP). */
  api(): Promise<import('playwright').APIRequestContext>

  /** Start capturing XHR/fetch exchanges whose URL matches. */
  capture(matcher: RegExp | ((url: string) => boolean)): Promise<EndpointCapture>

  /** Run fn under the source's rate budget (gap + jitter), with exponential
   *  backoff on 403/429 and circuit-breaker accounting (spec §4). */
  paced<T>(fn: () => Promise<T>): Promise<T>

  /** Persist the context's storageState to arena.source_secrets. */
  saveState(): Promise<void>

  /** Close browser context + API context. */
  close(): Promise<void>
}
