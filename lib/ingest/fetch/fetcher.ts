/**
 * FetchSession implementation (spec §2.1 fetcher pool, §4 anti-bot, §5.9 UTC).
 *
 * WORKER-ONLY MODULE — imports Playwright. app/** must never import this.
 *
 * Region routing (sources.fetch_region):
 *   local  → chromium.launchPersistentContext on this machine (Mac Mini);
 *            warm cookies persist on disk under .arena-ingest/profiles/.
 *   vps_sg / vps_jp → chromium.connect() to a remote `playwright run-server`
 *            (PLAYWRIGHT_WS_SG / PLAYWRIGHT_WS_JP). The VPS is a dumb
 *            region-pinned browser: all adapter code runs here, and JSON
 *            replay uses the browser-context APIRequestContext so replay
 *            egress IP == session IP automatically.
 *   EXCEPTION: a worker node deployed inside a region sets
 *            INGEST_LOCAL_REGION (e.g. 'vps_sg') and then treats sources
 *            of that region exactly like 'local' — browsers launch on the
 *            node itself, no remote WS involved.
 *
 * Every context is created with timezoneId 'UTC' + locale 'en-US' — a
 * worker machine's local timezone must never shift parsed daily series
 * (spec §5.9 hard rule).
 */

import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import type { APIRequestContext, Browser, BrowserContext, Page, Request } from 'playwright'
import type { SourceRow } from '../core/types'
import type {
  CapturedExchange,
  EndpointCapture,
  FetchSession,
  ReplayRequestTemplate,
} from './types'
import { BlockedUpstreamError, PacedGate } from './rate-limiter'
import { Circuit, type CircuitState } from './circuit'
import { getIngestPool } from '../db'
import {
  acquireProfileLane,
  validateProfileLaneConfig,
  type ProfileLaneConfig,
  type ProfileLaneLease,
} from './profile-lanes'

const CONTEXT_OPTIONS = {
  timezoneId: 'UTC',
  locale: 'en-US',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
} as const

const DEFAULT_PAGE_FETCH_TIMEOUT_MS = 60_000
const MIN_PAGE_FETCH_TIMEOUT_MS = 5_000
const MAX_PAGE_FETCH_TIMEOUT_MS = 300_000

function pageFetchTimeoutMs(src: SourceRow): number {
  const configured = src.meta?.page_fetch_timeout_ms
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_PAGE_FETCH_TIMEOUT_MS
  }
  return Math.min(
    MAX_PAGE_FETCH_TIMEOUT_MS,
    Math.max(MIN_PAGE_FETCH_TIMEOUT_MS, Math.floor(configured))
  )
}

/**
 * Remove stale Chromium singleton locks when no live process is using the
 * profile dir. Chrome's lock is a symlink (SingletonLock → "host-pid");
 * if that pid is dead, the lock is garbage from a killed run.
 */
function clearStaleSingletonLocks(userDataDir: string): void {
  const lockPath = path.join(userDataDir, 'SingletonLock')
  let target: string
  try {
    target = fs.readlinkSync(lockPath)
  } catch {
    return // no lock — nothing to do
  }
  const pid = Number(target.split('-').pop())
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0) // probe only
      return // pid alive — the profile is genuinely in use, do not touch
    } catch {
      // dead pid → stale lock
    }
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(userDataDir, name), { force: true })
    } catch {
      // best effort — launch will surface any real problem
    }
  }
  console.warn(`[ingest] cleared stale Chromium singleton locks in ${userDataDir}`)
}

/** Circuits are per-source and shared across sessions/restarts of this process. */
const circuits = new Map<string, Circuit>()

export function getCircuit(sourceSlug: string): Circuit {
  let c = circuits.get(sourceSlug)
  if (!c) {
    c = new Circuit(sourceSlug)
    circuits.set(sourceSlug, c)
  }
  return c
}

export function getCircuitState(sourceSlug: string): CircuitState {
  return getCircuit(sourceSlug).getState()
}

/**
 * The region THIS machine serves with locally-launched browsers.
 * Default 'local' (Mac Mini). A worker node deployed inside a region —
 * e.g. the SG VPS running with INGEST_LOCAL_REGION=vps_sg — treats
 * sources pinned to that region as local: it launchPersistentContext's
 * on its own disk instead of dialing a remote run-server, eliminating
 * the SSH-tunnel → remote-WS failure chain for that region entirely.
 */
function isLocalRegion(region: string): boolean {
  return region === (process.env.INGEST_LOCAL_REGION ?? 'local')
}

