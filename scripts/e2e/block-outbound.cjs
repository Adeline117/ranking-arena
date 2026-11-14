'use strict'
/**
 * Preloaded into `next start` by playwright.hermetic.config.ts (NODE_OPTIONS=--require).
 * The browser side is already confined to localhost by e2e/hermetic/fixtures.ts;
 * this closes the server side: any server-side fetch / http(s).request to a
 * non-loopback host fails immediately instead of reaching a real service
 * (CoinGecko, exchanges, Stripe, ...). Routes must then take their degraded path,
 * which is exactly what the hermetic suite asserts.
 *
 * Each blocked host is appended once to HERMETIC_BLOCKED_LOG (if set) so the run
 * leaves an inventory of what would have leaked.
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])
const logPath = process.env.HERMETIC_BLOCKED_LOG
const seen = new Set()

function record(host) {
  if (seen.has(host)) return
  seen.add(host)
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `${host}\n`)
    } catch {
      // Logging is best-effort; blocking is not.
    }
  }
}

function hostOf(input) {
  try {
    if (typeof input === 'string') return new URL(input).hostname
    if (input instanceof URL) return input.hostname
    if (input && typeof input.url === 'string') return new URL(input.url).hostname
    if (input && typeof input === 'object') return input.hostname || input.host || 'localhost'
  } catch {
    return null
  }
  return null
}

function isAllowed(host) {
  if (!host) return true // relative URL / unparseable → not an outbound host
  return LOOPBACK.has(host.replace(/:\d+$/, ''))
}

function blockedError(host) {
  const err = new Error(`hermetic E2E: outbound request to ${host} blocked`)
  err.code = 'ECONNREFUSED'
  return err
}

const realFetch = globalThis.fetch
if (typeof realFetch === 'function') {
  globalThis.fetch = function hermeticFetch(input, init) {
    const host = hostOf(input)
    if (!isAllowed(host)) {
      record(host)
      return Promise.reject(new TypeError('fetch failed', { cause: blockedError(host) }))
    }
    return realFetch.call(this, input, init)
  }
}

for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    const real = mod[name]
    mod[name] = function hermeticRequest(...args) {
      const host = hostOf(args[0])
      if (!isAllowed(host)) {
        record(host)
        // Return a genuine ClientRequest aimed at a closed loopback port so the
        // caller gets the normal asynchronous 'error' (ECONNREFUSED) it already
        // handles, rather than a synchronous throw it may not expect.
        const req = http.request({ host: '127.0.0.1', port: 9, method: 'GET' })
        if (name === 'get') req.end()
        return req
      }
      return real.apply(this, args)
    }
  }
}
