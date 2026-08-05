import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const diagnoseScript = fileURLToPath(new URL('../diagnose.mjs', import.meta.url))
const now = new Date().toISOString()

const healthyResponses = {
  '/api/health': {
    status: 'healthy',
    commit: 'diagnose-test',
    responseTimeMs: 3,
    checks: {
      api: { status: 'pass' },
      database: { status: 'pass' },
      redis: { status: 'pass' },
      freshness: { status: 'pass', message: 'up to date' },
    },
  },
  '/api/platforms': {
    platforms: [{ key: 'alpha' }],
  },
  '/api/sources/visible': {
    success: true,
    data: {
      sources: [
        {
          cacheUpdatedAt: now,
          exchangeSlug: 'alpha',
          filterSource: 'alpha-futures',
          traderCount: 12,
        },
      ],
    },
  },
  '/api/rankings': {
    success: true,
    data: {
      as_of: now,
      availableSources: ['alpha-futures'],
      is_stale: false,
      totalCount: 12,
    },
  },
  '/api/hero-stats': {
    exchangeCount: 1,
    traderCount: 12,
  },
}

function runCli(baseUrl, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [diagnoseScript, ...args], {
      env: { ARENA_URL: baseUrl },
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
    child.once('close', (code, signal) => {
      resolve({ code, signal, stderr, stdout })
    })
  })
}

async function withApiServer(overrides, run) {
  const requests = []
  const responses = { ...healthyResponses, ...overrides }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    requests.push(path)
    const configured = responses[path]

    if (!configured) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }

    const status = configured.httpStatus ?? 200
    const body = Object.hasOwn(configured, 'body') ? configured.body : configured
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')

  try {
    return await run(`http://127.0.0.1:${address.port}`, requests)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('diagnose CLI succeeds for default, --all, and individual sections', async (t) => {
  const cases = [
    [
      'default',
      [],
      ['/api/health', '/api/hero-stats', '/api/platforms', '/api/rankings', '/api/sources/visible'],
    ],
    [
      'all',
      ['--all'],
      ['/api/health', '/api/hero-stats', '/api/platforms', '/api/rankings', '/api/sources/visible'],
    ],
    ['status', ['--status'], ['/api/health', '/api/hero-stats', '/api/rankings']],
    ['freshness', ['--freshness'], ['/api/health', '/api/rankings', '/api/sources/visible']],
    ['platforms', ['--platforms'], ['/api/platforms', '/api/rankings', '/api/sources/visible']],
  ]

  for (const [name, args, expectedRequests] of cases) {
    await t.test(name, async () => {
      await withApiServer({}, async (baseUrl, requests) => {
        const result = await runCli(baseUrl, args)
        assert.equal(result.code, 0, result.stderr || result.stdout)
        assert.equal(result.signal, null)
        assert.match(result.stdout, /Result: PASS/)
        assert.equal(result.stderr, '')
        assert.deepEqual([...requests].sort(), expectedRequests)
      })
    })
  }
})

test('diagnose CLI exits 1 for unhealthy serving status', async () => {
  await withApiServer(
    {
      '/api/health': {
        ...healthyResponses['/api/health'],
        status: 'unhealthy',
        checks: {
          ...healthyResponses['/api/health'].checks,
          database: { status: 'fail', message: 'offline test failure' },
        },
      },
    },
    async (baseUrl) => {
      const result = await runCli(baseUrl, ['--status'])
      assert.equal(result.code, 1, result.stderr || result.stdout)
      assert.match(result.stdout, /Result: FAIL/)
    }
  )
})

test('diagnose CLI exits 1 for stale rankings', async () => {
  await withApiServer(
    {
      '/api/rankings': {
        ...healthyResponses['/api/rankings'],
        data: { ...healthyResponses['/api/rankings'].data, is_stale: true },
      },
    },
    async (baseUrl) => {
      const result = await runCli(baseUrl, ['--freshness'])
      assert.equal(result.code, 1, result.stderr || result.stdout)
      assert.match(result.stdout, /API stale flag:STALE/)
      assert.match(result.stdout, /Result: FAIL/)
    }
  )
})

test('diagnose CLI exits 1 when a serving API reports success=false', async () => {
  await withApiServer({ '/api/rankings': { success: false } }, async (baseUrl) => {
    const result = await runCli(baseUrl, ['--platforms'])
    assert.equal(result.code, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /Result: ERROR.*success=false/)
  })
})

test('diagnose CLI exits 1 for an HTTP error', async () => {
  await withApiServer(
    { '/api/rankings': { httpStatus: 503, body: { error: 'offline test failure' } } },
    async (baseUrl) => {
      const result = await runCli(baseUrl, ['--status'])
      assert.equal(result.code, 1, result.stderr || result.stdout)
      assert.match(result.stderr, /Result: ERROR.*\/api\/rankings.*returned HTTP 503/)
    }
  )
})

test('diagnose CLI rejects unsupported options before making requests', async () => {
  await withApiServer({}, async (baseUrl, requests) => {
    const result = await runCli(baseUrl, ['--unknown'])
    assert.equal(result.code, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /unsupported diagnostic option/)
    assert.deepEqual(requests, [])
  })
})
