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
import type { APIRequestContext, BrowserContext, Page, Request } from 'playwright'
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

const CONTEXT_OPTIONS = {
  timezoneId: 'UTC',
  locale: 'en-US',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
} as const

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
  private pageInstance: Page | null = null
  /** Last main-frame http(s) URL — restored after a mid-session context reset. */
  private lastNavigatedUrl: string | null = null
  private readonly gate: PacedGate
  private readonly circuit: Circuit

  constructor(
    readonly sourceSlug: string,
    private readonly src: SourceRow
  ) {
    this.gate = new PacedGate({ budgetMs: src.rate_budget_ms })
    this.circuit = getCircuit(src.slug)
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context

    // Local when fetch_region is literally 'local' OR matches this node's
    // INGEST_LOCAL_REGION (a region-resident worker runs browsers itself).
    // Keep the literal 'local' check first so TS narrows the else branch
    // for remoteWsEndpoint().
    if (this.src.fetch_region === 'local' || isLocalRegion(this.src.fetch_region)) {
      const userDataDir = path.join(process.cwd(), '.arena-ingest', 'profiles', this.src.slug)
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
      this.context = await chromium.launchPersistentContext(userDataDir, {
        ...CONTEXT_OPTIONS,
        headless: true,
        channel,
      })
    } else {
      const browser = await chromium.connect(remoteWsEndpoint(this.src.fetch_region))
      const storageState = await this.loadState()
      this.context = await browser.newContext({
        ...CONTEXT_OPTIONS,
        storageState: storageState ?? undefined,
      })
    }
    return this.context
  }

  async page(): Promise<Page> {
    if (this.pageInstance && !this.pageInstance.isClosed()) return this.pageInstance
    const ctx = await this.ensureContext()
    const page = ctx.pages()[0] ?? (await ctx.newPage())
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
    return page
  }

  async api(): Promise<APIRequestContext> {
    const ctx = await this.ensureContext()
    return ctx.request
  }

  async capture(matcher: RegExp | ((url: string) => boolean)): Promise<EndpointCapture> {
    const page = await this.page()
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

  /** Tear down the dead context so ensureContext() reconnects fresh. */
  private async resetContext(): Promise<void> {
    try {
      this.context
        ?.browser()
        ?.close()
        .catch(() => undefined)
    } catch {
      // already gone
    }
    this.context = null
    this.pageInstance = null
  }

  async pageFetch(template: ReplayRequestTemplate): Promise<{ status: number; json: unknown }> {
    // A 480-page crawl rides one WS connection for ~20 min; without
    // in-place recovery a single tunnel blip aborts the whole timeframe
    // and the retry re-fetches everything from page 1. One reconnect
    // attempt turns a crawl-fatal disconnect into a single-page hiccup.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pageFetchOnce(template)
      } catch (err) {
        if (attempt >= 1 || !PlaywrightFetchSession.isConnectionLoss(err)) throw err
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
      async (t) => {
        const resp = await fetch(t.url, {
          method: t.method,
          headers: t.headers,
          body: t.body === undefined ? undefined : JSON.stringify(t.body),
        })
        let json: unknown = null
        try {
          json = await resp.json()
        } catch {
          // non-JSON body — caller decides
        }
        return { status: resp.status, json }
      },
      {
        url: template.url,
        method: template.method,
        headers: template.headers,
        body: template.body,
      }
    )
  }

  async paced<T>(fn: () => Promise<T>): Promise<T> {
    this.circuit.assertCanProceed()
    try {
      const result = await this.gate.run(fn)
      this.circuit.recordSuccess()
      return result
    } catch (err) {
      this.circuit.recordFailure(err instanceof BlockedUpstreamError)
      throw err
    }
  }

  async saveState(): Promise<void> {
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

  async close(): Promise<void> {
    try {
      await this.saveState()
    } catch (err) {
      console.error(`[ingest] saveState failed for ${this.sourceSlug}:`, err)
    }
    const logCloseError = (what: string) => (err: unknown) =>
      console.warn(`[ingest] ${this.sourceSlug}: ${what} close failed:`, err)
    if (this.pageInstance && !this.pageInstance.isClosed()) {
      await this.pageInstance.close().catch(logCloseError('page'))
    }
    if (this.context) {
      const browser = this.context.browser()
      await this.context.close().catch(logCloseError('context'))
      // Remote connections own a browser handle; persistent contexts
      // (literal 'local' or this node's INGEST_LOCAL_REGION) do not.
      if (browser && this.src.fetch_region !== 'local' && !isLocalRegion(this.src.fetch_region)) {
        await browser.close().catch(logCloseError('browser'))
      }
      this.context = null
      this.pageInstance = null
    }
  }
}

export async function openSession(src: SourceRow): Promise<FetchSession> {
  return new PlaywrightFetchSession(src.slug, src)
}