function remoteWsEndpoint(region: 'vps_sg' | 'vps_jp'): string {
  const env = region === 'vps_sg' ? 'PLAYWRIGHT_WS_SG' : 'PLAYWRIGHT_WS_JP'
  const ws = process.env[env]
  if (!ws) {
    throw new Error(
      `[ingest] ${env} not set — required for fetch_region=${region}. ` +
        `Run \`npx playwright run-server --port 3458\` on the VPS (firewalled!).`
    )
  }
  return ws
}

/** Headers that must not be replayed verbatim. */
const SKIP_REPLAY_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'cookie',
])

function toTemplate(req: Request): ReplayRequestTemplate {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers())) {
    if (!SKIP_REPLAY_HEADERS.has(k.toLowerCase()) && !k.startsWith(':')) {
      headers[k] = v
    }
  }
  let body: unknown
  const postData = req.postData()
  if (postData) {
    try {
      body = JSON.parse(postData)
    } catch {
      body = postData
    }
  }
  return {
    url: req.url(),
    method: req.method() === 'POST' ? 'POST' : 'GET',
    headers,
    body,
  }
}

class PlaywrightFetchSession implements FetchSession {
  private context: BrowserContext | null = null
  private contextCreation: Promise<BrowserContext> | null = null
  private resetPromise: Promise<void> | null = null
  private savePromise: Promise<void> | null = null
  private pageInstance: Page | null = null
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closePromise: Promise<void> | null = null
  private terminalError: Error | null = null
  /** Last main-frame http(s) URL — restored after a mid-session context reset. */
  private lastNavigatedUrl: string | null = null
  private readonly gate: PacedGate
  private readonly circuit: Circuit

  constructor(
    readonly sourceSlug: string,
    private readonly src: SourceRow,
    private readonly profileDirectory?: string,
    private profileLaneLease?: ProfileLaneLease
  ) {
    this.gate = new PacedGate({ budgetMs: src.rate_budget_ms })
    this.circuit = getCircuit(src.slug)
  }

  private isLocalProfile(): boolean {
    return this.src.fetch_region === 'local' || isLocalRegion(this.src.fetch_region)
  }

  private assertOpen(): void {
    if (this.state !== 'open') {
      throw new Error(`[ingest] ${this.sourceSlug} fetch session is ${this.state}`)
    }
    if (this.terminalError) throw this.terminalError
  }

