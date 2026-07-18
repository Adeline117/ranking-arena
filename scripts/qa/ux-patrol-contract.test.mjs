import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const patrolScript = path.join(root, 'scripts/openclaw/ux-patrol.mjs')
const expectedUserAgent = 'Arena-UX-Patrol/1.0 (+https://www.arenafi.org)'
const pagePaths = new Set(['/', '/rankings', '/rankings/7d', '/market', '/learn', '/login'])

function sendJson(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

function serveHealthy(req, res, { pageWarnings = false, emptyRankings = false } = {}) {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/api/rankings') {
    sendJson(res, {
      data: {
        traders: emptyRankings
          ? []
          : [
              {
                display_name: 'Verified trader',
                platform: 'binance_futures',
                roi: 12.5,
                pnl: 1000,
                arena_score: 85,
              },
            ],
      },
    })
    return
  }
  if (url.pathname === '/api/market') {
    sendJson(res, { rows: [{ symbol: 'BTC' }] })
    return
  }
  if (url.pathname === '/api/market/spot') {
    sendJson(res, [{ symbol: 'BTC' }])
    return
  }
  if (pagePaths.has(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      pageWarnings
        ? '<!doctype html><html><body>Available</body></html>'
        : '<!doctype html><html><body><div id="__next" class="ssr-r">Available</div></body></html>'
    )
    return
  }

  res.writeHead(404)
  res.end('not found')
}

async function runPatrol(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, userAgent: req.headers['user-agent'] })
    handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [patrolScript], {
        cwd: root,
        env: {
          ...process.env,
          ARENA_URL: `http://127.0.0.1:${address.port}`,
          DOTENV_CONFIG_QUIET: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
    })
    return { ...result, requests }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('probes /learn with one bounded retry and a stable explicit user agent', async () => {
  let learnAttempts = 0
  const result = await runPatrol((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/learn') {
      learnAttempts++
      res.writeHead(503)
      res.end('temporarily unavailable')
      return
    }
    serveHealthy(req, res)
  })

  assert.equal(result.status, 1)
  assert.equal(result.signal, null)
  assert.equal(learnAttempts, 2)
  assert.ok(result.requests.every(({ userAgent }) => userAgent === expectedUserAgent))
  assert.ok(result.requests.some(({ url }) => url === '/learn'))
  assert.ok(result.requests.every(({ url }) => url !== '/library'))
  assert.match(result.stdout, /❌ GET \/learn — Status 503/)
  assert.doesNotMatch(result.stdout, /Sentinel blind\/access failure/)
})

test('reports dependency access blindness once without inventing a rankings-data failure', async () => {
  const result = await runPatrol((_req, res) => {
    res.writeHead(403)
    res.end('forbidden')
  })

  assert.equal(result.status, 2)
  assert.equal(result.stdout.match(/Sentinel blind\/access failure/g)?.length, 1, result.stdout)
  assert.doesNotMatch(result.stdout, /No rankings data/)
  assert.match(result.stdout, /0 failed, 1 blind/)
})

test('keeps warning-only patrols successful', async () => {
  const result = await runPatrol((req, res) => serveHealthy(req, res, { pageWarnings: true }))

  assert.equal(result.status, 0)
  assert.match(result.stdout, /\d+ warned, 0 failed, 0 blind/)
  assert.doesNotMatch(result.stdout, /❌ Failed checks:/)
})

test('returns a hard failure for invalid production data without a duplicate cascade', async () => {
  const result = await runPatrol((req, res) => serveHealthy(req, res, { emptyRankings: true }))

  assert.equal(result.status, 1)
  assert.match(
    result.stdout,
    /API \/api\/rankings\?window=7d&limit=10 — Response shape invalid or empty/
  )
  assert.doesNotMatch(result.stdout, /No rankings data/)
  assert.match(result.stdout, /1 failed, 0 blind/)
})