  private async createContext(): Promise<BrowserContext> {
    const region = this.src.fetch_region
    // Local when fetch_region is literally 'local' OR matches this node's
    // INGEST_LOCAL_REGION (a region-resident worker runs browsers itself).
    // Keep the literal 'local' check first so TS narrows the else branch
    // for remoteWsEndpoint().
    if (region === 'local' || isLocalRegion(region)) {
      if (!this.profileDirectory) {
        throw new Error(`[ingest] ${this.sourceSlug}: local profile lane has no owned directory`)
      }
      const userDataDir = this.profileDirectory
      // Some Akamai-fronted sources (Bybit: net::ERR_HTTP2_PROTOCOL_ERROR)
      // TLS-fingerprint-block the bundled Chromium even on page loads, but
      // accept an installed branded browser headless. Per-source opt-in via
      // sources.meta.browser_channel (e.g. 'chrome').
      const channel =
        typeof this.src.meta.browser_channel === 'string'
          ? this.src.meta.browser_channel
          : undefined
      // A killed Chromium (pm2 restart, timed-out shell) leaves
      // SingletonLock behind → "Failed to create a ProcessSingleton" on the
      // next launch. If no live process holds this profile, clear the
      // stale locks instead of failing the job (recurred 3× in one day).
      clearStaleSingletonLocks(userDataDir)
      return chromium.launchPersistentContext(userDataDir, {
        ...CONTEXT_OPTIONS,
        headless: true,
        channel,
      })
    }

    const browser = await chromium.connect(remoteWsEndpoint(region))
    try {
      const storageState = await this.loadState()
      return await browser.newContext({
        ...CONTEXT_OPTIONS,
        storageState: storageState ?? undefined,
      })
    } catch (error) {
      await browser.close().catch(() => undefined)
      throw error
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    this.assertOpen()
    const reset = this.resetPromise
    if (reset) {
      await reset
      this.assertOpen()
    }
    if (this.context) return this.context

    if (!this.contextCreation) {
      const creation = this.createContext()
        .then((context) => {
          // Assign before resolving: close() waiting on this promise must see and
          // close a context that finished launching after close began.
          this.profileLaneLease?.markLaunchSucceeded()
          this.context = context
          return context
        })
        .catch((error: unknown) => {
          if (this.isLocalProfile() && this.profileLaneLease) {
            const launchError = error instanceof Error ? error : new Error(String(error))
            this.terminalError = launchError
            if (PlaywrightFetchSession.isProcessSingletonFailure(launchError)) {
              this.settleProfileLane('quarantine')
            } else {
              this.settleProfileLane('launch_failure')
            }
          }
          throw error
        })
      const tracked = creation.finally(() => {
        if (this.contextCreation === tracked) this.contextCreation = null
      })
      this.contextCreation = tracked
    }

    const context = await this.contextCreation
    this.assertOpen()
    return context
  }

  async page(): Promise<Page> {
    this.assertOpen()
    const reset = this.resetPromise
    if (reset) {
      await reset
      this.assertOpen()
    }
    if (this.pageInstance && !this.pageInstance.isClosed()) return this.pageInstance
    const ctx = await this.ensureContext()
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    if (this.state !== 'open') {
      await page.close().catch(() => undefined)
      this.assertOpen()
    }
    this.pageInstance = page
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && /^https?:/.test(frame.url())) {
        this.lastNavigatedUrl = frame.url()
      }
    })
    // A mid-session resetContext() leaves the fresh page on about:blank
    // while adapters' warm-once guards (warmedSessions WeakSet) still
    // believe the origin is parked — every subsequent same-origin
    // pageFetch then throws "TypeError: Failed to fetch" for the rest of
    // the job (binance Tier-B 0/486, 2026-06-11). Restore the last
    // navigated URL so in-page fetches keep their origin.
    if (this.lastNavigatedUrl && page.url() === 'about:blank') {
      await page
        .goto(this.lastNavigatedUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch(() => undefined) // best-effort — adapter retries surface a dead origin
    }
    this.assertOpen()
    return page
  }

  async api(): Promise<APIRequestContext> {
    this.assertOpen()
    const ctx = await this.ensureContext()
    this.assertOpen()
    return ctx.request
  }

  async capture(matcher: RegExp | ((url: string) => boolean)): Promise<EndpointCapture> {
    this.assertOpen()
    const page = await this.page()
    this.assertOpen()
    const matches = (url: string) => (matcher instanceof RegExp ? matcher.test(url) : matcher(url))

    const captured: CapturedExchange[] = []
    const waiters: Array<(ex: CapturedExchange) => void> = []

    const onResponse = async (response: import('playwright').Response) => {
      try {
        const req = response.request()
        const type = req.resourceType()
        if (type !== 'xhr' && type !== 'fetch') return
        if (!matches(response.url())) return
        let responseJson: unknown
        try {
          responseJson = await response.json()
        } catch {
          return // non-JSON response — not a replayable endpoint
        }
        const exchange: CapturedExchange = {
          template: toTemplate(req),
          responseJson,
          status: response.status(),
        }
        captured.push(exchange)
        while (waiters.length > 0) waiters.shift()!(exchange)
      } catch {
        // page navigated away mid-read — ignore
      }
    }

    page.on('response', onResponse)

    return {
      first: (timeoutMs = 30_000) => {
        if (captured.length > 0) return Promise.resolve(captured[0])
        return new Promise<CapturedExchange>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`[ingest] capture timeout (${this.sourceSlug})`)),
            timeoutMs
          )
          waiters.push((ex) => {
            clearTimeout(timer)
            resolve(ex)
          })
        })
      },
      all: () => [...captured],
      dispose: () => {
        page.off('response', onResponse)
      },
    }
  }

  /** Connection-loss signatures from a dead remote browser / SSH-tunnel blip. */
  private static isConnectionLoss(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /Browser closed|Target closed|browser has been closed|disconnected|WebSocket/i.test(msg)
  }

  private static isProcessSingletonFailure(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /ProcessSingleton|SingletonLock|profile (?:appears to be|is) in use|user data directory is already in use/i.test(
      msg
    )
  }

  /** Tear down the dead context so ensureContext() reconnects fresh. */
  private resetContext(): Promise<void> {
    this.assertOpen()
    if (this.resetPromise) return this.resetPromise

    const reset = this.resetContextInternal()
    const tracked = reset.finally(() => {
      if (this.resetPromise === tracked) this.resetPromise = null
    })
    this.resetPromise = tracked
    return tracked
  }

  private async resetContextInternal(): Promise<void> {
    const save = this.savePromise
    if (save) {
      await save
      this.assertOpen()
    }

    try {
      await this.closeCurrentContextAndConfirm()
    } catch (error) {
      const resetError =
        error instanceof Error
          ? error
          : new Error(`[ingest] ${this.sourceSlug}: context reset failed: ${String(error)}`)
      this.terminalError = resetError
      this.settleProfileLane('quarantine')
      throw resetError
    }
  }

  async pageFetch(template: ReplayRequestTemplate): Promise<{ status: number; json: unknown }> {
    this.assertOpen()
    // A 480-page crawl rides one WS connection for ~20 min; without
    // in-place recovery a single tunnel blip aborts the whole timeframe
    // and the retry re-fetches everything from page 1. One reconnect
    // attempt turns a crawl-fatal disconnect into a single-page hiccup.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pageFetchOnce(template)
      } catch (err) {
        if (attempt >= 1 || !PlaywrightFetchSession.isConnectionLoss(err)) throw err
        this.assertOpen()
        console.warn(
          `[ingest] ${this.sourceSlug}: browser connection lost mid-fetch — reconnecting…`
        )
        await this.resetContext()
        // Remote contexts restore cookies via source_secrets on reconnect;
        // local persistent profiles carry their own state on disk.
      }
    }
  }

  private async pageFetchOnce(
    template: ReplayRequestTemplate
  ): Promise<{ status: number; json: unknown }> {
    const page = await this.page()
    return page.evaluate(
      async ({ request, timeoutMs, sourceSlug }) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const resp = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: controller.signal,
          })
          let json: unknown = null
          try {
            json = await resp.json()
          } catch {
            if (controller.signal.aborted) {
              throw new Error(`[ingest] page fetch timeout (${sourceSlug}, ${timeoutMs}ms)`)
            }
            // non-JSON body — caller decides
          }
          return { status: resp.status, json }
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(`[ingest] page fetch timeout (${sourceSlug}, ${timeoutMs}ms)`)
          }
          throw error
        } finally {
          clearTimeout(timer)
        }
      },
      {
        request: {
          url: template.url,
          method: template.method,
          headers: template.headers,
          body: template.body,
        },
        timeoutMs: pageFetchTimeoutMs(this.src),
        sourceSlug: this.sourceSlug,
      }
    )
  }

  async paced<T>(fn: () => Promise<T>): Promise<T> {
    this.assertOpen()
    this.circuit.assertCanProceed()
    try {
      const result = await this.gate.run(async () => {
        // PacedGate may sleep for the source budget before invoking the
        // callback. Closing during that wait must prevent the callback itself,
        // not merely make a later Playwright operation fail.
        const reset = this.resetPromise
        if (reset) await reset
        this.assertOpen()
        return fn()
      })
      this.circuit.recordSuccess()
      return result
    } catch (err) {
      // A lifecycle rejection is not an upstream failure and must not pollute
      // source circuit/failure-rate accounting.
      if (this.state !== 'open' || err === this.terminalError) throw err
      this.circuit.recordFailure(err instanceof BlockedUpstreamError)
      throw err
    }
  }

  saveState(): Promise<void> {
    this.assertOpen()
    if (this.savePromise) return this.savePromise

    const reset = this.resetPromise
    const save = (async () => {
      if (reset) {
        await reset
        this.assertOpen()
      }
      await this.saveCurrentState()
    })()
    const tracked = save.finally(() => {
      if (this.savePromise === tracked) this.savePromise = null
    })
    this.savePromise = tracked
    return tracked
  }

  private async saveCurrentState(): Promise<void> {
    if (!this.context) return
    const state = await this.context.storageState()
    await getIngestPool().query(
      `INSERT INTO arena.source_secrets (source_id, storage_state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (source_id)
       DO UPDATE SET storage_state = EXCLUDED.storage_state, updated_at = now()`,
      [this.src.id, JSON.stringify(state)]
    )
  }

  private async loadState(): Promise<Awaited<ReturnType<BrowserContext['storageState']>> | null> {
    const { rows } = await getIngestPool().query<{ storage_state: unknown }>(
      `SELECT storage_state FROM arena.source_secrets WHERE source_id = $1`,
      [this.src.id]
    )
    const state = rows[0]?.storage_state
    return state ? (state as Awaited<ReturnType<BrowserContext['storageState']>>) : null
  }

  private async closeCurrentContextAndConfirm(): Promise<void> {
    const context = this.context
    if (!context) return

    const page = this.pageInstance
    try {
      if (page && !page.isClosed()) await page.close()
    } catch (err) {
      console.warn(`[ingest] ${this.sourceSlug}: page close failed:`, err)
    }

    const local = this.isLocalProfile()
    let browser: Browser | null = null
    try {
      browser = context.browser()
    } catch {
      // A broken context can fail even while asking for its browser handle.
    }

    try {
      await context.close()
    } catch (contextError) {
      if (!browser) {
        throw new Error(
          `[ingest] ${this.sourceSlug}: context close failed and no browser fallback exists; ` +
            `persistent-profile slot quarantined`,
          { cause: contextError }
        )
      }

      try {
        await browser.close()
      } catch (browserError) {
        throw new AggregateError(
          [contextError, browserError],
          `[ingest] ${this.sourceSlug}: context and browser close both failed; ` +
            `persistent-profile slot quarantined`
        )
      }
      console.warn(
        `[ingest] ${this.sourceSlug}: context close failed; browser fallback confirmed closure`
      )
      browser = null
    }

    // A remote newContext owns a connected Browser handle. Closing the
    // context is not enough to tear down that WS connection.
    if (!local && browser) {
      await browser.close()
    }

    if (this.context === context) this.context = null
    if (this.pageInstance === page) this.pageInstance = null
  }

  private settleProfileLane(disposition: 'release' | 'launch_failure' | 'quarantine'): void {
    const lease = this.profileLaneLease
    this.profileLaneLease = undefined
    if (!lease) return
    if (disposition === 'release') lease.release()
    else if (disposition === 'launch_failure') lease.releaseAfterLaunchFailure()
    else lease.quarantine()
  }

  private async closeInternal(): Promise<void> {
    let closureConfirmed = false
    try {
      // A close racing launch/connect must not release the ProcessSingleton
      // lane first. The creation promise assigns this.context before settling.
      const creation = this.contextCreation
      if (creation) await creation.catch(() => undefined)

      // A reset owns context teardown while it is in flight. Wait for its
      // positive closure proof (or failure), then retry any still-owned context
      // below before deciding whether the lane can be released.
      const reset = this.resetPromise
      if (reset) await reset.catch(() => undefined)

      const save = this.savePromise
      if (save) {
        await save.catch((err) => {
          console.error(`[ingest] saveState failed for ${this.sourceSlug}:`, err)
        })
      }

      try {
        await this.saveCurrentState()
      } catch (err) {
        console.error(`[ingest] saveState failed for ${this.sourceSlug}:`, err)
      }

      await this.closeCurrentContextAndConfirm()
      closureConfirmed = true
    } finally {
      // Never make a local profile available until closure is positively
      // confirmed. A quarantined slot stays withheld until process restart.
      this.settleProfileLane(closureConfirmed ? 'release' : 'quarantine')
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.state = 'closing'
    this.closePromise = this.closeInternal().finally(() => {
      this.state = 'closed'
    })
    return this.closePromise
  }
}

export interface OpenSessionOptions {
  /** Logical mutex lane, independent from its physical directory suffix. */
  profileLaneKey?: string
  /**
   * Suffix for the local persistent-profile dir (`profiles/<slug>-<suffix>`).
   * Omit it for Tier A, which intentionally retains `profiles/<slug>`.
   */
  profileSuffix?: string
  /**
   * Fixed number of persistent-profile slots in this logical lane.
   * Callers beyond the bound wait in-process; they never mint more dirs.
   */
  profileSlotCount?: number
}

export async function openSession(
  src: SourceRow,
  opts?: OpenSessionOptions
): Promise<FetchSession> {
  if (opts?.profileSuffix !== undefined && opts.profileLaneKey === undefined) {
    throw new Error('[ingest] profileSuffix requires an explicit, independent profileLaneKey')
  }

  const config: ProfileLaneConfig = {
    laneKey: opts?.profileLaneKey ?? 'tier-a',
    profileSuffix: opts?.profileSuffix,
    slotCount: opts?.profileSlotCount,
  }
  validateProfileLaneConfig(config)

  let lease: ProfileLaneLease | undefined
  if (src.fetch_region === 'local' || isLocalRegion(src.fetch_region)) {
    lease = await acquireProfileLane(src.slug, config)
  }

  return new PlaywrightFetchSession(src.slug, src, lease?.profileDirectory, lease)
}
